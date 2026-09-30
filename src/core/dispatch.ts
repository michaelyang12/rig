// @module Runs a resolved command: checks auth, then calls a TS tool in-process or spawns an external one (args as JSON on stdin).
import { join } from "node:path";
import { RigError, type Context } from "../sdk";
import { parseArgv, renderHelp } from "./args";
import { lookupVar, readEnvFile } from "./env";
import { printResult } from "./output";
import type { ResolvedCommand, ResolvedTool } from "./registry";

export function makeContext(tool: ResolvedTool): Context {
  const file = readEnvFile();
  return {
    tool: tool.name,
    env: (name) => lookupVar(name, file)?.value,
    secret(name) {
      const v = lookupVar(name, file)?.value;
      if (!v) throw new RigError("AUTH", `${name} is not set`, `run: rig auth ${tool.name}`);
      return v;
    },
    log: (...args) => console.error(...args),
  };
}

/** Resolved values for a tool's declared vars; throws AUTH if a required one is missing. */
export function resolveAuth(tool: ResolvedTool): Record<string, string> {
  const file = readEnvFile();
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const v of tool.auth) {
    const found = lookupVar(v.name, file);
    if (found) values[v.name] = found.value;
    else if (!v.optional) missing.push(v.name);
  }
  if (missing.length) {
    throw new RigError("AUTH", `${tool.name} is missing ${missing.join(", ")}`, `run: rig auth ${tool.name}`);
  }
  return values;
}

function externalArgv(tool: ResolvedTool, command: string): string[] {
  const entry = join(tool.dir, tool.entry!);
  switch (tool.runtime) {
    case "uv":
      return ["uv", "run", "--quiet", "--script", entry, command];
    case "python":
      return ["python3", entry, command];
    default:
      return [entry, command];
  }
}

/**
 * Spawn a non-TS tool: args arrive as JSON on stdin, the command name as argv[1],
 * resolved auth vars in env. Its exit code passes straight through.
 */
export async function spawnExternal(
  tool: ResolvedTool,
  command: string,
  args: Record<string, unknown>,
  opts: { json: boolean; capture: boolean },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, ...resolveAuth(tool), RIG_COMMAND: command, RIG_JSON: opts.json ? "1" : "" };
  const proc = Bun.spawn(externalArgv(tool, command), {
    stdin: new Blob([JSON.stringify(args)]),
    stdout: opts.capture ? "pipe" : "inherit",
    stderr: opts.capture ? "pipe" : "inherit",
    env,
  });
  const [stdout, stderr, code] = await Promise.all([
    opts.capture ? new Response(proc.stdout as ReadableStream).text() : "",
    opts.capture ? new Response(proc.stderr as ReadableStream).text() : "",
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function runCommand(cmd: ResolvedCommand, argv: string[]): Promise<number> {
  const { args, json, help } = await parseArgv(argv, cmd.schema, cmd.positional);
  if (help) {
    console.log(renderHelp(cmd.name, cmd.description, cmd.schema, cmd.positional));
    return 0;
  }

  const { tool } = cmd;
  if (cmd.def) {
    resolveAuth(tool);
    const parsed = cmd.def.args.parse(args);
    const result = await cmd.def.run(parsed, makeContext(tool));
    printResult(result, json, cmd.def.format);
    return 0;
  }

  const { code, stdout, stderr } = await spawnExternal(tool, cmd.name, args, { json, capture: json });
  if (!json) return code;
  if (code !== 0) {
    const errCode = code === 2 ? "USAGE" : code === 3 ? "AUTH" : "UPSTREAM";
    throw new RigError(errCode, stderr.trim() || `${cmd.name} exited with code ${code}`);
  }
  let data: unknown = stdout.trimEnd();
  try {
    data = JSON.parse(stdout);
  } catch {}
  printResult(data, true);
  return 0;
}
