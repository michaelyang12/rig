import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSkillFiles } from "../src/core/generated";
import type { Pack } from "../src/core/packs";
import type { Registry, ResolvedTool } from "../src/core/registry";

let dir: string;
let packs: Record<"one" | "two", Pack>;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rig-gen-")));
  packs = {
    one: { name: "one", dir: join(dir, "one"), origin: "config dir" },
    two: { name: "two", dir: join(dir, "two"), origin: "config dir" },
  };
  for (const pack of Object.values(packs)) {
    mkdirSync(join(pack.dir, "skills", "gen"), { recursive: true });
    writeFileSync(join(pack.dir, "skills", "gen", "SKILL.md"), "---\nname: gen\ndescription: x\n---\n");
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const registry = (name: string, files: Record<string, string | undefined>, pack = packs.one): Registry => ({
  packs: Object.values(packs),
  tools: [{ name, pack, disabled: false, skillFiles: () => files } as unknown as ResolvedTool],
  skills: [],
  commands: new Map(),
  problems: [],
});

describe("writeSkillFiles", () => {
  test("writes changed files only, and skips undefined ones", async () => {
    const reg = registry("gen", { "reference.md": "v1", "absent.md": undefined });
    expect(await writeSkillFiles(reg)).toEqual(["one/skills/gen/reference.md"]);
    expect(readFileSync(join(packs.one.dir, "skills", "gen", "reference.md"), "utf8")).toBe("v1");
    expect(await writeSkillFiles(reg)).toEqual([]);
    expect(existsSync(join(packs.one.dir, "skills", "gen", "absent.md"))).toBe(false);
  });

  test("writes into the tool's own pack", async () => {
    await writeSkillFiles(registry("gen", { "a.md": "x" }, packs.two));
    expect(existsSync(join(packs.two.dir, "skills", "gen", "a.md"))).toBe(true);
    expect(existsSync(join(packs.one.dir, "skills", "gen", "a.md"))).toBe(false);
  });

  test("dry run writes nothing", async () => {
    expect(await writeSkillFiles(registry("gen", { "a.md": "x" }), { dryRun: true })).toEqual(["one/skills/gen/a.md"]);
    expect(existsSync(join(packs.one.dir, "skills", "gen", "a.md"))).toBe(false);
  });

  test("rejects paths outside the skill, SKILL.md itself, and tools without a skill", async () => {
    const reg = registry("gen", { "../evil.md": "x", "SKILL.md": "x" });
    expect(await writeSkillFiles(reg)).toEqual([]);
    expect(reg.problems).toHaveLength(2);
    const orphan = registry("nope", { "a.md": "x" });
    await writeSkillFiles(orphan);
    expect(orphan.problems[0]).toContain("needs skills/nope/SKILL.md");
  });
});
