import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expandHome, paths } from "./paths";

export interface Config {
  /** Directories skills are symlinked into. Stored with `~`, expanded on read. */
  targets: string[];
  /** Tool/skill names excluded from sync and dispatch (set by `rig remove`). */
  disabled: string[];
}

const DEFAULTS: Config = {
  targets: ["~/.claude/skills", "~/.agents/skills"],
  disabled: [],
};

export function loadConfig(): Config {
  let stored: Partial<Config> = {};
  if (existsSync(paths.configFile)) {
    stored = JSON.parse(readFileSync(paths.configFile, "utf8"));
  }
  return {
    targets: stored.targets ?? DEFAULTS.targets,
    disabled: stored.disabled ?? DEFAULTS.disabled,
  };
}

export function saveConfig(config: Config): void {
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, JSON.stringify(config, null, 2) + "\n");
}

export function targetDirs(config: Config): string[] {
  return config.targets.map(expandHome);
}
