import { loadConfig } from "../core/config";
import { installDeps, depsHash } from "../core/deps";
import { discoverPacks, type Pack } from "../core/packs";
import { resetRegistry } from "../core/registry";
import { c, takeFlags } from "../core/ui";
import { RigError } from "../sdk";

const USAGE = `usage: rig pack <subcommand>

  rig pack install [pack]   Install a pack's npm dependencies (all packs with a package.json by default)`;

function findPack(name: string): Pack {
  const { packs } = discoverPacks(loadConfig());
  const pack = packs.find((p) => p.name === name);
  if (!pack) throw new RigError("NOT_FOUND", `no pack named ${name}`, `packs: ${packs.map((p) => p.name).join(", ")}`);
  return pack;
}

async function install(argv: string[]): Promise<number> {
  const { rest } = takeFlags(argv, []);
  const targets = rest.length ? rest.map(findPack) : discoverPacks(loadConfig()).packs.filter((p) => depsHash(p) !== undefined);
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
  if (!targets.length) console.log("no packs have dependencies");
  resetRegistry();
  return failed ? 1 : 0;
}

export async function pack(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "install") return install(rest);
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return sub ? 0 : 2;
  }
  throw new RigError("USAGE", `unknown subcommand rig pack ${sub}`, USAGE);
}
