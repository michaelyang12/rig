// @module Installs each pack's own npm deps when package.json/bun.lock change, and checks its declared rig version.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Pack } from "./packs";
import { paths } from "./paths";

export const RIG_VERSION: string = JSON.parse(readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8")).version;

interface Stamp {
  depsHash: string;
  installedAt: string;
}

type PacksState = Record<string, Stamp>;

function loadPacksState(): PacksState {
  if (!existsSync(paths.packsStateFile)) return {};
  return JSON.parse(readFileSync(paths.packsStateFile, "utf8"));
}

function saveStamp(pack: Pack, depsHash: string): void {
  const state = loadPacksState();
  state[pack.name] = { depsHash, installedAt: new Date().toISOString() };
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.packsStateFile, JSON.stringify(state, null, 2) + "\n");
}

function readPackageJson(pack: Pack): { peerDependencies?: Record<string, string> } | undefined {
  const file = join(pack.dir, "package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

/** Hash of package.json plus bun.lock, or undefined for a pack without dependencies. */
export function depsHash(pack: Pack): string | undefined {
  const manifest = join(pack.dir, "package.json");
  if (!existsSync(manifest)) return undefined;
  const hash = createHash("sha256").update(readFileSync(manifest));
  const lock = join(pack.dir, "bun.lock");
  if (existsSync(lock)) hash.update("\0").update(readFileSync(lock));
  return hash.digest("hex");
}

/** True when the pack has dependencies whose install stamp doesn't match package.json/bun.lock. */
export function depsStale(pack: Pack): boolean {
  const hash = depsHash(pack);
  return hash !== undefined && loadPacksState()[pack.name]?.depsHash !== hash;
}

/** Why the pack's tools can't run against this rig, from its `peerDependencies.rig`, if anything. */
export function peerMismatch(pack: Pack): string | undefined {
  let range: string | undefined;
  try {
    range = readPackageJson(pack)?.peerDependencies?.rig;
  } catch (err) {
    return `invalid package.json: ${(err as Error).message}`;
  }
  if (!range || Bun.semver.satisfies(RIG_VERSION, range)) return undefined;
  return `needs rig ${range}, but this is rig ${RIG_VERSION}`;
}

/** A working copy with uncommitted changes, where a lockfile is expected to move. */
function isDirtyCheckout(dir: string): boolean {
  const git = Bun.spawnSync(["git", "-C", dir, "status", "--porcelain"], { stdout: "pipe", stderr: "ignore" });
  return git.exitCode === 0 && git.stdout.toString().trim() !== "";
}

/**
 * `bun install` in the pack, then stamp it. The lockfile is frozen unless the pack is a working copy
 * with uncommitted changes. Bun's default of skipping untrusted lifecycle scripts applies.
 */
export async function installDeps(pack: Pack): Promise<void> {
  const hash = depsHash(pack);
  if (hash === undefined) return;
  const frozen = existsSync(join(pack.dir, "bun.lock")) && !isDirtyCheckout(pack.dir);
  const proc = Bun.spawn([process.execPath, "install", ...(frozen ? ["--frozen-lockfile"] : [])], {
    cwd: pack.dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    const detail = stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit code ${code}`;
    throw new Error(`bun install failed: ${detail}`);
  }
  saveStamp(pack, depsHash(pack) ?? hash);
}
