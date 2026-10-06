import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
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
