import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { RigError } from "../sdk";
import { HARNESS_IDS, harnessPaths, parseHarnessId, type HarnessId } from "./harnesses";
import { expandHome, paths } from "./paths";

export interface Config {
  /** Harnesses to link into (names from HARNESSES, any case). Defaults to all of them. */
  harnesses: HarnessId[];
  /** Tool/skill names excluded from sync and dispatch (set by `rig remove`). */
  disabled: string[];
}

const defaults = (): Config => ({ harnesses: [...HARNESS_IDS], disabled: [] });

/** Resolves harness names (any case) to ids; throws a usage error naming the valid ones. */
export function parseHarnesses(names: unknown, where = `in ${paths.configFile}`): HarnessId[] {
  const valid = HARNESS_IDS.join(", ");
  if (!Array.isArray(names)) throw new RigError("USAGE", `"harnesses" must be a list of names ${where}`, `valid: ${valid}`);
  const ids = names.map((name) => {
    const id = typeof name === "string" ? parseHarnessId(name) : undefined;
    if (!id) throw new RigError("USAGE", `unknown harness ${JSON.stringify(name)} ${where}`, `valid: ${valid}`);
    return id;
  });
  return HARNESS_IDS.filter((id) => ids.includes(id)); // declaration order, deduped
}

export function loadConfig(): Config {
  let stored: Partial<Config> = {};
  if (existsSync(paths.configFile)) {
    stored = JSON.parse(readFileSync(paths.configFile, "utf8"));
  }
  const base = defaults();
  return {
    harnesses: stored.harnesses === undefined ? base.harnesses : parseHarnesses(stored.harnesses),
    disabled: stored.disabled ?? base.disabled,
  };
}

/** Writes only fields that differ from the defaults, so harness changes reach existing configs. */
export function saveConfig(config: Config): void {
  const base = defaults();
  const stored = Object.fromEntries(
    Object.entries(config).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(base[k as keyof Config])),
  );
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify(stored, null, 2) + "\n");
}

/** Skills dirs of the configured harnesses. */
export function targetDirs(config: Config): string[] {
  return harnessPaths("skills", config.harnesses).map(expandHome);
}

/** Instructions files of the configured harnesses. */
export function instructionPaths(config: Config): string[] {
  return harnessPaths("instructions", config.harnesses).map(expandHome);
}
