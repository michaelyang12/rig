import { loadRegistry, type Registry, type ResolvedCommand, type ResolvedTool } from "../core/registry";
import { c, table, takeFlags } from "../core/ui";
import { RigError } from "../sdk";

const USAGE = `usage: rig ls [tool] [--json]

  rig ls          One line per tool: what it does and when to use it
  rig ls <tool>   That tool's commands (a command name also works)
  --json          Commands with their JSON Schemas, filtered to <tool> if given`;

const kebab = (s: string) => s.replace(/[A-Z]/g, (ch) => "-" + ch.toLowerCase());

function usage(cmd: ResolvedCommand): string {
  const props = cmd.schema.properties ?? {};
  const required = new Set(cmd.schema.required ?? []);
  const pos = cmd.positional.map((p) => {
    const label = kebab(p) + (props[p]?.type === "array" ? "..." : "");
    return required.has(p) ? `<${label}>` : `[${label}]`;
  });
  return ["rig", cmd.name, ...pos].join(" ");
}

const enabledCommands = (reg: Registry, tool: ResolvedTool) => tool.commands.filter((cmd) => reg.commands.get(cmd.name) === cmd);

function findTool(reg: Registry, name: string): ResolvedTool {
  const tool = reg.tools.find((t) => t.name === name && !t.disabled) ?? reg.commands.get(name)?.tool;
  if (!tool || !enabledCommands(reg, tool).length) throw new RigError("NOT_FOUND", `no tool or command named ${name}`, "see: rig ls");
  return tool;
}

export async function ls(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const { flags, rest } = takeFlags(argv, ["--json"]);
  if (rest.length > 1) throw new RigError("USAGE", USAGE);
  const reg = await loadRegistry();
  const tool = rest[0] ? findTool(reg, rest[0]) : undefined;

  if (flags.has("--json")) {
    const commands = tool ? enabledCommands(reg, tool) : [...reg.commands.values()];
    const data = commands.map((cmd) => ({
      command: cmd.name,
      tool: cmd.tool.name,
      description: cmd.description,
      positional: cmd.positional,
      args: cmd.schema,
    }));
    console.log(JSON.stringify({ ok: true, data }));
    return 0;
  }

  if (tool) {
    console.log(table(enabledCommands(reg, tool).map((cmd) => [c.cyan(usage(cmd)), cmd.description])));
    if (reg.skills.some((s) => s.name === tool.name && !s.disabled)) console.log(`has a skill: ${tool.name}`);
    console.log(c.dim("run `rig <command> --help` for flags"));
    return 0;
  }

  const tools = reg.tools.filter((t) => !t.disabled && enabledCommands(reg, t).length);
  if (!tools.length) {
    console.log("no tools yet; scaffold one with: rig new tool <name>");
    return 0;
  }
  console.log(table(tools.map((t) => [c.bold(t.name), t.description])));
  console.log(c.dim("run `rig ls <tool>` for its commands"));
  return 0;
}

export async function schema(argv: string[]): Promise<number> {
  const [name] = argv;
  if (!name) throw new RigError("USAGE", "usage: rig schema <command>");
  const reg = await loadRegistry();
  const cmd = reg.commands.get(name);
  if (!cmd) throw new RigError("NOT_FOUND", `unknown command ${name}`, "see: rig ls");
  console.log(JSON.stringify({ name: cmd.name, description: cmd.description, inputSchema: cmd.schema }, null, 2));
  return 0;
}
