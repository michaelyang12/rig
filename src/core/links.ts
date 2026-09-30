// @module Symlink sync. Only touches links recorded in state.ts that still point where rig pointed them; everything else is a conflict.
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig, targetDirs } from "./config";
import { instructionLinks } from "./instructions";
import { paths } from "./paths";
import type { Registry } from "./registry";
import { loadState, saveState, type LinkRecord } from "./state";

export type LinkAction = "created" | "repaired" | "pruned" | "unchanged" | "conflict";

export interface LinkChange {
  action: LinkAction;
  link: LinkRecord;
  reason?: string;
}

function linkTarget(path: string): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined;
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return undefined;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * rig owns a path only if it recorded the link AND the path is still a symlink pointing where
 * rig pointed it. Anything else — a real directory, someone else's link — is left alone.
 */
export function isOwned(record: LinkRecord): boolean {
  return linkTarget(record.path) === record.source;
}

export function desiredLinks(registry: Registry): LinkRecord[] {
  const config = loadConfig();
  const links: LinkRecord[] = [{ path: join(paths.binDir, "rig"), source: paths.shim, kind: "bin", name: "rig" }];
  for (const target of targetDirs(config)) {
    for (const skill of registry.skills) {
      if (skill.disabled) continue;
      links.push({ path: join(target, skill.name), source: skill.dir, kind: "skill", name: skill.name });
    }
  }
  links.push(...instructionLinks(config));
  return links;
}

export function syncLinks(registry: Registry, { dryRun = false } = {}): LinkChange[] {
  const state = loadState();
  const recorded = new Map(state.links.map((l) => [l.path, l]));
  const desired = desiredLinks(registry);
  const wanted = new Set(desired.map((l) => l.path));
  const changes: LinkChange[] = [];
  const nextState: LinkRecord[] = [];

  const link = (l: LinkRecord) => {
    if (dryRun) return;
    mkdirSync(dirname(l.path), { recursive: true });
    symlinkSync(l.source, l.path);
  };

  for (const l of desired) {
    const current = linkTarget(l.path);
    const prior = recorded.get(l.path);

    if (!exists(l.path)) {
      link(l);
      nextState.push(l);
      changes.push({ action: "created", link: l });
    } else if (current === l.source) {
      nextState.push(l); // already correct (adopts an identical link made by hand)
      changes.push({ action: "unchanged", link: l });
    } else if (prior && isOwned(prior)) {
      if (!dryRun) unlinkSync(l.path);
      link(l);
      nextState.push(l);
      changes.push({ action: "repaired", link: l });
    } else {
      changes.push({ action: "conflict", link: l, reason: current ? `symlink to ${current}` : "existing file or directory" });
    }
  }

  // Prune links rig made that are no longer wanted (skill deleted or disabled, instructions removed).
  for (const prior of state.links) {
    if (wanted.has(prior.path)) continue;
    if (isOwned(prior)) {
      if (!dryRun) unlinkSync(prior.path);
      changes.push({ action: "pruned", link: prior });
    }
    // If it's gone or replaced by something foreign, just forget it.
  }

  if (!dryRun) saveState({ links: nextState });
  return changes;
}

/**
 * Remove every link rig owns except the `rig` bin link, so the command stays available to re-sync.
 * Never touches anything else.
 */
export function removeAllLinks({ dryRun = false } = {}): LinkChange[] {
  const state = loadState();
  const changes: LinkChange[] = [];
  const kept: LinkRecord[] = [];
  for (const prior of state.links) {
    if (prior.kind === "bin") {
      kept.push(prior);
      continue;
    }
    if (!isOwned(prior)) continue;
    if (!dryRun) unlinkSync(prior.path);
    changes.push({ action: "pruned", link: prior });
  }
  if (!dryRun) saveState({ links: kept });
  return changes;
}
