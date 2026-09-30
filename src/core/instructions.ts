import { existsSync } from "node:fs";
import { instructionPaths, loadConfig, type Config } from "./config";
import { paths } from "./paths";
import type { LinkRecord } from "./state";

/** Link name used in state, output, and change filtering. */
export const INSTRUCTIONS = "instructions";

/**
 * Global instructions: one always-on file (`instructions/AGENTS.md`) linked to each harness's
 * user-level instructions path. Harnesses read it under their own filename; the defaults come
 * from each harness's `instructions` entry in HARNESSES.
 */
export function instructionTargets(config: Config = loadConfig()): string[] {
  return instructionPaths(config);
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
