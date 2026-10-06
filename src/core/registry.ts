// @module Loads every pack's tools/ and skills/ and settles names across packs (qualified pack:cmd, collisions, aliases); validates names, descriptions, and the <TOOL>_ auth convention.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { apiKeyVar, envPrefix, type AuthVar, type CommandDef, type Context, type ToolDef } from "../sdk";
import { loadConfig, type Config } from "./config";
import { depsStale, peerMismatch } from "./deps";
import { CORE_PACK, discoverPacks, NAME_RE, subdirs, type Pack } from "./packs";
import { installResolver } from "./resolve";

export const RESERVED = ["sync", "remove", "add", "desync", "ls", "status", "auth", "config", "schema", "new", "pack", "help"];
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
  /** `<pack>:<command>`, which always resolves while the tool is active. */
  qualified: string;
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
  pack: Pack;
  dir: string;
  kind: "ts" | "external";
  auth: AuthVar[];
  disabled: boolean;
  /** Set when another enabled pack defines a tool with the same name; the tool doesn't load. */
  conflict?: string;
  commands: ResolvedCommand[];
  verify?: (ctx: Context) => Promise<void>;
  skillFiles?: ToolDef["skillFiles"];
  runtime?: Runtime;
  entry?: string;
  verifyCommand?: string;
}

export interface Skill {
  name: string;
  pack: Pack;
  dir: string;
  description?: string;
  disabled: boolean;
  /** Set when another enabled pack defines a skill with the same name; the skill isn't linked. */
  conflict?: string;
}

export interface Registry {
  packs: Pack[];
  tools: ResolvedTool[];
  skills: Skill[];
  /** Commands reachable by bare name: defined by exactly one active pack, by core, or aliased. */
  commands: Map<string, ResolvedCommand>;
  /** Every active command, keyed `<pack>:<command>`. */
  qualified: Map<string, ResolvedCommand>;
  /** Bare names more than one pack defines, with no alias settling them. */
  ambiguous: Map<string, ResolvedCommand[]>;
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

async function loadTsTool(pack: Pack, dir: string, file: string): Promise<ResolvedTool> {
  const mod = await import(file);
  const def: ToolDef | undefined = mod.default;
  if (!def || typeof def !== "object" || !def.commands) {
    throw new Error("index.ts must `export default defineTool({...})`");
  }
  const tool: ResolvedTool = {
    name: def.name,
    description: def.description,
    pack,
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
      qualified: `${pack.name}:${cmdName}`,
      description: cmd.description,
      tool,
      schema: z.toJSONSchema(cmd.args, { io: "input" }) as JSONSchema,
      positional: (cmd.positional as string[] | undefined) ?? [],
      def: cmd,
    });
  }
  return tool;
}

function loadExternalTool(pack: Pack, dir: string, file: string): ResolvedTool {
  const parsed = ToolJsonSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`invalid tool.json: ${z.prettifyError(parsed.error)}`);
  const def = parsed.data;
  if (!existsSync(join(dir, def.entry))) throw new Error(`entry ${def.entry} not found`);
  const tool: ResolvedTool = {
    name: def.name,
    description: def.description,
    pack,
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
      qualified: `${pack.name}:${cmdName}`,
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

/** A tool or skill counts unless it's disabled or lost a name collision. */
export function isActive(item: { disabled: boolean; conflict?: string }): boolean {
  return !item.disabled && !item.conflict;
}

/** `disabled` entries are `<pack>:<name>`; legacy bare entries match that name in every pack. */
export function isDisabled(disabled: string[], pack: Pack, name: string): boolean {
  return disabled.includes(`${pack.name}:${name}`) || disabled.includes(name);
}

/** Loads (and caches) the registry. Passing a config loads uncached against it, e.g. for a dry run. */
export async function loadRegistry(override?: Config): Promise<Registry> {
  if (cached && !override) return cached;
  installResolver();
  const config = override ?? loadConfig();
  const { packs, problems } = discoverPacks(config);
  const tools: ResolvedTool[] = [];
  const skills: Skill[] = [];
  for (const pack of packs) {
    if (depsStale(pack)) problems.push(`pack ${pack.name}: dependencies changed; run rig sync`);
    const mismatch = peerMismatch(pack);
    if (mismatch) problems.push(`pack ${pack.name}: ${mismatch}; its tools don't load`);
    else tools.push(...(await loadTools(pack, problems)));
    skills.push(...loadSkills(pack, problems));
  }
  for (const item of [...tools, ...skills]) item.disabled = isDisabled(config.disabled, item.pack, item.name);

  settleNames("tool", tools.filter(isActive), problems);
  settleNames("skill", skills.filter(isActive), problems);
  const active = tools.filter(isActive);
  for (const tool of active) {
    if (tool.description.length > TOOL_DESCRIPTION_MAX) {
      problems.push(`tool ${tool.name}: description is ${tool.description.length} chars; keep it to ${TOOL_DESCRIPTION_MAX} (it's the tool's line in \`rig ls\`)`);
    }
  }
  const reg = { packs, tools, skills, ...resolveCommands(active, config.aliases, problems), problems };
  if (!override) cached = reg;
  return reg;
}

/**
 * Tool and skill names must be unique across enabled packs (they set env prefixes and harness link
 * names). Against core, only the user pack's side is blocked; otherwise every side is, so nothing
 * silently wins.
 */
function settleNames(kind: "tool" | "skill", items: (ResolvedTool | Skill)[], problems: string[]): void {
  const byName = Map.groupBy(items, (item) => item.name);
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const core = group.find((item) => item.pack.name === CORE_PACK);
    if (core) {
      for (const item of group) {
        if (item === core) continue;
        item.conflict = `the core pack already defines ${kind} ${name}`;
        problems.push(`pack ${item.pack.name}: ${item.conflict}, so ${item.pack.name}:${name} is ignored; disable it with: rig remove ${item.pack.name}:${name}`);
      }
      continue;
    }
    const sides = group.map((item) => `${item.pack.name}:${name}`);
    for (const item of group) item.conflict = `${kind} ${name} is defined by ${sides.join(" and ")}`;
    problems.push(`${kind} ${name} is defined by ${sides.join(" and ")}; neither ${kind === "tool" ? "loads" : "is linked"} until one is disabled (rig remove ${sides[0]})`);
  }
}

function resolveCommands(
  tools: ResolvedTool[],
  aliases: Record<string, string>,
  problems: string[],
): Pick<Registry, "commands" | "qualified" | "ambiguous"> {
  const qualified = new Map<string, ResolvedCommand>();
  for (const tool of tools) {
    for (const cmd of tool.commands) {
      if (!NAME_RE.test(cmd.name)) {
        problems.push(`tool ${tool.name}: command "${cmd.name}" must be lowercase kebab-case`);
        continue;
      }
      const prior = qualified.get(cmd.qualified);
      if (prior) problems.push(`tool ${tool.name}: command "${cmd.name}" already defined by tool ${prior.tool.name} in pack ${tool.pack.name}`);
      else qualified.set(cmd.qualified, cmd);
    }
  }

  const coreNames = new Set([...qualified.values()].filter((cmd) => cmd.tool.pack.name === CORE_PACK).map((cmd) => cmd.name));
  const aliased = new Map<string, ResolvedCommand>();
  for (const [name, target] of Object.entries(aliases)) {
    const cmd = qualified.get(target);
    if (!NAME_RE.test(name)) problems.push(`alias "${name}" must be lowercase kebab-case`);
    else if (RESERVED.includes(name)) problems.push(`alias ${name}: can't override the built-in rig ${name}`);
    else if (coreNames.has(name)) problems.push(`alias ${name}: can't shadow the core command ${name}`);
    else if (!cmd) problems.push(`alias ${name}: no active command ${target}`);
    else aliased.set(name, cmd);
  }

  const commands = new Map<string, ResolvedCommand>();
  const ambiguous = new Map<string, ResolvedCommand[]>();
  for (const [name, defs] of Map.groupBy(qualified.values(), (cmd) => cmd.name)) {
    if (RESERVED.includes(name)) {
      for (const cmd of defs) problems.push(`tool ${cmd.tool.name}: command "${name}" is a reserved rig command; call it as rig ${cmd.qualified}`);
      continue;
    }
    const core = defs.find((cmd) => cmd.tool.pack.name === CORE_PACK);
    if (core) {
      commands.set(name, core);
      for (const cmd of defs) {
        if (cmd !== core) problems.push(`pack ${cmd.tool.pack.name}: command ${name} is already a core command; call it as rig ${cmd.qualified}`);
      }
      continue;
    }
    if (defs.length === 1) commands.set(name, defs[0]!);
    else if (!aliased.has(name)) {
      ambiguous.set(name, defs);
      const forms = defs.map((cmd) => cmd.qualified);
      problems.push(`command ${name} is defined by ${forms.join(" and ")}; call one by its qualified name, or set "aliases": { "${name}": "${forms[0]}" } in config`);
    }
  }
  for (const [name, cmd] of aliased) commands.set(name, cmd);
  return { commands, qualified, ambiguous };
}

/** Looks up `<pack>:<command>` or a bare name. */
export function findCommand(reg: Registry, name: string): ResolvedCommand | undefined {
  return name.includes(":") ? reg.qualified.get(name) : reg.commands.get(name);
}

async function loadTools(pack: Pack, problems: string[]): Promise<ResolvedTool[]> {
  const tools: ResolvedTool[] = [];
  const toolsDir = join(pack.dir, "tools");
  for (const name of subdirs(toolsDir)) {
    const dir = join(toolsDir, name);
    const ts = join(dir, "index.ts");
    const json = join(dir, "tool.json");
    try {
      let tool: ResolvedTool;
      if (existsSync(ts)) tool = await loadTsTool(pack, dir, ts);
      else if (existsSync(json)) tool = loadExternalTool(pack, dir, json);
      else throw new Error("needs index.ts or tool.json");

      if (tool.name !== name) throw new Error(`name "${tool.name}" must match its directory "${name}"`);
      if (!NAME_RE.test(name)) throw new Error("name must be lowercase kebab-case");
      tools.push(tool);
    } catch (err) {
      problems.push(`tool ${name}: ${(err as Error).message}`);
    }
  }
  return tools;
}

function loadSkills(pack: Pack, problems: string[]): Skill[] {
  const skills: Skill[] = [];
  const skillsDir = join(pack.dir, "skills");
  for (const name of subdirs(skillsDir)) {
    const dir = join(skillsDir, name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) {
      problems.push(`skill ${name}: missing SKILL.md`);
      continue;
    }
    const fm = parseFrontmatter(readFileSync(file, "utf8"));
    if (!fm.description) problems.push(`skill ${name}: SKILL.md frontmatter needs a description`);
    if (fm.name && fm.name !== name) problems.push(`skill ${name}: frontmatter name "${fm.name}" should match its directory`);
    skills.push({ name, pack, dir, description: fm.description, disabled: false });
  }
  return skills;
}

export function resetRegistry(): void {
  cached = undefined;
}
