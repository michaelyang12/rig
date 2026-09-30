// @module Discovers and validates tools/ and skills/: names, reserved commands, tool description length, and the <TOOL>_ auth convention.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { apiKeyVar, envPrefix, type AuthVar, type CommandDef, type Context, type ToolDef } from "../sdk";
import { loadConfig } from "./config";
import { paths } from "./paths";

export const RESERVED = ["sync", "remove", "add", "desync", "ls", "status", "auth", "config", "schema", "new", "help"];
const NAME_RE = /^[a-z][a-z0-9-]*$/;
/** A tool's description is its line in `rig ls`; the cap keeps that index cheap for agents to read. */
export const TOOL_DESCRIPTION_MAX = 300;

export interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  [key: string]: unknown;
}

export type Runtime = "uv" | "python" | "bin";

export interface ResolvedCommand {
  name: string;
  description: string;
  tool: ResolvedTool;
  schema: JSONSchema;
  positional: string[];
  /** Present for TS tools; external tools are spawned. */
  def?: CommandDef;
}

export interface ResolvedTool {
  name: string;
  description: string;
  dir: string;
  kind: "ts" | "external";
  auth: AuthVar[];
  disabled: boolean;
  commands: ResolvedCommand[];
  verify?: (ctx: Context) => Promise<void>;
  skillFiles?: ToolDef["skillFiles"];
  runtime?: Runtime;
  entry?: string;
  verifyCommand?: string;
}

export interface Skill {
  name: string;
  dir: string;
  description?: string;
  disabled: boolean;
}

export interface Registry {
  tools: ResolvedTool[];
  skills: Skill[];
  /** Enabled commands only, keyed by command name. */
  commands: Map<string, ResolvedCommand>;
  problems: string[];
}

const AuthVarSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  secret: z.boolean().optional(),
  optional: z.boolean().optional(),
  example: z.string().optional(),
});

const ToolJsonSchema = z.object({
  name: z.string(),
  description: z.string(),
  runtime: z.enum(["uv", "python", "bin"]),
  entry: z.string(),
  auth: z.array(AuthVarSchema).optional(),
  verify: z.string().optional(),
  commands: z.record(
    z.string(),
    z.object({
      description: z.string(),
      args: z.record(z.string(), z.unknown()).default({ type: "object", properties: {} }),
      positional: z.array(z.string()).optional(),
    }),
  ),
});

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => !d.startsWith(".") && statSync(join(dir, d)).isDirectory())
    .sort();
}

/** Enforce the `<TOOL>_API_KEY` convention and `<TOOL>_` namespace for every var. */
export function normalizeAuth(tool: string, auth: AuthVar[] | undefined): AuthVar[] {
  if (!auth) return [];
  const key = apiKeyVar(tool);
  const prefix = envPrefix(tool) + "_";
  for (const v of auth) {
    if (!v.name.startsWith(prefix)) {
      throw new Error(`auth var ${v.name} must be prefixed with ${prefix}`);
    }
    if (v.secret && v.name !== key && !v.name.endsWith("_API_KEY") && !v.name.endsWith("_SECRET")) {
      throw new Error(`secret var ${v.name} should be named ${key} (or end in _API_KEY/_SECRET)`);
    }
  }
  const declared = auth.find((v) => v.name === key);
  const keyVar: AuthVar = { prompt: `${tool} API key`, ...declared, name: key, secret: true };
  return [keyVar, ...auth.filter((v) => v.name !== key)];
}

async function loadTsTool(name: string, dir: string, file: string): Promise<ResolvedTool> {
  const mod = await import(file);
  const def: ToolDef | undefined = mod.default;
  if (!def || typeof def !== "object" || !def.commands) {
    throw new Error("index.ts must `export default defineTool({...})`");
  }
  const tool: ResolvedTool = {
    name: def.name,
    description: def.description,
    dir,
    kind: "ts",
    auth: normalizeAuth(def.name, def.auth),
    disabled: false,
    commands: [],
    verify: def.verify,
    skillFiles: def.skillFiles,
  };
  for (const [cmdName, cmd] of Object.entries(def.commands)) {
    tool.commands.push({
      name: cmdName,
      description: cmd.description,
      tool,
      schema: z.toJSONSchema(cmd.args, { io: "input" }) as JSONSchema,
      positional: (cmd.positional as string[] | undefined) ?? [],
      def: cmd,
    });
  }
  return tool;
}

function loadExternalTool(dir: string, file: string): ResolvedTool {
  const parsed = ToolJsonSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`invalid tool.json: ${z.prettifyError(parsed.error)}`);
  const def = parsed.data;
  if (!existsSync(join(dir, def.entry))) throw new Error(`entry ${def.entry} not found`);
  const tool: ResolvedTool = {
    name: def.name,
    description: def.description,
    dir,
    kind: "external",
    auth: normalizeAuth(def.name, def.auth),
    disabled: false,
    commands: [],
    runtime: def.runtime,
    entry: def.entry,
    verifyCommand: def.verify,
  };
  for (const [cmdName, cmd] of Object.entries(def.commands)) {
    tool.commands.push({
      name: cmdName,
      description: cmd.description,
      tool,
      schema: cmd.args as JSONSchema,
      positional: cmd.positional ?? [],
    });
  }
  return tool;
}

export function parseFrontmatter(text: string): Record<string, string> {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!block) return {};
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

let cached: Registry | undefined;

export async function loadRegistry(): Promise<Registry> {
  if (cached) return cached;
  const { disabled } = loadConfig();
  const problems: string[] = [];
  const tools: ResolvedTool[] = [];
  const commands = new Map<string, ResolvedCommand>();

  for (const name of subdirs(paths.tools)) {
    const dir = join(paths.tools, name);
    const ts = join(dir, "index.ts");
    const json = join(dir, "tool.json");
    try {
      let tool: ResolvedTool;
      if (existsSync(ts)) tool = await loadTsTool(name, dir, ts);
      else if (existsSync(json)) tool = loadExternalTool(dir, json);
      else throw new Error("needs index.ts or tool.json");

      if (tool.name !== name) throw new Error(`name "${tool.name}" must match its directory "${name}"`);
      if (!NAME_RE.test(name)) throw new Error("name must be lowercase kebab-case");
      tool.disabled = disabled.includes(name);
      tools.push(tool);
      if (tool.disabled) continue;
      if (tool.description.length > TOOL_DESCRIPTION_MAX) {
        problems.push(`tool ${name}: description is ${tool.description.length} chars; keep it to ${TOOL_DESCRIPTION_MAX} (it's the tool's line in \`rig ls\`)`);
      }

      for (const cmd of tool.commands) {
        if (!NAME_RE.test(cmd.name)) problems.push(`tool ${name}: command "${cmd.name}" must be lowercase kebab-case`);
        else if (RESERVED.includes(cmd.name)) problems.push(`tool ${name}: command "${cmd.name}" is a reserved rig command`);
        else if (commands.has(cmd.name)) {
          problems.push(`tool ${name}: command "${cmd.name}" already defined by tool ${commands.get(cmd.name)!.tool.name}`);
        } else commands.set(cmd.name, cmd);
      }
    } catch (err) {
      problems.push(`tool ${name}: ${(err as Error).message}`);
    }
  }

  const skills: Skill[] = [];
  for (const name of subdirs(paths.skills)) {
    const dir = join(paths.skills, name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) {
      problems.push(`skill ${name}: missing SKILL.md`);
      continue;
    }
    const fm = parseFrontmatter(readFileSync(file, "utf8"));
    if (!fm.description) problems.push(`skill ${name}: SKILL.md frontmatter needs a description`);
    if (fm.name && fm.name !== name) problems.push(`skill ${name}: frontmatter name "${fm.name}" should match its directory`);
    skills.push({ name, dir, description: fm.description, disabled: disabled.includes(name) });
  }

  cached = { tools, skills, commands, problems };
  return cached;
}

export function resetRegistry(): void {
  cached = undefined;
}
