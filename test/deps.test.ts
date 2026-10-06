import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const stampFile = () => join(sb.home, ".local", "state", "rig", "packs.json");

/** A pack whose tool imports a local npm package, so `bun install` works offline. */
function depsPack(name: string, pkg: object = {}) {
  const dir = join(dirname(sb.user), name);
  mkdirSync(join(dir, "vendor", "shout"), { recursive: true });
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ name }));
  writeFileSync(join(dir, "vendor", "shout", "package.json"), JSON.stringify({ name: "shout", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(dir, "vendor", "shout", "index.js"), "module.exports = (s) => s.toUpperCase() + '!';\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, private: true, dependencies: { shout: "file:./vendor/shout" }, ...pkg }));
  mkdirSync(join(dir, "tools", `${name}-shout`), { recursive: true });
  writeFileSync(
    join(dir, "tools", `${name}-shout`, "index.ts"),
    `import { defineCommand, defineTool, z } from "rig";
import shout from "shout";
export default defineTool({ name: "${name}-shout", description: "x", commands: {
  "${name}-shout": defineCommand({ description: "x", args: z.object({ s: z.string() }), positional: ["s"], run: ({ s }) => shout(s) }),
} });
`,
  );
  return dir;
}

describe("pack dependencies", () => {
  test("a stale stamp is a problem; sync installs and stamps", async () => {
    const dir = depsPack("loud");
    const before = await sb.run(["status"]);
    expect(before.stdout).toContain("pack loud: dependencies changed; run rig sync");

    const sync = await sb.run(["sync"]);
    expect(sync.stdout).toContain("~ installed dependencies for pack loud");
    expect(sync.code).toBe(0);
    expect(existsSync(join(dir, "node_modules", "shout"))).toBe(true);
    expect(JSON.parse(readFileSync(stampFile(), "utf8")).loud.depsHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await sb.run(["loud-shout", "hi"])).stdout).toBe("HI!\n");

    const again = await sb.run(["sync"]);
    expect(again.stdout).not.toContain("installed dependencies");
    expect(again.stdout).not.toContain("dependencies changed");
  }, 30_000);

  test("editing package.json makes the stamp stale again", async () => {
    const dir = depsPack("loud");
    await sb.run(["sync"]);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ ...manifest, description: "changed" }));
    expect((await sb.run(["status"])).stdout).toContain("pack loud: dependencies changed");
  }, 30_000);

  test("rig pack install installs on demand", async () => {
    depsPack("loud");
    const r = await sb.run(["pack", "install", "loud"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ loud");
    expect((await sb.run(["status"])).stdout).not.toContain("dependencies changed");
  }, 30_000);

  test("an install failure stays scoped to its pack", async () => {
    const dir = depsPack("broken");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "broken", dependencies: { gone: "file:./vendor/missing" } }));
    const sync = await sb.run(["sync"]);
    expect(sync.code).toBe(1);
    expect(sync.stdout).toContain("pack broken: bun install failed");
    expect(existsSync(stampFile())).toBe(false);
    expect((await sb.run(["greet", "x"])).stdout).toBe("hello x\n");
    expect(sync.stdout).toContain("beta → ");
  }, 30_000);

  test("a peer range mismatch disables that pack's tools", async () => {
    depsPack("old", { peerDependencies: { rig: "^99.0.0" } });
    const { stdout } = await sb.run(["status"]);
    expect(stdout).toMatch(/pack old: needs rig \^99\.0\.0, but this is rig \d+\.\d+\.\d+; its tools don't load/);
    expect((await sb.run(["old-shout", "x"])).code).toBe(1);
    expect((await sb.run(["greet", "x"])).code).toBe(0);
  });

  test("a satisfied peer range loads normally", async () => {
    depsPack("ok", { peerDependencies: { rig: ">=0.1.0" } });
    await sb.run(["sync"]);
    expect((await sb.run(["ok-shout", "x"])).stdout).toBe("X!\n");
  }, 30_000);
});
