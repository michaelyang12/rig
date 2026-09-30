import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { defineCommand, defineTool, RigError, type Context } from "rig";

export interface Blueprint {
  name: string;
  path: string;
  modified: string;
}

/**
 * Where blueprints live. BLUEPRINT_DIR overrides everything; otherwise new ones go to
 * $OBSIDIAN_VAULT/Blueprints and the older $OBSIDIAN_VAULT/Projects/Blueprints is still read.
 */
export function blueprintDirs(ctx: Pick<Context, "env">): { write: string; read: string[] } {
  const override = ctx.env("BLUEPRINT_DIR");
  if (override) return { write: override, read: [override] };
  const vault = ctx.env("OBSIDIAN_VAULT");
  if (!vault) {
    throw new RigError("USAGE", "OBSIDIAN_VAULT is not set", "export OBSIDIAN_VAULT, or set BLUEPRINT_DIR to a directory");
  }
  const write = join(vault, "Blueprints");
  return { write, read: [write, join(vault, "Projects", "Blueprints")] };
}

export function listBlueprints(dirs: string[]): Blueprint[] {
  const out: Blueprint[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      const path = join(dir, file);
      out.push({ name: basename(file, ".md"), path, modified: statSync(path).mtime.toISOString() });
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * Narrow blueprints to the ones a user-typed name refers to ("keeper", "loom", "ml-bench-2026-05-22").
 * Return one element for a confident match, several if ambiguous, none if nothing fits.
 * `all` is sorted newest first.
 */
export function matchBlueprints(all: Blueprint[], query: string): Blueprint[] {
  // TODO: decide how a query resolves to a blueprint.
  return all.filter((b) => b.name === query);
}

function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatList(list: Blueprint[]): string {
  return list.map((b) => `${b.name}\t${b.path}`).join("\n");
}

export default defineTool({
  name: "blueprint",
  description:
    "Find, read, and place project blueprints (design docs / implementation plans) in the user's Obsidian vault. Use when the user refers to a blueprint or wants to build, revisit, or write one",
  commands: {
    "blueprint-ls": defineCommand({
      description: "List blueprints, newest first, as `name<TAB>path` lines",
      args: z.object({
        query: z.string().optional().describe("Only blueprints whose name contains this (case-insensitive)"),
      }),
      positional: ["query"],
      run({ query }, ctx) {
        const all = listBlueprints(blueprintDirs(ctx).read);
        return query ? all.filter((b) => b.name.toLowerCase().includes(query.toLowerCase())) : all;
      },
      format: formatList,
    }),

    "blueprint-read": defineCommand({
      description: "Print a blueprint's markdown by name (e.g. `keeper`); errors with the candidates if ambiguous",
      args: z.object({ name: z.string().describe("Blueprint name, or a path to one") }),
      positional: ["name"],
      run({ name }, ctx) {
        if (name.endsWith(".md") && existsSync(name)) return { path: name, content: readFileSync(name, "utf8") };
        const all = listBlueprints(blueprintDirs(ctx).read);
        const hits = matchBlueprints(all, name);
        if (hits.length === 0) {
          throw new RigError("NOT_FOUND", `no blueprint matches "${name}"`, "list them with: rig blueprint-ls");
        }
        if (hits.length > 1) {
          throw new RigError("USAGE", `"${name}" matches ${hits.length} blueprints: ${hits.map((b) => b.name).join(", ")}`, "use a more specific name");
        }
        const [hit] = hits as [Blueprint];
        return { path: hit.path, content: readFileSync(hit.path, "utf8") };
      },
      format: (r: { content: string }) => r.content,
    }),

    "blueprint-path": defineCommand({
      description:
        "Get the file path to write a new blueprint to (<slug>-YYYY-MM-DD.md), creating the directory. Reports whether that file already exists and the next free revision path",
      args: z.object({
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase kebab-case").describe("Project slug, e.g. keeper"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date to stamp (default: today, local time)"),
      }),
      positional: ["slug"],
      run({ slug, date }, ctx) {
        const dir = blueprintDirs(ctx).write;
        mkdirSync(dir, { recursive: true });
        const stem = `${slug}-${date ?? localDate()}`;
        const path = join(dir, `${stem}.md`);
        let revision = path;
        for (let v = 2; existsSync(revision); v++) revision = join(dir, `${stem}-v${v}.md`);
        return { path, exists: existsSync(path), revision };
      },
      format: (r: { path: string; exists: boolean; revision: string }) =>
        r.exists ? `${r.path}\nexists: yes (next free: ${r.revision})` : r.path,
    }),
  },
});
