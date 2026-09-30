import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderDescription } from "../src/core/entry";
import { parseFrontmatter, type Registry, type ResolvedTool } from "../src/core/registry";
import { sandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const entryFile = () => join(sb.root, "skills", "rig-entryexec", "SKILL.md");

describe("rig-entryexec", () => {
  test("sync generates it from the registry and links it everywhere", async () => {
    const { stdout } = await sb.run(["sync"]);
    expect(stdout).toContain("~ regenerated rig-entryexec from 5 command(s)");
    expect(readlinkSync(join(sb.claude, "rig-entryexec"))).toBe(join(sb.root, "skills", "rig-entryexec"));
    expect(readlinkSync(join(sb.agents, "rig-entryexec"))).toBe(join(sb.root, "skills", "rig-entryexec"));

    const text = readFileSync(entryFile(), "utf8");
    const fm = parseFrontmatter(text);
    expect(fm.name).toBe("rig-entryexec");
    expect(fm.description).toContain("Use proactively");
    expect(fm.description).toContain("greet, greet-obj (Greets people)");
    expect(text).toContain("- `rig greet <name>`: Say hello");
    expect(text).toContain("`--times`");
    expect(text).toContain("Needs credentials (ACME_API_KEY, ACME_BASE_URL)");
    expect(text).toContain("- `alpha`: Alpha skill for tests.");
  });

  test("is only rewritten when the registry changes", async () => {
    await sb.run(["sync"]);
    const before = statSync(entryFile()).mtimeMs;
    await Bun.sleep(20);
    await sb.run(["sync"]);
    expect(statSync(entryFile()).mtimeMs).toBe(before);
  });

  test("drops removed tools and restores them on add", async () => {
    await sb.run(["sync"]);
    await sb.run(["remove", "greet"]);
    expect(readFileSync(entryFile(), "utf8")).not.toContain("rig greet");
    await sb.run(["add", "greet"]);
    expect(readFileSync(entryFile(), "utf8")).toContain("rig greet");
  });

  test("--dry-run does not write it", async () => {
    const { stdout } = await sb.run(["sync", "--dry-run"]);
    expect(stdout).toContain("(dry run) ~ regenerated rig-entryexec");
    expect(existsSync(entryFile())).toBe(false);
  });

  test("description stays within the 1024-char skill limit", () => {
    const tools: ResolvedTool[] = Array.from({ length: 150 }, (_, i) => {
      const tool = { name: `tool${i}`, description: "x".repeat(80), disabled: false, auth: [], commands: [] } as unknown as ResolvedTool;
      tool.commands = [{ name: `tool${i}-run`, tool } as never];
      return tool;
    });
    const reg = { tools, skills: [], problems: [], commands: new Map(tools.map((t) => [t.commands[0]!.name, t.commands[0]!])) } as Registry;
    const desc = renderDescription(reg);
    expect(desc.length).toBeLessThanOrEqual(1024);
    expect(desc).toContain("rig ls");
  });
});
