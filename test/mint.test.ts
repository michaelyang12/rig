import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mint, { formatReports, verdict } from "../tools/mint";

const run = mint.commands["mint-check"]!.run;
const ctx = { tool: "mint", env: () => undefined, secret: () => "", log: () => {} };

// Registry stand-in: `taken` URLs return 200, everything else 404.
function mockRegistries(taken: RegExp, npmWeekly = 0) {
  return spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.npmjs.org/downloads")) return Response.json({ downloads: npmWeekly });
    return new Response(null, { status: taken.test(url) ? 200 : 404 });
  }) as typeof fetch);
}

let sourceDir: string;
beforeEach(() => {
  sourceDir = mkdtempSync(join(tmpdir(), "mint-src-"));
});
afterEach(() => {
  rmSync(sourceDir, { recursive: true, force: true });
});

describe("mint-check", () => {
  test("a name free everywhere is clear", async () => {
    const spy = mockRegistries(/$^/);
    const [report] = (await run({ names: ["zzqqxv"], owner: "me", sourceDir }, ctx)) as ReturnType<typeof verdict>[];
    spy.mockRestore();
    expect(report!.verdict).toBe("clear");
    expect(Object.values(report!.checks).every((c) => c.status === "free")).toBe(true);
  });

  test("an existing ~/Source project or own GitHub repo is a conflict", async () => {
    mkdirSync(join(sourceDir, "Belt"));
    const spy = mockRegistries(/api\.github\.com\/repos\/me\/belt/);
    const [report] = (await run({ names: ["belt"], owner: "me", sourceDir }, ctx)) as ReturnType<typeof verdict>[];
    spy.mockRestore();
    expect(report!.verdict).toBe("conflict");
    expect(report!.conflicts).toEqual([`source (${join(sourceDir, "Belt")})`, "github (me/belt)"]);
  });

  test("npm squats are ignored but popular packages conflict", async () => {
    let spy = mockRegistries(/registry\.npmjs\.org|pypi|crates/, 6);
    let [report] = (await run({ names: ["quiver"], owner: "me", sourceDir }, ctx)) as ReturnType<typeof verdict>[];
    spy.mockRestore();
    expect(report!.verdict).toBe("clear");
    expect(report!.checks.npm).toEqual({ status: "taken", detail: "6/wk" });

    spy = mockRegistries(/registry\.npmjs\.org/, 250_000);
    [report] = (await run({ names: ["quiver"], owner: "me", sourceDir }, ctx)) as ReturnType<typeof verdict>[];
    spy.mockRestore();
    expect(report!.conflicts).toEqual(["npm (popular: 250,000/wk)"]);
  });

  test("network errors are reported, not treated as free", async () => {
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    const [report] = (await run({ names: ["zzqqxv"], owner: "me", sourceDir }, ctx)) as ReturnType<typeof verdict>[];
    spy.mockRestore();
    expect(report!.checks.npm).toEqual({ status: "error", detail: "offline" });
    expect(report!.checks.brew!.status).toBe("error");
  });

  test("formats a table with a conflicts summary", () => {
    const text = formatReports([
      verdict("a", { local: { status: "taken", detail: "/bin/a" }, npm: { status: "free" } }),
      verdict("b", { local: { status: "free" } }),
    ]);
    expect(text).toContain("name  verdict");
    expect(text).toContain("Conflicts:\n  a: local (/bin/a)");
  });
});
