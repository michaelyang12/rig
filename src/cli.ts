#!/usr/bin/env bun
import { BUILTINS } from "./builtins";
import { runCommand } from "./core/dispatch";
import { printError } from "./core/output";
import { loadRegistry } from "./core/registry";
import { c } from "./core/ui";
import { RigError } from "./sdk";

const HELP = `${c.bold("rig")}: your agent tools and skills, in every harness

${c.bold("Tools")}
  rig ls [tool] [--json]     List tools, or one tool's commands
  rig <command> --help       Show a command's flags
  rig schema <command>       Print a command's JSON Schema
  rig new tool <name>        Scaffold a tool (--auth, --uv, --no-skill)
  rig new skill <name>       Scaffold a skill

${c.bold("Sync")}
  rig sync [--dry-run]       Link skills into harnesses and rig onto PATH
  rig status                 Show links, tools and auth state
  rig remove <name>          Unlink and disable a skill/tool
  rig add <name>             Re-enable a removed skill/tool
  rig desync [--dry-run]     Remove every link rig created (keeps rig itself)
  rig config                 Choose harnesses interactively (or: rig config harnesses <name>...)

${c.bold("Auth")}
  rig auth [tool]            Interactively set up credentials
  rig auth --status          Show which credentials are set`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }

  const builtin = BUILTINS[cmd];
  if (builtin) return builtin(rest);

  const reg = await loadRegistry();
  const command = reg.commands.get(cmd);
  if (command) return runCommand(command, rest);

  const disabled = reg.tools.find((t) => t.disabled && t.commands.some((c) => c.name === cmd));
  if (disabled) throw new RigError("NOT_FOUND", `${cmd} belongs to disabled tool ${disabled.name}`, `run: rig add ${disabled.name}`);
  const broken = reg.problems.find((p) => p.includes(cmd));
  throw new RigError("NOT_FOUND", `unknown command ${cmd}`, broken ?? "see: rig ls");
}

const argv = process.argv.slice(2);
try {
  process.exitCode = await main(argv);
} catch (err) {
  process.exitCode = printError(err, argv.includes("--json"));
}
