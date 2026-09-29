import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "./paths";

export type VarSource = "env" | "file";

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, rest] = m as unknown as [string, string, string];
    out[key] = unquote(rest);
  }
  return out;
}

function unquote(v: string): string {
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\(["\\n])/g, (_, c) => (c === "n" ? "\n" : c));
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
  const hash = v.search(/\s#/);
  return hash === -1 ? v : v.slice(0, hash).trimEnd();
}

function quote(v: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]*$/.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function readEnvFile(): Record<string, string> {
  return existsSync(paths.envFile) ? parseDotenv(readFileSync(paths.envFile, "utf8")) : {};
}

/** Resolve a variable: process env wins over the rig .env file. */
export function lookupVar(
  name: string,
  file: Record<string, string> = readEnvFile(),
): { value: string; source: VarSource } | undefined {
  const fromEnv = process.env[name];
  if (fromEnv) return { value: fromEnv, source: "env" };
  const fromFile = file[name];
  if (fromFile) return { value: fromFile, source: "file" };
  return undefined;
}

/** Update keys in place (preserving comments and order), append new ones, keep the file 0600. */
export function upsertEnvFile(updates: Record<string, string>): void {
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  const lines = existsSync(paths.envFile) ? readFileSync(paths.envFile, "utf8").split("\n") : [];
  if (lines.at(-1) === "") lines.pop();

  const pending = new Map(Object.entries(updates));
  const next = lines.map((line) => {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      return `${key}=${quote(value)}`;
    }
    return line;
  });
  for (const [key, value] of pending) next.push(`${key}=${quote(value)}`);

  writeFileSync(paths.envFile, next.join("\n") + "\n", { mode: 0o600 });
  chmodSync(paths.envFile, 0o600);
}
