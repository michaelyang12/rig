import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const writeConfig = (config: object) => {
  const file = join(sb.home, ".config", "rig", "config.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config));
};

/** A pack with one tool that imports `rig` and `zod`, and checks they share one zod instance. */
function makePack(dir: string, name: string, tool = `${name}-tool`) {
  mkdirSync(join(dir, "tools", tool), { recursive: true });
  mkdirSync(join(dir, "skills", `${name}-skill`), { recursive: true });
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ name }));
  writeFileSync(join(dir, "skills", `${name}-skill`, "SKILL.md"), `---\nname: ${name}-skill\ndescription: x\n---\n`);
  writeFileSync(join(dir, "tools", tool, "schema.ts"), `import { z } from "zod";\nexport const args = z.object({ n: z.number() });\n`);
  writeFileSync(
    join(dir, "tools", tool, "index.ts"),
    `import { defineCommand, defineTool, z } from "rig";
import * as zod from "zod";
import { args } from "./schema";
export default defineTool({
  name: ${JSON.stringify(tool)},
  description: "Test tool",
  commands: {
    ${JSON.stringify(tool)}: defineCommand({
      description: "Doubles n",
      args,
      positional: ["n"],
      run: ({ n }) => ({ doubled: n * 2, sameZod: z === zod.z && args instanceof z.ZodObject }),
    }),
  },
});
`,
  );
}

describe("pack discovery", () => {
  test("a pack outside the repo, reached through a symlink, imports rig and zod", async () => {
    const outside = join(sb.dir, "elsewhere", "my-pack");
    makePack(outside, "ext");
    symlinkSync(outside, join(dirname(sb.user), "linked"));
    const r = await sb.run(["ext-tool", "21", "--json"]);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout).data).toEqual({ doubled: 42, sameZod: true });
    await sb.run(["sync"]);
    expect(lstatSync(join(sb.claude, "ext-skill")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(sb.claude, "ext-skill"))).toBe(join(dirname(sb.user), "linked", "skills", "ext-skill"));
  });

  test("config packs paths are loaded, with ~ expanded", async () => {
    makePack(join(sb.home, "src", "work-pack"), "work");
    writeConfig({ packs: ["~/src/work-pack"] });
    expect(JSON.parse((await sb.run(["work-tool", "2", "--json"])).stdout).data.doubled).toBe(4);
  });

  test("a missing config pack path is a problem", async () => {
    writeConfig({ packs: ["~/nowhere"] });
    const { code, stdout } = await sb.run(["sync"]);
    expect(code).toBe(1);
    expect(stdout).toContain("pack at ~/nowhere: directory not found");
  });

  test("a duplicate pack name is skipped and reported", async () => {
    cpSync(sb.user, join(sb.home, "copy"), { recursive: true });
    writeConfig({ packs: ["~/copy"] });
    const { code, stdout } = await sb.run(["sync"]);
    expect(code).toBe(1);
    expect(stdout).toContain(`pack at ~/copy: name "demo" is already used by ~/.config/rig/packs/demo; skipped`);
    expect(stdout).toContain("3 tool(s)");
  });

  test("a scanned directory without pack.json is a problem", async () => {
    mkdirSync(join(dirname(sb.user), "loose", "skills"), { recursive: true });
    const { code, stdout } = await sb.run(["sync"]);
    expect(code).toBe(1);
    expect(stdout).toContain("pack at ~/.config/rig/packs/loose: missing pack.json");
  });

  test("only the core pack may be named rig", async () => {
    writeFileSync(join(sb.user, "pack.json"), JSON.stringify({ name: "rig" }));
    const { stdout } = await sb.run(["sync"]);
    expect(stdout).toContain(`"rig" is reserved for the core pack`);
    expect(existsSync(join(sb.claude, "beta"))).toBe(false);
  });

  test("dev packs under <root>/packs load too", async () => {
    makePack(join(sb.root, "packs", "dev"), "dev");
    expect(JSON.parse((await sb.run(["dev-tool", "1", "--json"])).stdout).data.doubled).toBe(2);
  });
});

describe("rig pack", () => {
  test("ls shows each pack's origin, source, counts and dependency state", async () => {
    const { code, stdout } = await sb.run(["pack", "ls"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/rig\s+core\s+\S+\/root\/packs\/rig\s+1 tool\(s\), 1 skill\(s\)\s+no deps/);
    expect(stdout).toMatch(/demo\s+config dir\s+~\/\.config\/rig\/packs\/demo\s+2 tool\(s\), 1 skill\(s\)/);
    const { data } = JSON.parse((await sb.run(["pack", "ls", "--json"])).stdout);
    expect(data.map((p: { name: string; origin: string }) => [p.name, p.origin])).toEqual([["rig", "core"], ["demo", "config dir"]]);
  });

  test("add and remove edit config packs and never delete files", async () => {
    const dir = join(sb.home, "src", "work-pack");
    makePack(dir, "work");
    const added = await sb.run(["pack", "add", "~/src/work-pack"]);
    expect(added.code).toBe(0);
    expect(JSON.parse(readFileSync(join(sb.home, ".config", "rig", "config.json"), "utf8")).packs).toEqual(["~/src/work-pack"]);
    expect(lstatSync(join(sb.claude, "work-skill")).isSymbolicLink()).toBe(true);
    expect((await sb.run(["pack", "add", dir])).stdout).toContain("already a pack source");

    expect((await sb.run(["pack", "remove", "work"])).code).toBe(0);
    expect(existsSync(join(sb.claude, "work-skill"))).toBe(false);
    expect(existsSync(join(dir, "pack.json"))).toBe(true);
  });

  test("remove refuses a pack that isn't from config, and points at disable", async () => {
    const r = await sb.run(["pack", "remove", "demo"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("rig pack disable demo");
  });

  test("disable turns off a whole pack, enable brings it back", async () => {
    await sb.run(["sync"]);
    expect((await sb.run(["pack", "disable", "demo"])).code).toBe(0);
    expect(existsSync(join(sb.claude, "beta"))).toBe(false);
    expect((await sb.run(["acme-whoami"])).code).toBe(1);
    expect((await sb.run(["pack", "ls"])).stdout).toContain("demo (disabled)");
    expect((await sb.run(["pack", "disable", "rig"])).code).toBe(2);

    expect((await sb.run(["pack", "enable", "demo"])).code).toBe(0);
    expect(lstatSync(join(sb.claude, "beta")).isSymbolicLink()).toBe(true);
  });
});

describe("rig new", () => {
  test("new pack scaffolds into the config dir", async () => {
    const r = await sb.run(["new", "pack", "work"]);
    expect(r.code).toBe(0);
    const dir = join(dirname(sb.user), "work");
    expect(JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")).name).toBe("work");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("node_modules");
    expect(existsSync(join(dir, "skills"))).toBe(true);
    expect((await sb.run(["new", "pack", "work"])).code).toBe(2);
    expect((await sb.run(["new", "pack", "rig"])).code).toBe(2);
  });

  test("new pack --path elsewhere adds it to config", async () => {
    await sb.run(["new", "pack", "work", "--path", "~/src/work"]);
    expect(JSON.parse(readFileSync(join(sb.home, ".config", "rig", "config.json"), "utf8")).packs).toEqual(["~/src/work"]);
    expect((await sb.run(["new", "tool", "hey", "--pack", "work", "--no-skill"])).code).toBe(0);
    expect((await sb.run(["hey", "you"])).stdout).toBe("hello you\n");
    expect(existsSync(join(sb.home, "src", "work", "tools", "hey", "index.ts"))).toBe(true);
  });

  test("with two user packs, new tool needs --pack or defaultPack", async () => {
    await sb.run(["new", "pack", "work"]);
    const r = await sb.run(["new", "tool", "hey"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("choose one with --pack <name>");
    expect(r.stderr).toContain("packs: rig, demo, work");

    writeConfig({ defaultPack: "work" });
    expect((await sb.run(["new", "skill", "notes"])).code).toBe(0);
    expect(existsSync(join(dirname(sb.user), "work", "skills", "notes", "SKILL.md"))).toBe(true);
  });

  test("--pack rig targets the core pack", async () => {
    expect((await sb.run(["new", "skill", "core-notes", "--pack", "rig"])).code).toBe(0);
    expect(existsSync(join(sb.core, "skills", "core-notes", "SKILL.md"))).toBe(true);
  });

  test("a name another pack already uses is refused", async () => {
    const r = await sb.run(["new", "skill", "alpha"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("(pack rig)");
  });
});

describe("rig ls", () => {
  test("groups tools under their pack", async () => {
    const { stdout } = await sb.run(["ls"]);
    expect(stdout).toMatch(/rig:\n\s+greet\s+Greets people\ndemo:\n\s+acme\s+Talks to the Acme API\n\s+pyecho/);
  });
});
