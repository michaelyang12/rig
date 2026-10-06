// @module Desired links for the global instructions file (~/.config/rig/AGENTS.md → each harness), fed into links.ts, plus the hint to move a pre-packs instructions/AGENTS.md.
import { existsSync } from "node:fs";
import { instructionPaths, loadConfig, type Config } from "./config";
import { paths, tildify } from "./paths";
import type { LinkRecord } from "./state";

/** Link name used in state, output, and change filtering. */
export const INSTRUCTIONS = "instructions";

/**
 * Global instructions: one always-on file (`~/.config/rig/AGENTS.md`) linked to each harness's
 * user-level instructions path. Harnesses read it under their own filename; the defaults come
 * from each harness's `instructions` entry in HARNESSES.
 */
export function instructionTargets(config: Config = loadConfig()): string[] {
  return instructionPaths(config);
}

/** The file to link: the config-dir file, or the legacy one while its move is pending. */
export function instructionsSource(): string | undefined {
  if (existsSync(paths.instructionsFile)) return paths.instructionsFile;
  if (existsSync(paths.legacyInstructionsFile)) return paths.legacyInstructionsFile;
  return undefined;
}

/** Desired links, or none when there's no source file (so stale links get pruned). */
export function instructionLinks(config: Config = loadConfig()): LinkRecord[] {
  const source = instructionsSource();
  if (!source) return [];
  return instructionTargets(config).map((path) => ({
    path,
    source,
    kind: "instructions",
    name: INSTRUCTIONS,
  }));
}

/**
 * The instructions file used to live in the repo. rig doesn't move user content itself, so while the old
 * file exists and the new one doesn't, it stays linked and this names the exact move; the next sync then
 * repairs the links.
 */
export function instructionsMigration(): string | undefined {
  if (!existsSync(paths.legacyInstructionsFile) || existsSync(paths.instructionsFile)) return undefined;
  return `instructions: ${tildify(paths.legacyInstructionsFile)} should move to ${tildify(paths.instructionsFile)}; run: mv ${paths.legacyInstructionsFile} ${paths.instructionsFile}`;
}
