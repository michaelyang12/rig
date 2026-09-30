import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import blueprint, { blueprintDirs, listBlueprints, matchBlueprints } from "../tools/blueprint";

let vault: string;
const ctxWith = (env: Record<string, string>) => ({
  tool: "blueprint",
  env: (name: string) => env[name],
  secret: () => "",
  log: () => {},
});
const cmd = (name: keyof typeof blueprint.commands) => blueprint.commands[name].run as (args: any, ctx: any) => any;

function note(dir: string, name: string, ageDays = 0) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, `# ${name}\n`);
  const t = Date.now() / 1000 - ageDays * 86400;
  utimesSync(path, t, t);
  return path;
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "blueprint-vault-"));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("blueprint", () => {
  test("reads both vault folders, writes to Blueprints/, BLUEPRINT_DIR overrides", () => {
    expect(blueprintDirs(ctxWith({ OBSIDIAN_VAULT: vault }))).toEqual({
      write: join(vault, "Blueprints"),
      read: [join(vault, "Blueprints"), join(vault, "Projects", "Blueprints")],
    });
    expect(blueprintDirs(ctxWith({ OBSIDIAN_VAULT: vault, BLUEPRINT_DIR: "/x" }))).toEqual({ write: "/x", read: ["/x"] });
    expect(() => blueprintDirs(ctxWith({}))).toThrow("OBSIDIAN_VAULT is not set");
  });

  test("ls lists markdown across folders, newest first", () => {
    note(join(vault, "Projects", "Blueprints"), "keeper", 30);
    note(join(vault, "Blueprints"), "loom", 1);
    writeFileSync(join(vault, "Blueprints", "image.png"), "");
    const list = cmd("blueprint-ls")({}, ctxWith({ OBSIDIAN_VAULT: vault })) as { name: string }[];
    expect(list.map((b) => b.name)).toEqual(["loom", "keeper"]);
    expect(cmd("blueprint-ls")({ query: "KEE" }, ctxWith({ OBSIDIAN_VAULT: vault })).length).toBe(1);
  });

  test("read resolves an exact name and errors on no match", () => {
    note(join(vault, "Blueprints"), "keeper");
    const ctx = ctxWith({ OBSIDIAN_VAULT: vault });
    expect(cmd("blueprint-read")({ name: "keeper" }, ctx).content).toBe("# keeper\n");
    expect(() => cmd("blueprint-read")({ name: "nope" }, ctx)).toThrow('no blueprint matches "nope"');
  });

  test("path is dated, creates the dir, and offers a free revision on collision", () => {
    const ctx = ctxWith({ OBSIDIAN_VAULT: vault });
    const first = cmd("blueprint-path")({ slug: "keeper", date: "2026-05-16" }, ctx);
    expect(first).toEqual({ path: join(vault, "Blueprints", "keeper-2026-05-16.md"), exists: false, revision: first.path });
    expect(existsSync(join(vault, "Blueprints"))).toBe(true);

    writeFileSync(first.path, "");
    writeFileSync(join(vault, "Blueprints", "keeper-2026-05-16-v2.md"), "");
    const again = cmd("blueprint-path")({ slug: "keeper", date: "2026-05-16" }, ctx);
    expect(again.exists).toBe(true);
    expect(again.revision).toBe(join(vault, "Blueprints", "keeper-2026-05-16-v3.md"));
  });

  test("matchBlueprints: exact name wins", () => {
    const all = listBlueprints([]).concat([
      { name: "keeper", path: "/a/keeper.md", modified: "" },
      { name: "keeper-2026-05-16", path: "/a/keeper-2026-05-16.md", modified: "" },
    ]);
    expect(matchBlueprints(all, "keeper").map((b) => b.name)).toEqual(["keeper"]);
  });
});
