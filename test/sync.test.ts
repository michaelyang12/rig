import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const isLinkTo = (path: string, target: string) => lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;

describe("sync", () => {
  test("links every skill into both targets and rig onto PATH", async () => {
    const { code, stdout } = await sb.run(["sync"]);
    expect(code).toBe(0);
    for (const target of [sb.claude, sb.agents]) {
      expect(isLinkTo(join(target, "alpha"), join(sb.root, "skills", "alpha"))).toBe(true);
      expect(isLinkTo(join(target, "beta"), join(sb.root, "skills", "beta"))).toBe(true);
    }
    expect(isLinkTo(sb.bin, join(sb.root, "bin", "rig"))).toBe(true);
    expect(stdout).toContain("3 tool(s)");
    expect(stdout).toContain("Needs auth");
  });

  test("is idempotent", async () => {
    await sb.run(["sync"]);
    const { code, stdout } = await sb.run(["sync"]);
    expect(code).toBe(0);
    expect(stdout).toContain("7 link(s) already up to date");
    expect(stdout).not.toContain("regenerated");
    expect(stdout).not.toContain("+ ");
  });

  test("--dry-run writes nothing", async () => {
    const { stdout } = await sb.run(["sync", "--dry-run"]);
    expect(stdout).toContain("(dry run) + alpha");
    expect(existsSync(sb.claude)).toBe(false);
    expect(existsSync(sb.bin)).toBe(false);
    expect(existsSync(join(sb.home, ".local", "state"))).toBe(false);
  });

  test("never clobbers a foreign directory", async () => {
    mkdirSync(join(sb.claude, "alpha"), { recursive: true });
    writeFileSync(join(sb.claude, "alpha", "SKILL.md"), "mine");
    const { code, stdout } = await sb.run(["sync"]);
    expect(code).toBe(1);
    expect(stdout).toContain("! alpha");
    expect(lstatSync(join(sb.claude, "alpha")).isDirectory()).toBe(true);
    expect(isLinkTo(join(sb.agents, "alpha"), join(sb.root, "skills", "alpha"))).toBe(true);
  });

  test("prunes links for deleted skills", async () => {
    await sb.run(["sync"]);
    rmSync(join(sb.root, "skills", "beta"), { recursive: true });
    const { stdout } = await sb.run(["sync"]);
    expect(stdout).toContain("- beta");
    expect(existsSync(join(sb.claude, "beta"))).toBe(false);
    expect(existsSync(join(sb.claude, "alpha"))).toBe(true);
  });

  test("repairs its own links when the repo moves", async () => {
    await sb.run(["sync"]);
    const moved = join(sb.dir, "moved");
    cpSync(sb.root, moved, { recursive: true, verbatimSymlinks: true });
    const { stdout } = await sb.run(["sync"], { env: { RIG_ROOT: moved } });
    expect(stdout).toContain("~ alpha");
    expect(isLinkTo(join(sb.claude, "alpha"), join(moved, "skills", "alpha"))).toBe(true);
  });

  test("dropping a harness prunes its links and keeps the rest", async () => {
    // Same path change a harness move causes: unwanted links pruned, wanted ones untouched.
    await sb.run(["sync"]);
    writeConfig({ harnesses: ["codex"] });
    const { code, stdout } = await sb.run(["sync"]);
    expect(code).toBe(0);
    expect(stdout).toContain("- alpha → ~/.claude/skills/alpha");
    expect(existsSync(join(sb.claude, "alpha"))).toBe(false);
    expect(isLinkTo(join(sb.agents, "alpha"), join(sb.root, "skills", "alpha"))).toBe(true);
  });

  test("links the harnesses named in config, in any case, plus the always-on ones", async () => {
    writeConfig({ harnesses: ["CODEX"] });
    mkdirSync(join(sb.root, "instructions"), { recursive: true });
    writeFileSync(join(sb.root, "instructions", "AGENTS.md"), "# rules\n");
    const { code } = await sb.run(["sync"]);
    expect(code).toBe(0);
    expect(isLinkTo(join(sb.agents, "alpha"), join(sb.root, "skills", "alpha"))).toBe(true);
    expect(lstatSync(sb.harness("codex", "instructions")).isSymbolicLink()).toBe(true);
    expect(existsSync(sb.claude)).toBe(false);
    expect(existsSync(sb.harness("claude", "instructions"))).toBe(false);
  });

  test("an empty harness list still links the always-on ones", async () => {
    writeConfig({ harnesses: [] });
    expect((await sb.run(["sync"])).code).toBe(0);
    expect(isLinkTo(join(sb.agents, "alpha"), join(sb.root, "skills", "alpha"))).toBe(true);
    expect(existsSync(sb.claude)).toBe(false);
  });

  test("rejects an unknown harness name", async () => {
    writeConfig({ harnesses: ["claude", "cladue"] });
    const { code, stderr } = await sb.run(["sync"]);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown harness "cladue"');
    expect(stderr).toContain("valid: claude, codex (always linked: agents)");
  });

  test("status labels targets by harness", async () => {
    await sb.run(["sync"]);
    const { stdout } = await sb.run(["status"]);
    expect(stdout).toMatch(/\s+claude\s+agents\n/);
  });

  test("reports broken tools without breaking the rest", async () => {
    mkdirSync(join(sb.root, "tools", "bad"));
    writeFileSync(
      join(sb.root, "tools", "bad", "index.ts"),
      `export default { name: "bad", description: "x", auth: [{ name: "WRONG_URL", prompt: "x" }], commands: {} };`,
    );
    const { code, stdout } = await sb.run(["sync"]);
    expect(code).toBe(1);
    expect(stdout).toContain("tool bad: auth var WRONG_URL must be prefixed with BAD_");
    expect((await sb.run(["greet", "x"])).stdout).toBe("hello x\n");
  });
});

describe("remove / add", () => {
  test("remove unlinks, persists across sync, and add restores", async () => {
    await sb.run(["sync"]);
    let r = await sb.run(["remove", "alpha"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(sb.claude, "alpha"))).toBe(false);
    expect(existsSync(join(sb.agents, "alpha"))).toBe(false);

    await sb.run(["sync"]);
    expect(existsSync(join(sb.claude, "alpha"))).toBe(false);
    expect((await sb.run(["status"])).stdout).toContain("alpha (disabled)");

    r = await sb.run(["add", "alpha"]);
    expect(r.code).toBe(0);
    expect(isLinkTo(join(sb.claude, "alpha"), join(sb.root, "skills", "alpha"))).toBe(true);
  });

  test("remove saves only the disabled list, not default harness paths", async () => {
    await sb.run(["remove", "alpha"]);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ disabled: ["alpha"] });
  });

  test("removing a tool disables its commands", async () => {
    await sb.run(["remove", "greet"]);
    const r = await sb.run(["greet", "bob"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("rig add greet");
    expect((await sb.run(["ls"])).stdout).not.toContain("greet");
  });

  test("unknown names are rejected", async () => {
    const r = await sb.run(["remove", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no tool or skill named nope");
  });
});

describe("desync", () => {
  test("removes only links rig created", async () => {
    await sb.run(["sync"]);
    const foreign = join(sb.claude, "someone-elses");
    symlinkSync(join(sb.dir), foreign);
    const { code } = await sb.run(["desync"]);
    expect(code).toBe(0);
    expect(existsSync(join(sb.claude, "alpha"))).toBe(false);
    expect(lstatSync(sb.bin).isSymbolicLink()).toBe(true);
    expect(lstatSync(foreign).isSymbolicLink()).toBe(true);
    expect((await sb.run(["desync"])).stdout).toContain("nothing to remove");
  });

  test("leaves a path alone if the user replaced rig's link", async () => {
    await sb.run(["sync"]);
    rmSync(join(sb.claude, "alpha"));
    mkdirSync(join(sb.claude, "alpha"));
    await sb.run(["desync"]);
    expect(lstatSync(join(sb.claude, "alpha")).isDirectory()).toBe(true);
  });
});

describe("instructions", () => {
  const writeSource = (text = "# rules\n") => {
    mkdirSync(join(sb.root, "instructions"), { recursive: true });
    writeFileSync(join(sb.root, "instructions", "AGENTS.md"), text);
  };
  const source = () => join(sb.root, "instructions", "AGENTS.md");
  const claudeMd = () => sb.harness("claude", "instructions");
  const codexMd = () => sb.harness("codex", "instructions");

  test("links the source into every harness", async () => {
    writeSource();
    const { code, stdout } = await sb.run(["sync"]);
    expect(code).toBe(0);
    expect(stdout).toContain("+ instructions → ~/.claude/CLAUDE.md");
    expect(isLinkTo(claudeMd(), source())).toBe(true);
    expect(isLinkTo(codexMd(), source())).toBe(true);
    expect((await sb.run(["sync"])).stdout).toContain("9 link(s) already up to date");
  });

  test("links nothing without a source file", async () => {
    await sb.run(["sync"]);
    expect(existsSync(claudeMd())).toBe(false);
    expect((await sb.run(["status"])).stdout).toContain("none (create instructions/AGENTS.md");
  });

  test("--dry-run writes nothing", async () => {
    writeSource();
    const { stdout } = await sb.run(["sync", "--dry-run"]);
    expect(stdout).toContain("(dry run) + instructions → ~/.codex/AGENTS.md");
    expect(existsSync(claudeMd())).toBe(false);
    expect(existsSync(codexMd())).toBe(false);
  });

  test("never clobbers a real file", async () => {
    writeSource();
    mkdirSync(dirname(claudeMd()), { recursive: true });
    writeFileSync(claudeMd(), "mine");
    const { code, stdout } = await sb.run(["sync"]);
    expect(code).toBe(1);
    expect(stdout).toContain("! instructions → ~/.claude/CLAUDE.md skipped: existing file or directory");
    expect(lstatSync(claudeMd()).isFile()).toBe(true);
    expect(isLinkTo(codexMd(), source())).toBe(true);
    expect((await sb.run(["status"])).stdout).toMatch(/~\/\.claude\/CLAUDE\.md\s+conflict/);
  });

  test("never replaces someone else's symlink", async () => {
    writeSource();
    const theirs = join(sb.dir, "dotfiles-CLAUDE.md");
    writeFileSync(theirs, "theirs");
    mkdirSync(dirname(claudeMd()), { recursive: true });
    symlinkSync(theirs, claudeMd());
    const { code, stdout } = await sb.run(["sync"]);
    expect(code).toBe(1);
    expect(stdout).toContain(`skipped: symlink to ${theirs}`);
    expect(isLinkTo(claudeMd(), theirs)).toBe(true);
  });

  test("prunes links when the source is removed", async () => {
    writeSource();
    await sb.run(["sync"]);
    rmSync(source());
    const { stdout } = await sb.run(["sync"]);
    expect(stdout).toContain("- instructions → ~/.claude/CLAUDE.md");
    expect(existsSync(claudeMd())).toBe(false);
    expect(existsSync(codexMd())).toBe(false);
  });

  test("status and desync", async () => {
    writeSource();
    await sb.run(["sync"]);
    expect((await sb.run(["status"])).stdout).toMatch(/codex\s+~\/\.codex\/AGENTS\.md\s+linked/);
    await sb.run(["desync"]);
    expect(existsSync(claudeMd())).toBe(false);
    expect(existsSync(codexMd())).toBe(false);
    expect(existsSync(source())).toBe(true);
  });
});

describe("config", () => {
  test("prints harnesses without a terminal", async () => {
    writeConfig({ harnesses: ["claude"] });
    const { code, stdout } = await sb.run(["config"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/claude\s+on/);
    expect(stdout).toMatch(/codex\s+off/);
    expect(stdout).toMatch(/agents\s+always/);
    expect(stdout).toContain("rig config harnesses <name>");
  });

  test("harnesses <names> saves and syncs", async () => {
    await sb.run(["sync"]);
    const { code, stdout } = await sb.run(["config", "harnesses", "CODEX"]);
    expect(code).toBe(0);
    expect(stdout).toContain("- alpha → ~/.claude/skills/alpha");
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ harnesses: ["codex"] });
    expect(existsSync(join(sb.claude, "alpha"))).toBe(false);
    expect(existsSync(join(sb.agents, "alpha"))).toBe(true);
  });

  test("harnesses none keeps only the always-on ones", async () => {
    await sb.run(["sync"]);
    expect((await sb.run(["config", "harnesses", "none"])).code).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ harnesses: [] });
    expect(existsSync(join(sb.claude, "alpha"))).toBe(false);
    expect(existsSync(join(sb.agents, "alpha"))).toBe(true);
  });

  test("selecting every harness stores nothing", async () => {
    await sb.run(["config", "harnesses", "agents", "claude", "codex"]);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({});
  });

  test("rejects bad input without saving", async () => {
    for (const args of [["harnesses", "cladue"], ["harnesses"], ["targets"]]) {
      const { code } = await sb.run(["config", ...args]);
      expect(code).toBe(2);
    }
    expect(existsSync(configFile())).toBe(false);
  });
});
