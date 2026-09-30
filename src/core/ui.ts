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
export function takeFlags(argv: string[], known: string[]): { flags: Set<string>; rest: string[] } {
  const flags = new Set<string>();
  const rest: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--")) {
      if (!known.includes(a)) throw new RigError("USAGE", `unknown flag ${a}`);
      flags.add(a);
    } else rest.push(a);
  }
  return { flags, rest };
}
