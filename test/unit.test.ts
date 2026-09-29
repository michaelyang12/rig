import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgv } from "../src/core/args";
import { parseDotenv, upsertEnvFile } from "../src/core/env";
import { normalizeAuth } from "../src/core/registry";
import { apiKeyVar } from "../src/sdk";

describe("parseDotenv", () => {
  test("handles quotes, export, comments", () => {
    expect(
      parseDotenv(`# c\nexport A=1\nB="two words"\nC='lit $x'\nD=val # note\nE="a\\"b"\n bad line`),
    ).toEqual({ A: "1", B: "two words", C: "lit $x", D: "val", E: 'a"b' });
  });
});

describe("upsertEnvFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rig-env-"));
    process.env.RIG_CONFIG_DIR = dir;
  });
  afterEach(() => {
    delete process.env.RIG_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  test("updates in place, appends new keys, preserves comments, and is 0600", () => {
    writeFileSync(join(dir, ".env"), "# mine\nA=1\nB=2\n");
    upsertEnvFile({ B: "new value", C: "3" });
    const file = join(dir, ".env");
    expect(readFileSync(file, "utf8")).toBe('# mine\nA=1\nB="new value"\nC=3\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(parseDotenv(readFileSync(file, "utf8")).B).toBe("new value");
  });
});

describe("normalizeAuth", () => {
  test("adds <TOOL>_API_KEY first, as a secret", () => {
    expect(apiKeyVar("my-tool")).toBe("MY_TOOL_API_KEY");
    const vars = normalizeAuth("my-tool", [{ name: "MY_TOOL_URL", prompt: "url" }]);
    expect(vars.map((v) => v.name)).toEqual(["MY_TOOL_API_KEY", "MY_TOOL_URL"]);
    expect(vars[0]!.secret).toBe(true);
  });

  test("keeps a custom prompt for the key but forces secret", () => {
    const [key] = normalizeAuth("x", [{ name: "X_API_KEY", prompt: "Personal token", secret: false }]);
    expect(key).toMatchObject({ name: "X_API_KEY", prompt: "Personal token", secret: true });
  });

  test("no auth declared means no vars", () => {
    expect(normalizeAuth("x", undefined)).toEqual([]);
  });

  test("rejects unprefixed vars and oddly named secrets", () => {
    expect(() => normalizeAuth("x", [{ name: "TOKEN", prompt: "t" }])).toThrow("prefixed with X_");
    expect(() => normalizeAuth("x", [{ name: "X_TOKEN", prompt: "t", secret: true }])).toThrow("X_API_KEY");
  });
});

describe("parseArgv", () => {
  const schema = {
    type: "object",
    properties: {
      pageId: { type: "string" },
      limit: { type: "integer" },
      verbose: { type: "boolean" },
      ids: { type: "array", items: { type: "number" } },
      maybe: { anyOf: [{ type: "number" }, { type: "null" }] },
    },
    required: ["pageId"],
  };

  test("kebab flags map to camelCase keys and values are coerced", async () => {
    const { args } = await parseArgv(["--page-id", "15151", "--limit=5", "--no-verbose", "--maybe", "2"], schema, []);
    expect(args).toEqual({ pageId: "15151", limit: 5, verbose: false, maybe: 2 });
  });

  test("a trailing array positional swallows the rest", async () => {
    const { args } = await parseArgv(["p1", "1", "2", "3"], schema, ["pageId", "ids"]);
    expect(args).toEqual({ pageId: "p1", ids: [1, 2, 3] });
  });

  test("positionals skip slots already set by flags", async () => {
    const { args } = await parseArgv(["--page-id", "a", "7"], schema, ["pageId", "limit"]);
    expect(args).toEqual({ pageId: "a", limit: 7 });
  });

  test("bad numbers are usage errors", async () => {
    expect(parseArgv(["--page-id", "a", "--limit", "x"], schema, [])).rejects.toMatchObject({ code: "USAGE" });
  });

  test("--help skips required checks", async () => {
    expect((await parseArgv(["--help"], schema, [])).help).toBe(true);
  });
});
