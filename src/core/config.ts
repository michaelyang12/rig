// @module ~/.config/rig/config.json: which harnesses to link into and which tools/skills are disabled.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { RigError } from "../sdk";
import { ALWAYS_HARNESS_IDS, HARNESS_IDS, OPTIONAL_HARNESS_IDS, harnessPaths, parseHarnessId, type HarnessId } from "./harnesses";
import { expandHome, paths } from "./paths";

export interface Config {
  /** Optional harnesses to link into (names from HARNESSES, any case). Defaults to all of them. */
  harnesses: HarnessId[];
  /** Tool/skill names excluded from sync and dispatch (set by `rig remove`). */
  disabled: string[];
}

const defaults = (): Config => ({ harnesses: [...OPTIONAL_HARNESS_IDS], disabled: [] });

/**
 * Resolves harness names (any case) to optional harness ids, in declaration order. Always-on
 * names are accepted and dropped; unknown names are a usage error naming the valid ones.
 */
export function parseHarnesses(names: unknown, where = `in ${paths.configFile}`): HarnessId[] {
  const valid = `${OPTIONAL_HARNESS_IDS.join(", ")} (always linked: ${ALWAYS_HARNESS_IDS.join(", ")})`;
  if (!Array.isArray(names)) throw new RigError("USAGE", `"harnesses" must be a list of names ${where}`, `valid: ${valid}`);
  const ids = names.map((name) => {
    const id = typeof name === "string" ? parseHarnessId(name) : undefined;
    if (!id) throw new RigError("USAGE", `unknown harness ${JSON.stringify(name)} ${where}`, `valid: ${valid}`);
    return id;
  });
  return OPTIONAL_HARNESS_IDS.filter((id) => ids.includes(id));
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

/** Harnesses rig links into: the always-on ones plus those config chose, in declaration order. */
export function activeHarnesses(config: Config): HarnessId[] {
  return HARNESS_IDS.filter((id) => ALWAYS_HARNESS_IDS.includes(id) || config.harnesses.includes(id));
}

/** Skills dirs of the active harnesses. */
export function targetDirs(config: Config): string[] {
  return harnessPaths("skills", activeHarnesses(config)).map(expandHome);
}

/** Instructions files of the active harnesses. */
export function instructionPaths(config: Config): string[] {
  return harnessPaths("instructions", activeHarnesses(config)).map(expandHome);
}
