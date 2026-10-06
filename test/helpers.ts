import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { harnessPath, type HarnessId, type HarnessPath } from "../src/core/harnesses";

export const REPO = resolve(import.meta.dir, "..");
const FIXTURES = join(REPO, "test", "fixtures");

export interface Sandbox {
  dir: string;
  root: string;
  /** The core pack (`<root>/packs/rig`), copied from fixtures/packs/core-fixture. */
  core: string;
  /** A user pack named `demo` in the sandbox's config dir, copied from fixtures/packs/user-fixture. */
  user: string;
  home: string;
  env: Record<string, string>;
  claude: string;
  agents: string;
  /** A harness's skills dir or instructions file inside this sandbox's HOME. */
  harness(id: HarnessId, kind: HarnessPath): string;
  bin: string;
  envFile: string;
  run(args: string[], opts?: { env?: Record<string, string>; stdin?: string }): Promise<{ code: number; stdout: string; stderr: string }>;
  cleanup(): void;
}

/** A throwaway HOME plus a fixture install (core pack) and user pack, so tests never touch real harness dirs. */
export function sandbox(): Sandbox {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rig-test-")));
  const root = join(dir, "root");
  const core = join(root, "packs", "rig");
  cpSync(join(FIXTURES, "packs", "core-fixture"), core, { recursive: true });
  mkdirSync(join(root, "bin"));
  cpSync(join(REPO, "bin", "rig"), join(root, "bin", "rig"));

  const home = join(dir, "home");
  const user = join(home, ".config", "rig", "packs", "demo");
  cpSync(join(FIXTURES, "packs", "user-fixture"), user, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(ACME|GREET|PYECHO)_|^RIG_|^XDG_/.test(k)) env[k] = v;
  }
  Object.assign(env, {
    HOME: home,
    RIG_ROOT: root,
    RIG_CONFIG_DIR: join(home, ".config", "rig"),
    RIG_STATE_DIR: join(home, ".local", "state", "rig"),
    RIG_BIN_DIR: join(home, ".local", "bin"),
    NO_COLOR: "1",
  });

  const harness = (id: HarnessId, kind: HarnessPath) => {
    const p = harnessPath(id, kind);
    if (!p) throw new Error(`harness ${id} has no ${kind}`);
    return join(home, p.replace(/^~\//, ""));
  };

  return {
    dir,
    root,
    core,
    user,
    home,
    env,
    claude: harness("claude", "skills"),
    agents: harness("agents", "skills"),
    harness,
    bin: join(home, ".local", "bin", "rig"),
    envFile: join(home, ".config", "rig", ".env"),
    async run(args, opts = {}) {
      const proc = Bun.spawn(["bun", "--no-install", join(REPO, "src", "cli.ts"), ...args], {
        env: { ...env, ...opts.env },
        stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
