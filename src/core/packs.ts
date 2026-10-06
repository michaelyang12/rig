// @module Discovers packs (core, repo, config dir, config paths) and validates pack.json; packs are the unit tools and skills come from.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "./config";
import { expandHome, paths, tildify } from "./paths";

export const CORE_PACK = "rig";
export const NAME_RE = /^[a-z][a-z0-9-]*$/;

export type PackOrigin = "core" | "repo" | "config dir" | "config path";

export interface Pack {
  name: string;
  description?: string;
  dir: string;
  origin: PackOrigin;
}

const PackJsonSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

export function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => !d.startsWith("."))
    .filter((d) => {
      try {
        return statSync(join(dir, d)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function readPack(dir: string, origin: PackOrigin): Pack {
  const file = join(dir, "pack.json");
  if (!existsSync(file)) throw new Error("missing pack.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`invalid pack.json: ${(err as Error).message}`);
  }
  const parsed = PackJsonSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid pack.json: ${z.prettifyError(parsed.error)}`);
  const { name, description } = parsed.data;
  if (!NAME_RE.test(name)) throw new Error(`pack name "${name}" must be lowercase kebab-case`);
  if ((name === CORE_PACK) !== (origin === "core")) {
    throw new Error(origin === "core" ? `core pack must be named "${CORE_PACK}", not "${name}"` : `"${CORE_PACK}" is reserved for the core pack`);
  }
  return { name, description, dir, origin };
}

/** Config `packs` entries: `~` expands, relative paths resolve against the config dir. */
export function configPackPath(entry: string): string {
  return resolve(paths.configDir, expandHome(entry));
}

/**
 * Every pack in discovery order: core, other `<root>/packs/*`, `~/.config/rig/packs/*`, then config
 * `packs` paths. Order is for display only; it never decides a name conflict. A second pack with a
 * name already taken is skipped and reported.
 */
export function discoverPacks(config: Pick<Config, "packs">): { packs: Pack[]; problems: string[] } {
  const candidates: { dir: string; origin: PackOrigin }[] = [{ dir: paths.corePack, origin: "core" }];
  for (const d of subdirs(paths.packsDir)) if (d !== CORE_PACK) candidates.push({ dir: join(paths.packsDir, d), origin: "repo" });
  for (const d of subdirs(paths.userPacksDir)) candidates.push({ dir: join(paths.userPacksDir, d), origin: "config dir" });
  for (const entry of config.packs) candidates.push({ dir: configPackPath(entry), origin: "config path" });

  const packs: Pack[] = [];
  const problems: string[] = [];
  for (const { dir, origin } of candidates) {
    if (!existsSync(dir)) {
      problems.push(`pack at ${tildify(dir)}: ${origin === "core" ? "core pack is missing" : "directory not found"}`);
      continue;
    }
    try {
      const pack = readPack(dir, origin);
      const taken = packs.find((p) => p.name === pack.name);
      if (taken) {
        problems.push(`pack at ${tildify(dir)}: name "${pack.name}" is already used by ${tildify(taken.dir)}; skipped`);
        continue;
      }
      packs.push(pack);
    } catch (err) {
      problems.push(`pack at ${tildify(dir)}: ${(err as Error).message}`);
    }
  }
  return { packs, problems };
}
