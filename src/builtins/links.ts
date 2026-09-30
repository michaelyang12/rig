import { loadConfig, saveConfig, targetDirs } from "../core/config";
import { ENTRY_SKILL, writeEntrySkill } from "../core/entry";
import { writeSkillFiles } from "../core/generated";
import { lookupVar, readEnvFile } from "../core/env";
import { instructionLinks } from "../core/instructions";
import { desiredLinks, removeAllLinks, syncLinks, type LinkChange } from "../core/links";
import { paths, tildify } from "../core/paths";
import { loadRegistry, resetRegistry, type Registry, type ResolvedTool } from "../core/registry";
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
  let reg = await loadRegistry();
  const regenerated = writeEntrySkill(reg, { dryRun });
  if (regenerated && !dryRun) {
    resetRegistry();
    reg = await loadRegistry();
  }
  const generated = await writeSkillFiles(reg, { dryRun });
  const changes = syncLinks(reg, { dryRun });

  const tools = reg.tools.filter((t) => !t.disabled);
  const skills = reg.skills.filter((s) => !s.disabled);
  console.log(c.bold(`rig: ${tools.length} tool(s), ${reg.commands.size} command(s), ${skills.length} skill(s)`));
  if (regenerated) console.log(`  ${dryRun ? c.dim("(dry run) ") : ""}${c.yellow("~")} regenerated ${ENTRY_SKILL} from ${reg.commands.size} command(s)`);
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

function knownName(reg: Registry, name: string): boolean {
  return reg.tools.some((t) => t.name === name) || reg.skills.some((s) => s.name === name);
}

export async function remove(argv: string[]): Promise<number> {
  const { flags, rest } = takeFlags(argv, ["--dry-run"]);
  const [name] = rest;
  if (!name) throw new RigError("USAGE", "usage: rig remove <tool-or-skill>");
  const reg = await loadRegistry();
  if (!knownName(reg, name)) throw new RigError("NOT_FOUND", `no tool or skill named ${name}`, "see: rig status");

  const config = loadConfig();
  if (!config.disabled.includes(name)) config.disabled.push(name);
  const dryRun = flags.has("--dry-run");
  if (!dryRun) saveConfig(config);

  // Re-sync with the name disabled so its links are pruned.
  for (const t of reg.tools) if (t.name === name) t.disabled = true;
  for (const s of reg.skills) if (s.name === name) s.disabled = true;
  for (const [cmd, def] of reg.commands) if (def.tool.name === name) reg.commands.delete(cmd);
  writeEntrySkill(reg, { dryRun });
  const changes = syncLinks(reg, { dryRun }).filter((ch) => ch.link.name === name);

  console.log(`${dryRun ? c.dim("(dry run) ") : ""}disabled ${c.bold(name)}`);
  printChanges(changes, dryRun);
  console.log(c.dim(`  re-enable with: rig add ${name}`));
  return 0;
}

export async function add(argv: string[]): Promise<number> {
  const { rest } = takeFlags(argv, []);
  const [name] = rest;
  if (!name) throw new RigError("USAGE", "usage: rig add <tool-or-skill>");
  const config = loadConfig();
  if (!config.disabled.includes(name)) {
    const reg = await loadRegistry();
    if (!knownName(reg, name)) throw new RigError("NOT_FOUND", `no tool or skill named ${name}`);
    console.log(`${name} is already enabled`);
    return 0;
  }
  config.disabled = config.disabled.filter((n) => n !== name);
  saveConfig(config);
  resetRegistry();
  const reg = await loadRegistry();
  writeEntrySkill(reg);
  const changes = syncLinks(reg).filter((ch) => ch.link.name === name);
  console.log(`enabled ${c.bold(name)}`);
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

export async function status(): Promise<number> {
  const reg = await loadRegistry();
  const targets = targetDirs(loadConfig());
  const bin = desiredLinks(reg).find((l) => l.kind === "bin")!;

  console.log(`${c.bold("root")}  ${tildify(paths.root)}`);
  console.log(`${c.bold("bin")}   ${tildify(bin.path)}  ${linkState(bin.path, bin.source)}\n`);

  console.log(c.bold("Skills"));
  if (reg.skills.length) {
    const header = ["", ...targets.map((t) => c.dim(tildify(t)))];
    const rows = reg.skills.map((s) => [
      s.disabled ? `${s.name} ${c.dim("(disabled)")}` : s.name,
      ...targets.map((t) => (s.disabled ? c.dim("-") : linkState(`${t}/${s.name}`, s.dir))),
    ]);
    console.log(table([header, ...rows]));
  } else console.log(c.dim("  none"));

  console.log(`\n${c.bold("Instructions")}  ${c.dim(tildify(paths.instructionsFile))}`);
  const instructions = instructionLinks();
  if (instructions.length) console.log(table(instructions.map((l) => [tildify(l.path), linkState(l.path, l.source)])));
  else console.log(c.dim("  none (create instructions/AGENTS.md to link one)"));

  console.log(`\n${c.bold("Tools")}`);
  if (reg.tools.length) {
    const file = readEnvFile();
    const rows = reg.tools.map((t) => {
      const missing = missingAuth(t, file);
      const auth = !t.auth.length ? c.dim("no auth") : missing.length ? c.red(`missing ${missing.join(", ")}`) : c.green("auth ok");
      return [
        t.disabled ? `${t.name} ${c.dim("(disabled)")}` : t.name,
        c.dim(`${t.commands.length} cmd`),
        t.disabled ? c.dim("-") : auth,
      ];
    });
    console.log(table(rows));
  } else console.log(c.dim("  none"));

  printProblems(reg);
  return 0;
}
