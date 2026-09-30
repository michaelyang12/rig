import { RigError } from "../sdk";
import type { JSONSchema } from "./registry";

export interface ParsedArgs {
  args: Record<string, unknown>;
  json: boolean;
  help: boolean;
}

const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

function typeOf(prop: JSONSchema | undefined): string | undefined {
  if (!prop) return undefined;
  if (Array.isArray(prop.type)) return prop.type.find((t) => t !== "null");
  if (prop.type) return prop.type;
  const variant = (prop.anyOf as JSONSchema[] | undefined)?.find((s) => s.type && s.type !== "null");
  return variant ? typeOf(variant) : undefined;
}

function coerce(raw: string, prop: JSONSchema | undefined, flag: string): unknown {
  const type = typeOf(prop);
  switch (type) {
    case "number":
    case "integer": {
      const n = Number(raw);
      if (raw.trim() === "" || Number.isNaN(n)) throw new RigError("USAGE", `--${flag} expects a number, got "${raw}"`);
      return n;
    }
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new RigError("USAGE", `--${flag} expects true or false, got "${raw}"`);
    case "object":
      try {
        return JSON.parse(raw);
      } catch {
        throw new RigError("USAGE", `--${flag} expects JSON`);
      }
    default:
      return raw;
  }
}

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

/**
 * Turn argv into an args object using the command's JSON Schema:
 * `--flag value`, `--flag=value`, bare `--flag`/`--no-flag` for booleans, repeated flags for arrays,
 * positionals per the command's list, and `--input '<json>'` (or `--input -` for stdin) for whole-object input.
 */
export async function parseArgv(argv: string[], schema: JSONSchema, positional: string[]): Promise<ParsedArgs> {
  const props = schema.properties ?? {};
  const args: Record<string, unknown> = {};
  const loose: string[] = [];
  let json = false;
  let help = false;

  const resolveKey = (flag: string) => {
    if (flag in props) return flag;
    if (camel(flag) in props) return camel(flag);
    return undefined;
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      loose.push(...argv.slice(i + 1));
      break;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      loose.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const flag = eq === -1 ? token.slice(2) : token.slice(2, eq);
    let value: string | undefined = eq === -1 ? undefined : token.slice(eq + 1);

    if (flag === "input") {
      const raw = value ?? argv[++i];
      if (raw === undefined) throw new RigError("USAGE", "--input expects a JSON object or -");
      const text = raw === "-" ? await readStdin() : raw;
      try {
        Object.assign(args, JSON.parse(text));
      } catch {
        throw new RigError("USAGE", "--input is not valid JSON");
      }
      continue;
    }

    let key = resolveKey(flag);
    if (!key && flag.startsWith("no-")) {
      const negated = resolveKey(flag.slice(3));
      if (negated && typeOf(props[negated]) === "boolean" && value === undefined) {
        args[negated] = false;
        continue;
      }
    }
    if (!key) throw new RigError("USAGE", `unknown flag --${flag}`, "see --help for available flags");

    const prop = props[key];
    const type = typeOf(prop);
    if (value === undefined) {
      const next = argv[i + 1];
      if (type === "boolean" && (next === undefined || !["true", "false"].includes(next))) {
        args[key] = true;
        continue;
      }
      if (next === undefined) throw new RigError("USAGE", `--${flag} expects a value`);
      value = next;
      i++;
    }

    if (type === "array") {
      const item = coerce(value, prop?.items, flag);
      args[key] = [...((args[key] as unknown[]) ?? []), item];
    } else {
      args[key] = coerce(value, prop, flag);
    }
  }

  // Positionals fill the declared slots not already set by flags; an array slot takes the rest.
  const slots = positional.filter((k) => args[k] === undefined);
  for (let i = 0; i < loose.length; i++) {
    const key = slots.shift();
    if (!key) throw new RigError("USAGE", `unexpected argument "${loose[i]}"`, "see --help for usage");
    const prop = props[key];
    if (typeOf(prop) === "array") {
      args[key] = loose.slice(i).map((t) => coerce(t, prop?.items, key));
      break;
    }
    args[key] = coerce(loose[i]!, prop, key);
  }

  if (!help) {
    const missing = (schema.required ?? []).filter((k) => args[k] === undefined);
    if (missing.length) {
      throw new RigError("USAGE", `missing required ${missing.map((k) => "--" + kebab(k)).join(", ")}`, "see --help for usage");
    }
  }

  return { args, json, help };
}

export function renderHelp(command: string, description: string, schema: JSONSchema, positional: string[]): string {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const pos = positional
    .map((p) => {
      const label = kebab(p) + (typeOf(props[p]) === "array" ? "..." : "");
      return required.has(p) ? `<${label}>` : `[${label}]`;
    })
    .join(" ");
  const lines = [`Usage: rig ${command}${pos ? " " + pos : ""} [flags]`, "", description, ""];

  const rows = Object.entries(props).map(([key, prop]) => {
    const type = typeOf(prop) ?? "value";
    const shown = type === "array" ? `${typeOf(prop.items) ?? "value"}...` : type;
    const left = `--${kebab(key)} ${type === "boolean" ? "" : `<${shown}>`}`.trimEnd();
    const notes = [
      prop.description,
      prop.enum ? `one of: ${prop.enum.join(", ")}` : undefined,
      required.has(key) ? "(required)" : undefined,
      prop.default !== undefined ? `(default: ${JSON.stringify(prop.default)})` : undefined,
    ].filter(Boolean);
    return [left, notes.join(" ")] as const;
  });

  const width = Math.max(18, ...rows.map(([l]) => l.length)) + 2;
  if (rows.length) {
    lines.push("Flags:");
    for (const [left, right] of rows) lines.push(`  ${left.padEnd(width)}${right}`);
    lines.push("");
  }
  lines.push("Global:");
  lines.push(`  ${"--json".padEnd(width)}Output {ok, data} / {ok, error} JSON envelope`);
  lines.push(`  ${"--input <json|->".padEnd(width)}Pass all args as a JSON object (or from stdin)`);
  return lines.join("\n");
}
