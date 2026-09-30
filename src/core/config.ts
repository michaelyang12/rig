import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { RigError } from "../sdk";
import { HARNESS_IDS, harnessPaths, parseHarnessId, type HarnessId } from "./harnesses";
import { expandHome, paths } from "./paths";

export interface Config {
  /** Harnesses to link into (names from HARNESSES, any case). Defaults to all of them. */
  harnesses: HarnessId[];
  /** Raw skills dirs, overriding the harnesses' own. Stored with `~`, expanded on read. */
  targets?: string[];
  /** Raw instructions file paths, overriding the harnesses' own. Stored with `~`. */
  instructionTargets?: string[];
  /** Tool/skill names excluded from sync and dispatch (set by `rig remove`). */
  disabled: string[];
}

const defaults = (): Config => ({ harnesses: [...HARNESS_IDS], disabled: [] });

function parseHarnesses(names: unknown): HarnessId[] {
  const valid = HARNESS_IDS.join(", ");
  if (!Array.isArray(names)) throw new RigError("USAGE", `config "harnesses" must be a list of names (${valid})`);
  return names.map((name) => {
    const id = typeof name === "string" ? parseHarnessId(name) : undefined;
    if (!id) throw new RigError("USAGE", `unknown harness ${JSON.stringify(name)} in ${paths.configFile}`, `valid: ${valid}`);
    return id;
  });
}

export function loadConfig(): Config {
  let stored: Partial<Config> = {};
  if (existsSync(paths.configFile)) {
    stored = JSON.parse(readFileSync(paths.configFile, "utf8"));
  }
  const config = { ...defaults(), ...stored };
  if (stored.harnesses !== undefined) config.harnesses = parseHarnesses(stored.harnesses);
  return config;
}

/** Writes only fields that differ from the defaults, so harness moves reach existing configs. */
export function saveConfig(config: Config): void {
  const base = defaults();
  const stored = Object.fromEntries(
    Object.entries(config).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(base[k as keyof Config])),
  );
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify(stored, null, 2) + "\n");
}

/** Skills dirs to link into: `targets` if set, else each chosen harness's skills dir. */
export function targetDirs(config: Config): string[] {
  return (config.targets ?? harnessPaths("skills", config.harnesses)).map(expandHome);
}

/** Instructions files to link to: `instructionTargets` if set, else each chosen harness's. */
export function instructionPaths(config: Config): string[] {
  return (config.instructionTargets ?? harnessPaths("instructions", config.harnesses)).map(expandHome);
}
