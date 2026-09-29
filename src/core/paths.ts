import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Every location is overridable via env so tests can run against a sandbox.
const home = () => process.env.HOME ?? homedir();

export const paths = {
  get root() {
    return process.env.RIG_ROOT ?? resolve(import.meta.dir, "../..");
  },
  get tools() {
    return join(this.root, "tools");
  },
  get skills() {
    return join(this.root, "skills");
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
  get envFile() {
    return join(this.configDir, ".env");
  },
  get stateDir() {
    return process.env.RIG_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(home(), ".local", "state"), "rig");
  },
  get stateFile() {
    return join(this.stateDir, "links.json");
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
