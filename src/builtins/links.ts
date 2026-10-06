import { activeHarnesses, loadConfig, saveConfig, type Config } from "../core/config";
import { writeSkillFiles } from "../core/generated";
import { lookupVar, readEnvFile } from "../core/env";
import { harnessPath } from "../core/harnesses";
import { instructionLinks } from "../core/instructions";
import { desiredLinks, removeAllLinks, syncLinks, type LinkChange } from "../core/links";
import { expandHome, paths, tildify } from "../core/paths";
import { isActive, loadRegistry, resetRegistry, type Registry, type ResolvedTool } from "../core/registry";
import { c, table, takeFlags } from "../core/ui";
import { RigError } from "../sdk";
import { lstatSync, readlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SYMBOL: Record<LinkChange["action"], string> = {
  created: c.green("+"),
  repaired: c.yellow("~"),
  pruned: c.red("-"),
  unchanged: c.dim("="),
  conflict: c.red("!"),
};

function printChanges(changes: LinkChange[], dryRun: boolean): void {
  const shown = changes.filter((ch) => ch.action !== "unchanged");
  const prefix = dryRun ? c.dim("(dry run) ") : "";
  for (const ch of shown) {
    const label = ch.link.kind === "bin" ? "rig (bin)" : ch.link.name;
    const note = ch.action === "conflict" ? c.dim(` skipped: ${ch.reason}`) : "";
    console.log(`  ${prefix}${SYMBOL[ch.action]} ${label} ${c.dim("→")} ${tildify(ch.link.path)}${note}`);
  }
  const unchanged = changes.length - shown.length;
  if (unchanged) console.log(c.dim(`  ${unchanged} link(s) already up to date`));
}

export function missingAuth(tool: ResolvedTool, file = readEnvFile()): string[] {
  return tool.auth.filter((v) => !v.optional && !lookupVar(v.name, file)).map((v) => v.name);
}

function printProblems(reg: Registry): void {
  if (!reg.problems.length) return;
  console.log(`\n${c.yellow("Problems:")}`);
  for (const p of reg.problems) console.log(`  ${c.yellow("!")} ${p}`);
}

export async function sync(argv: string[]): Promise<number> {
  const { flags } = takeFlags(argv, ["--dry-run"]);
  const dryRun = flags.has("--dry-run");
  const reg = await loadRegistry();
  const generated = await writeSkillFiles(reg, { dryRun });
  const changes = syncLinks(reg, { dryRun });

  const tools = reg.tools.filter(isActive);
  const skills = reg.skills.filter(isActive);
  console.log(c.bold(`rig: ${tools.length} tool(s), ${reg.qualified.size} command(s), ${skills.length} skill(s)`));
  for (const rel of generated) console.log(`  ${dryRun ? c.dim("(dry run) ") : ""}${c.yellow("~")} regenerated ${rel}`);
  printChanges(changes, dryRun);
  printProblems(reg);

  const file = readEnvFile();
  const needAuth = tools.map((t) => [t.name, missingAuth(t, file)] as const).filter(([, m]) => m.length);
  if (needAuth.length) {
    console.log(`\n${c.yellow("Needs auth:")}`);
    for (const [name, missing] of needAuth) console.log(`  ${name} ${c.dim(missing.join(", "))}`);
    console.log(c.dim("  run: rig auth"));
  }

  const onPath = (process.env.PATH ?? "").split(":").includes(paths.binDir);
  if (!onPath) console.log(`\n${c.yellow("!")} ${tildify(paths.binDir)} is not on your PATH; add it so agents can run \`rig\`.`);

  return changes.some((ch) => ch.action === "conflict") || reg.problems.length ? 1 : 0;
}

/** Qualified `<pack>:<name>` forms of every tool/skill a name refers to (bare names match every pack). */
function qualifiedMatches(reg: Registry, name: string): string[] {
  const items = [...reg.tools, ...reg.skills];
  const hits = name.includes(":")
    ? items.filter((item) => `${item.pack.name}:${item.name}` === name)
    : items.filter((item) => item.name === name);
  return [...new Set(hits.map((item) => `${item.pack.name}:${item.name}`))];
}

/** Rewrites legacy bare `disabled` entries as the qualified names they currently match. */
function qualifyDisabled(config: Config, reg: Registry): Config {
  const disabled = config.disabled.flatMap((entry) => {
    if (entry.includes(":")) return [entry];
    const matches = qualifiedMatches(reg, entry);
    return matches.length ? matches : [entry];
  });
  return { ...config, disabled: [...new Set(disabled)] };
}

function pickOne(cmd: "remove" | "add", name: string, matches: string[]): string {
  if (!matches.length) throw new RigError("NOT_FOUND", `no tool or skill named ${name}`, "see: rig status");
  if (matches.length > 1) {
    throw new RigError("USAGE", `${name} is in more than one pack`, `choose one: ${matches.map((m) => `rig ${cmd} ${m}`).join(", ")}`);
  }
  return matches[0]!;
}

const bareName = (qualified: string) => qualified.slice(qualified.indexOf(":") + 1);

export async function remove(argv: string[]): Promise<number> {
  const { flags, rest } = takeFlags(argv, ["--dry-run"]);
  const [name] = rest;
  if (!name) throw new RigError("USAGE", "usage: rig remove <tool-or-skill | pack:name>");
  const reg = await loadRegistry();
  const target = pickOne("remove", name, qualifiedMatches(reg, name));

  const config = qualifyDisabled(loadConfig(), reg);
  if (!config.disabled.includes(target)) config.disabled.push(target);
  const dryRun = flags.has("--dry-run");
  if (!dryRun) saveConfig(config);

  // Re-sync against the new config: target's links are pruned, and a skill it blocked may now link.
  const changes = syncLinks(await loadRegistry(config), { dryRun }).filter((ch) => ch.link.name === bareName(target));

  console.log(`${dryRun ? c.dim("(dry run) ") : ""}disabled ${c.bold(target)}`);
  printChanges(changes, dryRun);
  console.log(c.dim(`  re-enable with: rig add ${target}`));
  return 0;
}

export async function add(argv: string[]): Promise<number> {
  const { rest } = takeFlags(argv, []);
  const [name] = rest;
  if (!name) throw new RigError("USAGE", "usage: rig add <tool-or-skill | pack:name>");
  const reg = await loadRegistry();
  const config = qualifyDisabled(loadConfig(), reg);
  const matches = qualifiedMatches(reg, name);
  const disabled = matches.filter((m) => config.disabled.includes(m));
  if (matches.length && !disabled.length) {
    console.log(`${name} is already enabled`);
    return 0;
  }
  const target = pickOne("add", name, disabled.length ? disabled : matches);
  config.disabled = config.disabled.filter((n) => n !== target);
  saveConfig(config);
  resetRegistry();
  const changes = syncLinks(await loadRegistry()).filter((ch) => ch.link.name === bareName(target));
  console.log(`enabled ${c.bold(target)}`);
  printChanges(changes, false);
  return 0;
}

export async function desync(argv: string[]): Promise<number> {
  const { flags } = takeFlags(argv, ["--dry-run"]);
  const dryRun = flags.has("--dry-run");
  const changes = removeAllLinks({ dryRun });
  if (!changes.length) console.log("nothing to remove");
  else printChanges(changes, dryRun);
  return 0;
}

function linkState(path: string, source: string): string {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === source) return c.green("linked");
    return c.red("conflict");
  } catch {
    return c.dim("not linked");
  }
}

function label(item: { name: string; disabled: boolean; conflict?: string }): string {
  if (item.disabled) return `${item.name} ${c.dim("(disabled)")}`;
  if (item.conflict) return `${item.name} ${c.red("(conflict)")}`;
  return item.name;
}

export async function status(): Promise<number> {
  const reg = await loadRegistry();
  const harnesses = activeHarnesses(loadConfig());
  const withPath = (kind: "skills" | "instructions") =>
    harnesses.flatMap((id) => {
      const p = harnessPath(id, kind);
      return p ? [{ id, path: expandHome(p) }] : [];
    });
  const targets = withPath("skills");
  const bin = desiredLinks(reg).find((l) => l.kind === "bin")!;

  console.log(`${c.bold("root")}  ${tildify(paths.root)}`);
  console.log(`${c.bold("bin")}   ${tildify(bin.path)}  ${linkState(bin.path, bin.source)}\n`);

  console.log(c.bold("Skills"));
  if (reg.skills.length) {
    const header = ["", ...targets.map((t) => c.dim(t.id))];
    const rows = reg.skills.map((s) => [
      label(s),
      ...targets.map((t) => (isActive(s) ? linkState(`${t.path}/${s.name}`, s.dir) : c.dim("-"))),
    ]);
    console.log(table([header, ...rows]));
  } else console.log(c.dim("  none"));

  console.log(`\n${c.bold("Instructions")}  ${c.dim(tildify(paths.instructionsFile))}`);
  if (instructionLinks().length) {
    const rows = withPath("instructions").map((t) => [
      c.dim(t.id),
      tildify(t.path),
      linkState(t.path, paths.instructionsFile),
    ]);
    console.log(table(rows));
  }
  else console.log(c.dim("  none (create instructions/AGENTS.md to link one)"));

  console.log(`\n${c.bold("Tools")}`);
  if (reg.tools.length) {
    const file = readEnvFile();
    const rows = reg.tools.map((t) => {
      const missing = missingAuth(t, file);
      const auth = !t.auth.length ? c.dim("no auth") : missing.length ? c.red(`missing ${missing.join(", ")}`) : c.green("auth ok");
      return [
        label(t),
        c.dim(`${t.commands.length} cmd`),
        isActive(t) ? auth : c.dim("-"),
      ];
    });
    console.log(table(rows));
  } else console.log(c.dim("  none"));

  printProblems(reg);
  return 0;
}
