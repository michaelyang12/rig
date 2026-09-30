import { existsSync } from "node:fs";
import { loadConfig, type Config } from "./config";
import { expandHome, paths } from "./paths";
import type { LinkRecord } from "./state";

/** Link name used in state, output, and change filtering. */
export const INSTRUCTIONS = "instructions";

/**
 * Global instructions: one always-on file (`instructions/AGENTS.md`) linked to each harness's
 * user-level instructions path. Harnesses read it under their own filename, e.g. Claude Code
 * reads ~/.claude/CLAUDE.md and Codex reads ~/.codex/AGENTS.md.
 */
export function instructionTargets(config: Config = loadConfig()): string[] {
  return config.instructionTargets.map(expandHome);
}

/** Desired links, or none when the source file doesn't exist (so stale links get pruned). */
export function instructionLinks(config: Config = loadConfig()): LinkRecord[] {
  if (!existsSync(paths.instructionsFile)) return [];
  return instructionTargets(config).map((path) => ({
    path,
    source: paths.instructionsFile,
    kind: "instructions",
    name: INSTRUCTIONS,
  }));
}
