import { loadConfig, parseHarnesses, saveConfig, type Config } from "../core/config";
import { HARNESS_IDS, harnessPath, type HarnessId } from "../core/harnesses";
import { paths, tildify } from "../core/paths";
import { c, table } from "../core/ui";
import { RigError } from "../sdk";
import { sync } from "./links";

const USAGE = "usage: rig config [harnesses <name>...]";

function describe(id: HarnessId): string {
  return [harnessPath(id, "skills"), harnessPath(id, "instructions")].filter(Boolean).join(", ");
}

function printConfig(config: Config): void {
  console.log(`${c.bold("Harnesses")}  ${c.dim(tildify(paths.configFile))}`);
  const rows = HARNESS_IDS.map((id) => [
    id,
    config.harnesses.includes(id) ? c.green("on") : c.dim("off"),
    c.dim(describe(id)),
  ]);
  console.log(table(rows));
  console.log(`\n${c.bold("Disabled")}  ${config.disabled.length ? config.disabled.join(", ") : c.dim("none")}`);
}

/** Saves the harness choice and re-syncs so links match it. */
async function setHarnesses(config: Config, harnesses: HarnessId[]): Promise<number> {
  if (!harnesses.length) throw new RigError("USAGE", "choose at least one harness", `valid: ${HARNESS_IDS.join(", ")}`);
  saveConfig({ ...config, harnesses });
  console.log(`harnesses: ${harnesses.join(", ")}\n`);
  return sync([]);
}

export async function config(argv: string[]): Promise<number> {
  const [key, ...values] = argv;
  const current = loadConfig();

  if (key === "harnesses") return setHarnesses(current, parseHarnesses(values, "given"));
  if (key !== undefined) throw new RigError("USAGE", `unknown config key ${key}`, USAGE);

  if (!process.stdin.isTTY) {
    printConfig(current);
    console.log(c.dim(`\n  change with: rig config harnesses <name>... (or run rig config in a terminal)`));
    return 0;
  }

  const p = await import("@clack/prompts");
  p.intro(c.bold(" rig config "));
  const chosen = await p.multiselect({
    message: "Which harnesses should rig link into?",
    options: HARNESS_IDS.map((id) => ({ value: id, label: id, hint: describe(id) })),
    initialValues: current.harnesses,
    required: true,
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
