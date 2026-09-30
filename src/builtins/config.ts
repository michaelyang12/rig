import { activeHarnesses, loadConfig, parseHarnesses, saveConfig, type Config } from "../core/config";
import { ALWAYS_HARNESS_IDS, HARNESS_IDS, OPTIONAL_HARNESS_IDS, harnessPath, type HarnessId } from "../core/harnesses";
import { paths, tildify } from "../core/paths";
import { c, table } from "../core/ui";
import { RigError } from "../sdk";
import { sync } from "./links";

const USAGE = "usage: rig config [harnesses <name>... | none]";

function describe(id: HarnessId): string {
  return [harnessPath(id, "skills"), harnessPath(id, "instructions")].filter(Boolean).join(", ");
}

function printConfig(config: Config): void {
  const active = activeHarnesses(config);
  console.log(`${c.bold("Harnesses")}  ${c.dim(tildify(paths.configFile))}`);
  const rows = HARNESS_IDS.map((id) => [
    id,
    ALWAYS_HARNESS_IDS.includes(id) ? c.green("always") : active.includes(id) ? c.green("on") : c.dim("off"),
    c.dim(describe(id)),
  ]);
  console.log(table(rows));
  console.log(`\n${c.bold("Disabled")}  ${config.disabled.length ? config.disabled.join(", ") : c.dim("none")}`);
}

/** Saves the harness choice and re-syncs so links match it. */
async function setHarnesses(config: Config, harnesses: HarnessId[]): Promise<number> {
  saveConfig({ ...config, harnesses });
  console.log(`harnesses: ${activeHarnesses({ ...config, harnesses }).join(", ")}\n`);
  return sync([]);
}

/** `rig config harnesses a b` or `rig config harnesses none`; a bare key is a usage error. */
function harnessArgs(values: string[]): HarnessId[] {
  if (!values.length) throw new RigError("USAGE", "name at least one harness, or none", USAGE);
  if (values.length === 1 && values[0]!.toLowerCase() === "none") return [];
  return parseHarnesses(values, "given");
}

export async function config(argv: string[]): Promise<number> {
  const [key, ...values] = argv;
  const current = loadConfig();

  if (key === "harnesses") return setHarnesses(current, harnessArgs(values));
  if (key !== undefined) throw new RigError("USAGE", `unknown config key ${key}`, USAGE);

  if (!process.stdin.isTTY) {
    printConfig(current);
    console.log(c.dim(`\n  change with: rig config harnesses <name>... (or run rig config in a terminal)`));
    return 0;
  }

  const p = await import("@clack/prompts");
  p.intro(c.bold(" rig config "));
  p.note(ALWAYS_HARNESS_IDS.map((id) => `${id}  ${describe(id)}`).join("\n"), "Always linked");
  const chosen = await p.multiselect({
    message: "Which harnesses should rig also link into?",
    options: OPTIONAL_HARNESS_IDS.map((id) => ({ value: id, label: id, hint: describe(id) })),
    initialValues: current.harnesses,
    required: false,
  });
  if (p.isCancel(chosen)) {
    p.cancel("No changes.");
    return 0;
  }
  const harnesses = parseHarnesses(chosen, "selected");
  if (harnesses.join() === current.harnesses.join()) {
    p.outro("No changes.");
    return 0;
  }
  p.outro("Saved. Syncing links…");
  return setHarnesses(current, harnesses);
}
