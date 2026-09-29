import { loadRegistry } from "../core/registry";
import { c, table, takeFlags } from "../core/ui";
import { RigError } from "../sdk";

export async function ls(argv: string[]): Promise<number> {
  const { flags } = takeFlags(argv, ["--json"]);
  const reg = await loadRegistry();
  const commands = [...reg.commands.values()];

  if (flags.has("--json")) {
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

  if (!commands.length) {
    console.log("no tools yet; scaffold one with: rig new tool <name>");
    return 0;
  }
  for (const tool of reg.tools.filter((t) => !t.disabled)) {
    console.log(`${c.bold(tool.name)} ${c.dim(tool.description)}`);
    const rows = tool.commands
      .filter((cmd) => reg.commands.get(cmd.name) === cmd)
      .map((cmd) => [c.cyan(cmd.name + cmd.positional.map((p) => ` <${p}>`).join("")), cmd.description]);
    if (rows.length) console.log(table(rows));
  }
  console.log(c.dim("\nrun `rig <command> --help` for flags"));
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
