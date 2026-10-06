import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, saveConfig, type Config } from "../core/config";
import { depsHash, depsStale, installDeps, peerMismatch } from "../core/deps";
import { CORE_PACK, configPackPath, discoverPacks, type Pack } from "../core/packs";
import { expandHome, tildify } from "../core/paths";
import { isActive, loadRegistry, resetRegistry } from "../core/registry";
import { c, table, takeFlags } from "../core/ui";
import { RigError } from "../sdk";
import { sync } from "./links";

const USAGE = `usage: rig pack <subcommand>

  rig pack ls [--json]          Packs: source, origin, tool and skill counts, dependency state
  rig pack add <path>           Add a pack directory to config "packs", then sync
  rig pack remove <name|path>   Remove a pack from config "packs", then sync (never deletes files)
  rig pack disable <name>       Turn off every tool and skill in a pack, then sync
  rig pack enable <name>        Turn a disabled pack back on, then sync
  rig pack install [pack]       Install npm dependencies (every pack with a package.json by default)

  Scaffold a new pack with: rig new pack <name> [--path <dir>]`;

function findPack(name: string): Pack {
  const { packs } = discoverPacks(loadConfig());
  const pack = packs.find((p) => p.name === name);
  if (!pack) throw new RigError("NOT_FOUND", `no pack named ${name}`, `packs: ${packs.map((p) => p.name).join(", ")}`);
  return pack;
}

function depsState(pack: Pack): string {
  if (depsHash(pack) === undefined) return c.dim("no deps");
  const mismatch = peerMismatch(pack);
  if (mismatch) return c.red(mismatch);
  return depsStale(pack) ? c.yellow("deps stale") : c.green("deps ok");
}

async function list(argv: string[]): Promise<number> {
  const { flags } = takeFlags(argv, ["--json"]);
  const reg = await loadRegistry();
  const counts = (pack: Pack) => ({
    tools: reg.tools.filter((t) => t.pack === pack && isActive(t)).length,
    skills: reg.skills.filter((s) => s.pack === pack && isActive(s)).length,
  });
  if (flags.has("--json")) {
    const data = reg.packs.map((p) => ({
      name: p.name,
      origin: p.origin,
      dir: p.dir,
      disabled: p.disabled,
      ...counts(p),
      deps: depsHash(p) === undefined ? "none" : peerMismatch(p) ? "mismatch" : depsStale(p) ? "stale" : "ok",
    }));
    console.log(JSON.stringify({ ok: true, data }));
    return 0;
  }
  const rows = reg.packs.map((p) => {
    const { tools, skills } = counts(p);
    return [
      p.disabled ? `${p.name} ${c.dim("(disabled)")}` : c.bold(p.name),
      c.dim(p.origin),
      tildify(p.dir),
      p.disabled ? c.dim("-") : `${tools} tool(s), ${skills} skill(s)`,
      p.disabled ? c.dim("-") : depsState(p),
    ];
  });
  console.log(table(rows));
  return 0;
}

/** Saves config, then re-syncs so links match. */
async function saveAndSync(config: Config, message: string): Promise<number> {
  saveConfig(config);
  resetRegistry();
  console.log(`${message}\n`);
  return sync([]);
}

async function add(argv: string[]): Promise<number> {
  const [path] = takeFlags(argv, []).rest;
  if (!path) throw new RigError("USAGE", "usage: rig pack add <path>");
  const dir = resolve(expandHome(path));
  if (!existsSync(dir)) throw new RigError("NOT_FOUND", `${path} doesn't exist`);
  if (!existsSync(resolve(dir, "pack.json"))) throw new RigError("USAGE", `${tildify(dir)} has no pack.json`, "scaffold one with: rig new pack <name> --path <dir>");
  const config = loadConfig();
  if (config.packs.some((entry) => configPackPath(entry) === dir) || discoverPacks(config).packs.some((p) => p.dir === dir)) {
    console.log(`${tildify(dir)} is already a pack source`);
    return 0;
  }
  return saveAndSync({ ...config, packs: [...config.packs, tildify(dir)] }, `added ${c.bold(tildify(dir))}`);
}

async function remove(argv: string[]): Promise<number> {
  const [nameOrPath] = takeFlags(argv, []).rest;
  if (!nameOrPath) throw new RigError("USAGE", "usage: rig pack remove <name|path>");
  const config = loadConfig();
  const pack = discoverPacks(config).packs.find((p) => p.name === nameOrPath);
  const dir = pack?.dir ?? resolve(expandHome(nameOrPath));
  const entries = config.packs.filter((entry) => configPackPath(entry) === dir);
  if (!entries.length) {
    if (pack) {
      throw new RigError(
        "USAGE",
        `pack ${pack.name} isn't listed in config "packs" (it's found in ${tildify(pack.dir)})`,
        `turn it off with: rig pack disable ${pack.name}, or move the directory yourself`,
      );
    }
    throw new RigError("NOT_FOUND", `no pack ${nameOrPath} in config "packs"`, "see: rig pack ls");
  }
  const packs = config.packs.filter((entry) => !entries.includes(entry));
  return saveAndSync({ ...config, packs }, `removed ${c.bold(tildify(dir))} from config; its files are untouched`);
}

async function setDisabled(argv: string[], disable: boolean): Promise<number> {
  const [name] = takeFlags(argv, []).rest;
  if (!name) throw new RigError("USAGE", `usage: rig pack ${disable ? "disable" : "enable"} <name>`);
  const pack = findPack(name);
  if (pack.name === CORE_PACK) throw new RigError("USAGE", "the core pack can't be disabled", "disable one of its skills instead: rig remove rig:<skill>");
  const config = loadConfig();
  if (config.disabledPacks.includes(name) === disable) {
    console.log(`pack ${name} is already ${disable ? "disabled" : "enabled"}`);
    return 0;
  }
  const disabledPacks = disable ? [...config.disabledPacks, name] : config.disabledPacks.filter((n) => n !== name);
  return saveAndSync({ ...config, disabledPacks }, `${disable ? "disabled" : "enabled"} pack ${c.bold(name)}`);
}

async function install(argv: string[]): Promise<number> {
  const { rest } = takeFlags(argv, []);
  const targets = rest.length ? rest.map(findPack) : discoverPacks(loadConfig()).packs.filter((p) => !p.disabled && depsHash(p) !== undefined);
  if (!targets.length) console.log("no packs have dependencies");
  let failed = 0;
  for (const pack of targets) {
    if (depsHash(pack) === undefined) {
      console.log(`${pack.name}: no package.json; nothing to install`);
      continue;
    }
    try {
      await installDeps(pack);
      console.log(`  ${c.green("✓")} ${pack.name}`);
    } catch (err) {
      failed++;
      console.log(`  ${c.red("✗")} ${pack.name}: ${(err as Error).message}`);
    }
  }
  return failed ? 1 : 0;
}

export async function pack(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "ls":
      return list(rest);
    case "add":
      return add(rest);
    case "remove":
      return remove(rest);
    case "disable":
      return setDisabled(rest, true);
    case "enable":
      return setDisabled(rest, false);
    case "install":
      return install(rest);
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    case undefined:
      throw new RigError("USAGE", USAGE);
    default:
      throw new RigError("USAGE", `unknown subcommand rig pack ${sub}`, USAGE);
  }
}
