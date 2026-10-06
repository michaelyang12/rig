import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const configFile = () => join(sb.home, ".config", "rig", "config.json");
const writeConfig = (config: object) => {
  mkdirSync(dirname(configFile()), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(config));
};
const readConfig = () => JSON.parse(readFileSync(configFile(), "utf8"));

/** Adds a TS tool whose commands each print `<pack>/<command>`, so tests can tell which side ran. */
function addTool(packDir: string, tool: string, commands: string[] = [tool]) {
  const pack = JSON.parse(readFileSync(join(packDir, "pack.json"), "utf8")).name;
  const dir = join(packDir, "tools", tool);
  mkdirSync(dir, { recursive: true });
  const defs = commands
    .map((cmd) => `${JSON.stringify(cmd)}: defineCommand({ description: "x", args: z.object({}), run: () => "${pack}/${cmd}" })`)
    .join(",\n    ");
  writeFileSync(
    join(dir, "index.ts"),
    `import { defineCommand, defineTool, z } from "rig";
export default defineTool({ name: ${JSON.stringify(tool)}, description: "x", commands: {
    ${defs}
} });
`,
  );
}

function addSkill(packDir: string, name: string) {
  mkdirSync(join(packDir, "skills", name), { recursive: true });
  writeFileSync(join(packDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\n`);
}

/** A second user pack, `work`, next to the fixture's `demo`. */
function workPack(): string {
  const dir = join(dirname(sb.user), "work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ name: "work" }));
  return dir;
}

const out = async (args: string[]) => (await sb.run(args)).stdout.trim();

describe("commands", () => {
  test("a bare collision: both qualified forms work, the bare name fails with a hint, sync reports it", async () => {
    const work = workPack();
    addTool(sb.user, "demo-tool", ["check"]);
    addTool(work, "work-tool", ["check"]);
    expect(await out(["demo:check"])).toBe("demo/check");
    expect(await out(["work:check"])).toBe("work/check");

    const bare = await sb.run(["check"]);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("check is defined by more than one pack");
    expect(bare.stderr).toContain("rig demo:check, rig work:check");

    const sync = await sb.run(["sync"]);
    expect(sync.code).toBe(1);
    expect(sync.stdout).toContain("command check is defined by demo:check and work:check");
  });

  test("ls shows a collided command by its qualified name", async () => {
    addTool(sb.user, "demo-tool", ["check"]);
    addTool(workPack(), "work-tool", ["check"]);
    expect(await out(["ls", "work-tool"])).toContain("rig work:check");
    const { data } = JSON.parse(await out(["ls", "--json", "demo-tool"]));
    expect(data).toEqual([expect.objectContaining({ command: "check", qualified: "demo:check", pack: "demo" })]);
  });

  test("an alias settles a collision", async () => {
    addTool(sb.user, "demo-tool", ["check"]);
    addTool(workPack(), "work-tool", ["check"]);
    writeConfig({ aliases: { check: "work:check" } });
    expect(await out(["check"])).toBe("work/check");
    expect(await out(["demo:check"])).toBe("demo/check");
    const sync = await sb.run(["sync"]);
    expect(sync.stdout).not.toContain("command check is defined by");
  });

  test("an alias to a missing command, or over a built-in, is a problem", async () => {
    writeConfig({ aliases: { nope: "demo:nope", sync: "rig:greet" } });
    const { code, stdout } = await sb.run(["sync"]);
    expect(code).toBe(1);
    expect(stdout).toContain("alias nope: no active command demo:nope");
    expect(stdout).toContain("alias sync: can't override the built-in rig sync");
  });

  test("core wins against a user command of the same name, and so do built-ins", async () => {
    addTool(sb.user, "demo-tool", ["greet-obj", "status"]);
    expect(await out(["greet-obj", "--name", "x"])).toBe(">> hi x");
    expect(await out(["demo:greet-obj"])).toBe("demo/greet-obj");
    expect(await out(["demo:status"])).toBe("demo/status");
    const { stdout } = await sb.run(["sync"]);
    expect(stdout).toContain("pack demo: command greet-obj is already a core command; call it as rig demo:greet-obj");
    expect(stdout).toContain(`tool demo-tool: command "status" is a reserved rig command; call it as rig demo:status`);
  });
});

describe("tools", () => {
  test("a tool-name collision loads neither, until one is disabled", async () => {
    addTool(sb.user, "dup", ["dup-a"]);
    addTool(workPack(), "dup", ["dup-b"]);
    const sync = await sb.run(["sync"]);
    expect(sync.stdout).toContain("tool dup is defined by demo:dup and work:dup; neither loads");
    const r = await sb.run(["dup-a"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("isn't loaded");
    expect(await out(["ls"])).not.toContain("dup");

    expect((await sb.run(["remove", "work:dup"])).code).toBe(0);
    expect(await out(["dup-a"])).toBe("demo/dup-a");
    expect((await sb.run(["dup-b"])).stderr).toContain("rig add work:dup");
  });

  test("a user tool named like a core tool is ignored; core keeps it", async () => {
    addTool(sb.user, "greet", ["greet-twin"]);
    const { stdout } = await sb.run(["sync"]);
    expect(stdout).toContain("pack demo: the core pack already defines tool greet, so demo:greet is ignored");
    expect(await out(["greet", "x"])).toBe("hello x");
    expect((await sb.run(["greet-twin"])).code).toBe(1);
  });
});

describe("skills", () => {
  test("a skill collision links neither; disabling one links the other", async () => {
    const work = workPack();
    addSkill(sb.user, "shared");
    addSkill(work, "shared");
    const sync = await sb.run(["sync"]);
    expect(sync.code).toBe(1);
    expect(sync.stdout).toContain("skill shared is defined by demo:shared and work:shared; neither is linked");
    expect(existsSync(join(sb.claude, "shared"))).toBe(false);

    const removed = await sb.run(["remove", "demo:shared"]);
    expect(removed.stdout).toContain("+ shared");
    expect(readlinkSync(join(sb.claude, "shared"))).toBe(join(work, "skills", "shared"));
    expect((await sb.run(["sync"])).code).toBe(0);
  });

  test("against core, the core skill is linked", async () => {
    addSkill(sb.user, "alpha");
    await sb.run(["sync"]);
    expect(readlinkSync(join(sb.claude, "alpha"))).toBe(join(sb.core, "skills", "alpha"));
  });
});

describe("disabled", () => {
  test("remove stores the qualified name", async () => {
    await sb.run(["remove", "beta"]);
    expect(readConfig().disabled).toEqual(["demo:beta"]);
  });

  test("legacy bare entries match every pack and are qualified on the next save", async () => {
    const work = workPack();
    addSkill(work, "beta");
    writeConfig({ disabled: ["beta"] });
    await sb.run(["sync"]);
    expect(existsSync(join(sb.claude, "beta"))).toBe(false);
    expect((await sb.run(["status"])).stdout).toMatch(/beta \(disabled\)[\s\S]*beta \(disabled\)/);

    await sb.run(["remove", "alpha"]);
    expect(readConfig().disabled).toEqual(["demo:beta", "work:beta", "rig:alpha"]);
  });

  test("an ambiguous bare remove fails with the qualified options", async () => {
    addSkill(workPack(), "beta");
    const r = await sb.run(["remove", "beta"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("beta is in more than one pack");
    expect(r.stderr).toContain("rig remove demo:beta, rig remove work:beta");
    expect(existsSync(configFile())).toBe(false);
  });

  test("add takes the one disabled side of a bare name", async () => {
    addSkill(workPack(), "beta");
    await sb.run(["remove", "work:beta"]);
    const r = await sb.run(["add", "beta"]);
    expect(r.stdout).toContain("enabled work:beta");
    expect(readConfig().disabled ?? []).toEqual([]);
  });
});
