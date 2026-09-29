import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "..");
const FIXTURES = join(REPO, "test", "fixtures");

export interface Sandbox {
  dir: string;
  root: string;
  home: string;
  env: Record<string, string>;
  claude: string;
  agents: string;
  bin: string;
  envFile: string;
  run(args: string[], opts?: { env?: Record<string, string>; stdin?: string }): Promise<{ code: number; stdout: string; stderr: string }>;
  cleanup(): void;
}

/** A throwaway HOME plus a copy of the fixture repo, so tests never touch real harness dirs. */
export function sandbox(): Sandbox {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rig-test-")));
  const root = join(dir, "root");
  cpSync(FIXTURES, root, { recursive: true });
  // Copied tools still need the "rig" alias and zod.
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { rig: [join(REPO, "src/sdk/index.ts")] } } }));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  mkdirSync(join(root, "bin"));
  cpSync(join(REPO, "bin", "rig"), join(root, "bin", "rig"));

  const home = join(dir, "home");
  mkdirSync(home);
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

  return {
    dir,
    root,
    home,
    env,
    claude: join(home, ".claude", "skills"),
    agents: join(home, ".agents", "skills"),
    bin: join(home, ".local", "bin", "rig"),
    envFile: join(home, ".config", "rig", ".env"),
    async run(args, opts = {}) {
      const proc = Bun.spawn(["bun", join(REPO, "src", "cli.ts"), ...args], {
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
