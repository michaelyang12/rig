// @module links.json: the record of every symlink rig created, which is what makes sync safe to rerun.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "./paths";

/** A symlink rig created. Only paths recorded here are ever modified or removed. */
export interface LinkRecord {
  path: string;
  source: string;
  kind: "skill" | "bin" | "instructions";
  name: string;
}

export interface State {
  links: LinkRecord[];
}

export function loadState(): State {
  if (!existsSync(paths.stateFile)) return { links: [] };
  return JSON.parse(readFileSync(paths.stateFile, "utf8"));
}

export function saveState(state: State): void {
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.stateFile, JSON.stringify(state, null, 2) + "\n");
}
