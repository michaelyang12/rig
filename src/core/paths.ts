// @module Every location rig uses (repo, config, state, bin), each overridable by env so tests run in a sandbox.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const home = () => process.env.HOME ?? homedir();

export const paths = {
  get root() {
    return process.env.RIG_ROOT ?? resolve(import.meta.dir, "../..");
  },
  /** Packs shipped with or dropped into the install: `rig` (core) plus any dev packs. */
  get packsDir() {
    return join(this.root, "packs");
  },
  get corePack() {
    return join(this.packsDir, "rig");
  },
  get instructions() {
    return join(this.root, "instructions");
  },
  get instructionsFile() {
    return join(this.instructions, "AGENTS.md");
  },
  get shim() {
    return join(this.root, "bin", "rig");
  },
  get configDir() {
    return process.env.RIG_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(home(), ".config"), "rig");
  },
  get configFile() {
    return join(this.configDir, "config.json");
  },
  /** Default home for user packs; survives reinstalls. */
  get userPacksDir() {
    return join(this.configDir, "packs");
  },
  get envFile() {
    return join(this.configDir, ".env");
  },
  get stateDir() {
    return process.env.RIG_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(home(), ".local", "state"), "rig");
  },
  get stateFile() {
    return join(this.stateDir, "links.json");
  },
  /** Per-pack dependency install stamps. */
  get packsStateFile() {
    return join(this.stateDir, "packs.json");
  },
  get binDir() {
    return process.env.RIG_BIN_DIR ?? join(home(), ".local", "bin");
  },
};

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(home(), p.slice(1)) : p;
}

export function tildify(p: string): string {
  const h = home();
  return p === h || p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}
