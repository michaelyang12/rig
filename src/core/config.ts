import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { harnessPaths } from "./harnesses";
import { expandHome, paths } from "./paths";

export interface Config {
  /** Directories skills are symlinked into. Stored with `~`, expanded on read. */
  targets: string[];
  /** Paths the global instructions file is symlinked to, one per harness. Stored with `~`. */
  instructionTargets: string[];
  /** Tool/skill names excluded from sync and dispatch (set by `rig remove`). */
  disabled: string[];
}

// Harness paths come from HARNESSES; config.json can still override them with raw paths.
const defaults = (): Config => ({
  targets: harnessPaths("skills"),
  instructionTargets: harnessPaths("instructions"),
  disabled: [],
});

export function loadConfig(): Config {
  let stored: Partial<Config> = {};
  if (existsSync(paths.configFile)) {
    stored = JSON.parse(readFileSync(paths.configFile, "utf8"));
  }
  return { ...defaults(), ...stored };
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

export function targetDirs(config: Config): string[] {
  return config.targets.map(expandHome);
}
