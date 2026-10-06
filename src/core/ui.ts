// @module Terminal helpers for built-ins: colors (NO_COLOR-aware), tables, simple flag parsing.
import { RigError } from "../sdk";

const enabled = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open: number, close: number) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
};

export function table(rows: string[][], indent = 2): string {
  const strip = (s: string) => s.replace(/\x1b\[\d+m/g, "");
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => strip(r[i] ?? "").length))) ?? [];
  return rows
    .map((r) => " ".repeat(indent) + r.map((cell, i) => cell + " ".repeat(widths[i]! - strip(cell).length)).join("  ").trimEnd())
    .join("\n");
}

/** Pull `--flag` booleans out of argv, returning the remaining positionals. */
export function takeFlags(
  argv: string[],
  known: string[],
  valued: string[] = [],
): { flags: Set<string>; values: Map<string, string>; rest: string[] } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    if (valued.includes(name)) {
      const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (!value) throw new RigError("USAGE", `${name} needs a value`);
      values.set(name, value);
    } else if (known.includes(a)) flags.add(a);
    else throw new RigError("USAGE", `unknown flag ${a}`);
  }
  return { flags, values, rest };
}
