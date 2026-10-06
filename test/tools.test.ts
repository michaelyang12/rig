import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

// Stand-in for a real API: accepts only "Bearer good".
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.headers.get("authorization") !== "Bearer good") return new Response("nope", { status: 401 });
      return Response.json({ user: "michael" });
    },
  });
});
afterAll(() => server.stop());

function writeEnv(lines: string) {
  mkdirSync(join(sb.home, ".config", "rig"), { recursive: true });
  writeFileSync(sb.envFile, lines);
}

describe("call contract", () => {
  test("flags, positionals, booleans and arrays", async () => {
    const r = await sb.run(["greet", "bob", "--loud", "--times", "2", "--tag", "a", "--tag=b"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("HELLO BOB [A,B]\nHELLO BOB [A,B]\n");
  });

  test("--json wraps results in an envelope", async () => {
    const r = await sb.run(["greet-obj", "--name", "ann", "--json"]);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, data: { greeting: "hi ann" } });
  });

  test("format() renders text output", async () => {
    expect((await sb.run(["greet-obj", "--name", "ann"])).stdout).toBe(">> hi ann\n");
  });

  test("--input accepts a JSON object, inline or on stdin", async () => {
    expect((await sb.run(["greet", "--input", '{"name":"cy","times":2}'])).stdout).toBe("hello cy\nhello cy\n");
    expect((await sb.run(["greet", "--input", "-"], { stdin: '{"name":"di"}' })).stdout).toBe("hello di\n");
  });

  test("usage errors exit 2", async () => {
    const unknown = await sb.run(["greet", "bob", "--nope", "1"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown flag --nope");

    const missing = await sb.run(["greet"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("missing required --name");

    const invalid = await sb.run(["greet", "bob", "--times", "0", "--json"]);
    expect(invalid.code).toBe(2);
    const body = JSON.parse(invalid.stdout);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("USAGE");
    expect(body.error.message).toContain("times");
  });

  test("--help renders flags from the schema", async () => {
    const r = await sb.run(["greet", "--help"]);
    expect(r.stdout).toContain("Usage: rig greet <name> [flags]");
    expect(r.stdout).toContain("--times <integer>");
    expect(r.stdout).toContain("Who to greet (required)");
  });

  test("ls --json and schema expose JSON Schemas", async () => {
    const ls = JSON.parse((await sb.run(["ls", "--json"])).stdout);
    expect(ls.data.map((c: { command: string }) => c.command).sort()).toEqual(
      ["acme-whoami", "greet", "greet-obj", "pyecho", "pyecho-fail"],
    );
    const schema = JSON.parse((await sb.run(["schema", "greet"])).stdout);
    expect(schema.inputSchema.required).toEqual(["name"]);
  });
});

describe("external tools", () => {
  test("receive args as JSON on stdin", async () => {
    const r = await sb.run(["pyecho", "hi", "--n", "3"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ command: "pyecho", args: { msg: "hi", n: 3 } });
  });

  test("--json parses their output into the envelope", async () => {
    const r = await sb.run(["pyecho", "hi", "--json"]);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, data: { command: "pyecho", args: { msg: "hi" } } });
  });

  test("exit codes pass through, and map to error codes under --json", async () => {
    const plain = await sb.run(["pyecho-fail"]);
    expect(plain.code).toBe(3);
    expect(plain.stderr).toContain("bad credentials");
    const json = await sb.run(["pyecho-fail", "--json"]);
    expect(JSON.parse(json.stdout).error).toMatchObject({ code: "AUTH", message: "bad credentials" });
  });
});

describe("auth", () => {
  test("missing credentials exit 3 with a rig auth hint", async () => {
    const r = await sb.run(["acme-whoami"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("acme is missing ACME_API_KEY, ACME_BASE_URL");
    expect(r.stderr).toContain("rig auth acme");
  });

  test("reads credentials from the rig .env file", async () => {
    writeEnv(`ACME_API_KEY=good\nACME_BASE_URL=${server.url.origin}\n`);
    const r = await sb.run(["acme-whoami", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).data).toEqual({ user: "michael" });
  });

  test("shell env overrides the .env file", async () => {
    writeEnv(`ACME_API_KEY=bad\nACME_BASE_URL=${server.url.origin}\n`);
    expect((await sb.run(["acme-whoami"], { env: { ACME_API_KEY: "good" } })).code).toBe(0);
  });

  test("401 from upstream maps to AUTH", async () => {
    writeEnv(`ACME_API_KEY=bad\nACME_BASE_URL=${server.url.origin}\n`);
    const r = await sb.run(["acme-whoami", "--json"]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: "AUTH", hint: "check credentials with: rig auth acme" });
  });

  test("--status reports each var without printing values", async () => {
    writeEnv("ACME_API_KEY=supersecret\n");
    const r = await sb.run(["auth", "--status"]);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("✓ ACME_API_KEY (rig .env)");
    expect(r.stdout).toContain("✗ ACME_BASE_URL");
    expect(r.stdout).toContain("- ACME_REGION (optional)");
    expect(r.stdout).not.toContain("supersecret");
  });

  test("interactive auth refuses to run without a terminal", async () => {
    const r = await sb.run(["auth", "acme"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("needs a terminal");
    expect(r.stderr).toContain("rig auth acme");
  });

  test("tools without auth say so", async () => {
    expect((await sb.run(["auth", "greet"])).stdout).toContain("doesn't need any credentials");
  });
});

describe("new", () => {
  test("scaffolded TS tools with auth load and follow the key convention", async () => {
    expect((await sb.run(["new", "tool", "wiki", "--auth"])).code).toBe(0);
    expect(readFileSync(join(sb.user, "skills", "wiki", "SKILL.md"), "utf8")).toContain("rig auth wiki");
    const status = await sb.run(["auth", "wiki", "--status"]);
    expect(status.stdout).toContain("✗ WIKI_API_KEY");
    expect(status.stdout).toContain("✗ WIKI_BASE_URL");
    expect((await sb.run(["wiki-get", "--help"])).stdout).toContain("Usage: rig wiki-get <id>");
  });

  test("scaffolded TS tools without auth run immediately", async () => {
    await sb.run(["new", "tool", "hey", "--no-skill"]);
    expect((await sb.run(["hey", "you", "--loud"])).stdout).toBe("HELLO YOU\n");
  });

  test("scaffolded uv tools run through uv", async () => {
    await sb.run(["new", "tool", "pyhey", "--uv"]);
    expect(statSync(join(sb.user, "tools", "pyhey", "main.py")).isFile()).toBe(true);
    const r = await sb.run(["pyhey", "zed"]);
    expect(JSON.parse(r.stdout)).toEqual({ message: "hello zed" });
  }, 30_000);

  test("rejects reserved and existing names", async () => {
    expect((await sb.run(["new", "tool", "sync"])).code).toBe(2);
    expect((await sb.run(["new", "tool", "greet"])).code).toBe(2);
  });
});
