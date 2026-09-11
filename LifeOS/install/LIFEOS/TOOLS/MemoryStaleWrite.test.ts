/**
 * Stale-base write guard for the hot-layer memory files.
 *
 * The memory reviewer reads both files, spends ~2 minutes on inference, then
 * REPLACES the file with its full list. Anything written in between was lost:
 * a manual consolidation landed seconds before a review whose snapshot was
 * minutes old, and the review undid it. The fix: the reviewer passes the
 * fingerprint of the entries it read, and setEntries refuses (ESTALE_BASE)
 * when the file's entries no longer match.
 *
 * MemoryWriter resolves the memory paths from homedir() at import time, and Bun
 * reads HOME only at startup, so every scenario runs in its own `bun` process
 * under a temp HOME. No live memory file is touched.
 *
 * Run: bun test LIFEOS/TOOLS/MemoryStaleWrite.test.ts
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOOLS = import.meta.dir;
const REL = "LIFEOS/USER/PRINCIPAL/PRINCIPAL_MEMORY.md";

function fixture(): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "memory-stale-write-"));
  const claude = join(home, ".claude");
  // Mirror the real layout: LIFEOS/USER is a symlink into ~/.config/LIFEOS/USER,
  // which MemorySystem's system/user boundary check requires.
  const userData = join(home, ".config/LIFEOS/USER");
  for (const d of ["PRINCIPAL", "DIGITAL_ASSISTANT"]) mkdirSync(join(userData, d), { recursive: true });
  mkdirSync(join(claude, "LIFEOS/MEMORY/OBSERVABILITY"), { recursive: true });
  symlinkSync(userData, join(claude, "LIFEOS/USER"));
  const entries = Array.from({ length: 12 }, (_, i) => `RULE: fixture fact ${i} ~explicit`);
  const body = (list: string[]) =>
    `---\nschema_version: 1\nlast_updated: 2026-01-01T11:00:00.000Z\nlast_updated_by: fixture\n---\n\n# Memory\n\n<!-- BEGIN ENTRIES -->\n${list.join("\n")}\n<!-- END ENTRIES -->\n`;
  const path = join(claude, REL);
  writeFileSync(path, body(entries));
  writeFileSync(join(claude, "LIFEOS/USER/DIGITAL_ASSISTANT/DA_MEMORY.md"), body(["ROLE: fixture assistant fact ~explicit"]));
  return { home, path };
}

/**
 * Run `body` in a fresh process whose homedir() is the fixture home; the value
 * it returns comes back through a result file. Not stdout: under `bun test` in
 * this directory, Bun.spawnSync ran the child but captured an empty stdout.
 */
function scenario(home: string, body: string): any {
  const id = Math.random().toString(36).slice(2);
  const file = join(home, `scenario-${id}.ts`);
  const result = join(home, `result-${id}.json`);
  writeFileSync(file, `
    const fs = await import("node:fs");
    try {
      const out = await (async () => { ${body} })();
      fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ out: out ?? null }));
    } catch (e) {
      fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ error: String(e?.stack ?? e) }));
    }
  `);
  Bun.spawnSync(["bun", file], { cwd: home, env: { ...process.env, HOME: home } });
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(result, "utf8"));
  } catch {
    throw new Error(`scenario produced no result file: ${file}`);
  }
  if (parsed.error) throw new Error(`scenario threw: ${parsed.error}`);
  return parsed.out;
}

/** Run a MemoryWriter scenario; `W` is the writer module and `P` the fixture principal file. */
function run(home: string, code: string): any {
  return scenario(home, `
    const W = await import(${JSON.stringify(join(TOOLS, "MemoryWriter.ts"))});
    const P = ${JSON.stringify(join(home, ".claude", REL))};
    ${code}
  `);
}

function writeLog(home: string): any[] {
  const p = join(home, ".claude/LIFEOS/MEMORY/OBSERVABILITY/memory-writes.jsonl");
  try {
    return readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe("stale-base guard", () => {
  test("replay: a review write on a stale snapshot does not undo a manual consolidation", () => {
    const { home } = fixture();
    const out = run(home, `
      const snapshot = W.read(P);                                   // reviewer snapshot, before inference
      const merged = snapshot.entries.slice(2).concat("RULE: fixture facts 0 and 1, merged ~explicit");
      const manual = W.setEntries(P, merged, { updatedBy: "manual-curation", allowDrastic: true }); // manual edit during inference
      const review = W.setEntries(P, snapshot.entries.concat("RULE: new fact from review ~explicit"),
        { updatedBy: "MemorySystem.add", expectedFingerprint: snapshot.fingerprint });                  // review write after inference
      return { manualOk: manual.ok, review, after: W.read(P).entries, merged };
    `);
    expect(out.manualOk).toBe(true);
    expect(out.review.ok).toBe(false);
    expect(out.review.code).toBe("ESTALE_BASE");
    expect(out.after).toEqual(out.merged);
  });

  test("a matching fingerprint writes normally", () => {
    const { home } = fixture();
    const out = run(home, `
      const snap = W.read(P);
      return W.setEntries(P, snap.entries.concat("RULE: added ~explicit"), { expectedFingerprint: snap.fingerprint });
    `);
    expect(out.ok).toBe(true);
    expect(out.new_count).toBe(13);
  });

  test("a frontmatter-only change (timestamp) is not a stale base", () => {
    const { home, path } = fixture();
    const out = run(home, `
      const snap = W.read(P);
      const fs = await import("node:fs");
      fs.writeFileSync(P, fs.readFileSync(P, "utf8").replace(/last_updated: .*/, "last_updated: 2026-01-01T12:00:00.000Z"));
      return W.setEntries(P, snap.entries.concat("RULE: added ~explicit"), { expectedFingerprint: snap.fingerprint });
    `);
    expect(out.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("RULE: added ~explicit");
  });

  test("callers without a fingerprint behave as before", () => {
    const { home } = fixture();
    const out = run(home, `
      const snap = W.read(P);
      W.setEntries(P, snap.entries.concat("RULE: someone else ~explicit"));
      return W.setEntries(P, snap.entries.concat("RULE: legacy caller ~explicit"));
    `);
    expect(out.ok).toBe(true);
  });

  test("a refusal is logged to memory-writes.jsonl with both fingerprints", () => {
    const { home } = fixture();
    run(home, `
      const snap = W.read(P);
      W.setEntries(P, snap.entries.concat("RULE: manual ~explicit"), { updatedBy: "manual" });
      return W.setEntries(P, snap.entries, { updatedBy: "MemorySystem.add", expectedFingerprint: snap.fingerprint });
    `);
    const row = writeLog(home).find((r) => r.rejected === true);
    expect(row?.rejection_code).toBe("ESTALE_BASE");
    expect(row?.updated_by).toBe("MemorySystem.add");
    expect(typeof row?.expected_fingerprint).toBe("string");
    expect(row?.expected_fingerprint).not.toBe(row?.actual_fingerprint);
  });
});

describe("lock handling", () => {
  test("a lock released within the wait window is retried, not dropped", () => {
    const { home } = fixture();
    // setEntries waits synchronously, so the lock is released by a child process.
    const retried = run(home, `
      const fs = await import("node:fs");
      fs.writeFileSync(P + ".lock", "");
      Bun.spawn(["sh", "-c", "sleep 0.3; rm -f '" + P + ".lock'"]);
      const snap = W.read(P);
      return W.setEntries(P, snap.entries.concat("RULE: after lock ~explicit"), { expectedFingerprint: snap.fingerprint });
    `);
    expect(retried.ok).toBe(true);
  });

  test("a lock that never releases fails with ELOCK_HELD and is logged", () => {
    const { home } = fixture();
    const out = run(home, `
      const fs = await import("node:fs");
      fs.writeFileSync(P + ".lock", "");
      const t0 = Date.now();
      const r = W.setEntries(P, W.read(P).entries.concat("RULE: blocked ~explicit"), { updatedBy: "MemorySystem.add" });
      return { code: r.code, waitedMs: Date.now() - t0 };
    `);
    expect(out.code).toBe("ELOCK_HELD");
    expect(out.waitedMs).toBeGreaterThanOrEqual(1500);
    expect(out.waitedMs).toBeLessThan(5000);
    expect(writeLog(home).some((r) => r.rejection_code === "ELOCK_HELD")).toBe(true);
  });
});

describe("health check", () => {
  /** Run MemoryHealthCheck against the fixture root and return its report's finding ids. */
  function healthFindings(home: string, nowIso?: string): string[] {
    const root = join(home, ".claude");
    Bun.spawnSync(["bun", join(TOOLS, "MemoryHealthCheck.ts")], {
      cwd: home,
      env: { ...process.env, HOME: home, CORTEX_HEALTH_ROOT: root, ...(nowIso ? { CORTEX_HEALTH_NOW: nowIso } : {}) },
    });
    const rows = readFileSync(join(root, "LIFEOS/MEMORY/OBSERVABILITY/memory-health.jsonl"), "utf8").trim().split("\n");
    return JSON.parse(rows[rows.length - 1]).findings.map((f: any) => f.id);
  }

  test("a refused write warns for 24h, then clears", () => {
    const { home } = fixture();
    run(home, `
      const snap = W.read(P);
      W.setEntries(P, snap.entries.concat("RULE: manual ~explicit"), { updatedBy: "manual" });
      return W.setEntries(P, snap.entries, { updatedBy: "MemorySystem.add", expectedFingerprint: snap.fingerprint });
    `);
    expect(healthFindings(home)).toContain("refused-writes");
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
    expect(healthFindings(home, later)).not.toContain("refused-writes");
    const earlier = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(healthFindings(home, earlier)).not.toContain("refused-writes"); // future-dated row not counted
  });

  test("a write dropped on a held lock also warns", () => {
    const { home } = fixture();
    run(home, `
      const fs = await import("node:fs");
      fs.writeFileSync(P + ".lock", "");
      return W.setEntries(P, W.read(P).entries.concat("RULE: blocked ~explicit"), { updatedBy: "MemorySystem.add" }).code;
    `);
    expect(healthFindings(home)).toContain("refused-writes");
  });
});

describe("reviewer wiring", () => {
  test("dispatchItems refuses a memory set whose snapshot went stale, and the manual write survives", () => {
    const { home } = fixture();
    const out = run(home, `
      const R = await import(${JSON.stringify(join(TOOLS, "MemoryReviewer.ts"))});
      const snap = R.readCurrentMemorySnapshot();
      W.setEntries(P, snap.principal.concat("RULE: manual fact ~explicit"), { updatedBy: "manual" });
      const { summary, results } = R.dispatchItems(
        [{ type: "memory", actor: "principal", op: "set", entries: snap.principal.concat("RULE: review fact ~explicit") }],
        { baseFingerprints: snap.fingerprints },
      );
      return { summary, results, after: W.read(P).entries };
    `);
    // A refusal is the guard working: counted as a guard skip, not a failed run.
    expect(out.summary.failed).toBe(0);
    expect(out.summary.skipped_guard).toBe(1);
    expect(JSON.stringify(out.results[0])).toContain("ESTALE_BASE");
    expect(out.after).toContain("RULE: manual fact ~explicit");
    expect(out.after).not.toContain("RULE: review fact ~explicit");
  });

  test("with no concurrent edit, sets for both actors land (fingerprints wired to the right files)", () => {
    const { home } = fixture();
    const out = run(home, `
      const R = await import(${JSON.stringify(join(TOOLS, "MemoryReviewer.ts"))});
      const snap = R.readCurrentMemorySnapshot();
      const { summary } = R.dispatchItems([
        { type: "memory", actor: "principal", op: "set", entries: snap.principal.concat("RULE: principal new ~explicit") },
        { type: "memory", actor: "assistant", op: "set", entries: snap.assistant.concat("ROLE: assistant new ~explicit") },
      ], { baseFingerprints: snap.fingerprints });
      const A = ${JSON.stringify(join(home, ".claude/LIFEOS/USER/DIGITAL_ASSISTANT/DA_MEMORY.md"))};
      return { summary, principal: W.read(P).entries, assistant: W.read(A).entries };
    `);
    expect(out.summary.succeeded).toBe(2);
    expect(out.principal).toContain("RULE: principal new ~explicit");
    expect(out.assistant).toContain("ROLE: assistant new ~explicit");
  });

  test("a second item for the same actor builds on the first write, not the old snapshot", () => {
    const { home } = fixture();
    const out = run(home, `
      const R = await import(${JSON.stringify(join(TOOLS, "MemoryReviewer.ts"))});
      const snap = R.readCurrentMemorySnapshot();
      const { summary } = R.dispatchItems([
        { type: "memory", actor: "principal", op: "set", entries: snap.principal.concat("RULE: first ~explicit") },
        { type: "memory", actor: "principal", op: "add", content: "RULE: second ~explicit" },
      ], { baseFingerprints: snap.fingerprints });
      return { summary, after: W.read(P).entries };
    `);
    expect(out.summary.succeeded).toBe(2);
    expect(out.after).toContain("RULE: first ~explicit");
    expect(out.after).toContain("RULE: second ~explicit");
  });

  test("review() end to end with mocked inference passes its snapshot's fingerprints and writes", () => {
    const { home } = fixture();
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({ timestamp: "2026-01-01T11:00:00Z", message: { role: "user", content: "remember that I prefer tea" } }),
      JSON.stringify({ timestamp: "2026-01-01T11:00:05Z", message: { role: "assistant", content: "Noted." } }),
    ].join("\n") + "\n");
    const fixtureEntries = Array.from({ length: 12 }, (_, i) => `RULE: fixture fact ${i} ~explicit`);
    const mock = JSON.stringify({ items: [{ type: "memory", actor: "principal", op: "set", entries: fixtureEntries.concat("PREFERENCE: prefers tea ~explicit") }] });
    const out = run(home, `
      const R = await import(${JSON.stringify(join(TOOLS, "MemoryReviewer.ts"))});
      const res = await R.review({ input: ${JSON.stringify(transcript)}, mockInferenceResponse: ${JSON.stringify(mock)} });
      return { ok: res.ok, summary: res.dispatch_summary, after: W.read(P).entries };
    `);
    expect(out.ok).toBe(true);
    expect(out.summary.succeeded).toBe(1);
    expect(out.after).toContain("PREFERENCE: prefers tea ~explicit");
  });
});
