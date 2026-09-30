import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineCommand, defineTool } from "rig";

type Status = "free" | "taken" | "error";

export interface Check {
  status: Status;
  detail?: string;
}

export interface NameReport {
  name: string;
  verdict: "clear" | "conflict";
  conflicts: string[];
  checks: Record<string, Check>;
}

const SOURCES = ["local", "source", "brew", "github", "npm", "pypi", "crates"] as const;
type Source = (typeof SOURCES)[number];

/** Taken on these means the name would actually collide with something you use or own. */
const BLOCKING: Source[] = ["local", "source", "brew", "github"];
/** npm squatting is everywhere; only flag packages people actually use. */
const NPM_POPULAR = 10_000;
const TIMEOUT_MS = 6_000;

async function probe(url: string, headers: Record<string, string> = {}): Promise<Response | Check> {
  try {
    return await fetch(url, {
      headers: { "user-agent": "rig-mint-check (https://github.com/michaelyang12/rig)", ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { status: "error", detail: (err as Error).name === "TimeoutError" ? "timeout" : (err as Error).message };
  }
}

/** 200 → taken, 404 → free, anything else → error. */
async function exists(url: string, headers?: Record<string, string>): Promise<Check> {
  const res = await probe(url, headers);
  if (!(res instanceof Response)) return res;
  if (res.status === 404) return { status: "free" };
  if (res.ok) return { status: "taken" };
  return { status: "error", detail: `HTTP ${res.status}` };
}

const checks: Record<Source, (name: string, opts: { sourceDir: string; owner?: string }) => Promise<Check>> = {
  async local(name) {
    const path = Bun.which(name);
    return path ? { status: "taken", detail: path } : { status: "free" };
  },

  async source(name, { sourceDir }) {
    if (!existsSync(sourceDir)) return { status: "error", detail: `${sourceDir} not found` };
    const hit = readdirSync(sourceDir).find((d) => d.toLowerCase() === name);
    return hit ? { status: "taken", detail: join(sourceDir, hit) } : { status: "free" };
  },

  async brew(name) {
    const [formula, cask] = await Promise.all([
      exists(`https://formulae.brew.sh/api/formula/${name}.json`),
      exists(`https://formulae.brew.sh/api/cask/${name}.json`),
    ]);
    if (formula.status === "taken") return { status: "taken", detail: "formula" };
    if (cask.status === "taken") return { status: "taken", detail: "cask" };
    return formula.status === "error" ? formula : cask;
  },

  async github(name, { owner }) {
    if (!owner) return { status: "error", detail: "no GitHub owner (pass --owner)" };
    const check = await exists(`https://api.github.com/repos/${owner}/${name}`, { accept: "application/vnd.github+json" });
    return check.status === "taken" ? { status: "taken", detail: `${owner}/${name}` } : check;
  },

  async npm(name) {
    const check = await exists(`https://registry.npmjs.org/${name}`);
    if (check.status !== "taken") return check;
    const res = await probe(`https://api.npmjs.org/downloads/point/last-week/${name}`);
    if (!(res instanceof Response) || !res.ok) return check;
    const { downloads } = (await res.json()) as { downloads?: number };
    return { status: "taken", detail: `${(downloads ?? 0).toLocaleString("en-US")}/wk` };
  },

  async pypi(name) {
    return exists(`https://pypi.org/pypi/${name}/json`);
  },

  async crates(name) {
    return exists(`https://crates.io/api/v1/crates/${name}`);
  },
};

function npmWeekly(check: Check | undefined): number {
  return Number(check?.detail?.replace(/[^0-9]/g, "") || 0);
}

export function verdict(name: string, results: Record<string, Check>): NameReport {
  const conflicts: string[] = [];
  for (const source of BLOCKING) {
    const check = results[source];
    if (check?.status === "taken") conflicts.push(`${source}${check.detail ? ` (${check.detail})` : ""}`);
  }
  if (results.npm?.status === "taken" && npmWeekly(results.npm) >= NPM_POPULAR) {
    conflicts.push(`npm (popular: ${results.npm.detail})`);
  }
  return { name, verdict: conflicts.length ? "conflict" : "clear", conflicts, checks: results };
}

async function githubLogin(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["gh", "api", "user", "--jq", ".login"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && out ? out : undefined;
  } catch {
    return undefined;
  }
}

function cell(check: Check | undefined): string {
  if (!check) return "-";
  if (check.status === "free") return "free";
  if (check.status === "error") return `err${check.detail ? ` (${check.detail})` : ""}`;
  return check.detail && !check.detail.startsWith("/") ? `taken (${check.detail})` : "taken";
}

export function formatReports(reports: NameReport[]): string {
  const rows = [["name", "verdict", ...SOURCES], ...reports.map((r) => [r.name, r.verdict, ...SOURCES.map((s) => cell(r.checks[s]))])];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  const lines = rows.map((row) => row.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd());
  const notes = reports.filter((r) => r.conflicts.length).map((r) => `${r.name}: ${r.conflicts.join(", ")}`);
  return [...lines, ...(notes.length ? ["", "Conflicts:", ...notes.map((n) => `  ${n}`)] : [])].join("\n");
}

export default defineTool({
  name: "mint",
  description: "Check whether a project, repo, or CLI name is already taken before suggesting it",
  commands: {
    "mint-check": defineCommand({
      description: "Check whether project names are free: local commands, ~/Source, Homebrew, your GitHub, npm, PyPI, crates.io",
      args: z.object({
        names: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "names must be lowercase")).min(1).describe("Candidate names"),
        owner: z.string().optional().describe("GitHub owner to check for existing repos (default: your gh login)"),
        sourceDir: z.string().default(join(homedir(), "Source")).describe("Where your projects live"),
      }),
      positional: ["names"],
      async run({ names, owner, sourceDir }) {
        const opts = { sourceDir, owner: owner ?? (await githubLogin()) };
        return Promise.all(
          names.map(async (name) => {
            const entries = await Promise.all(SOURCES.map(async (s) => [s, await checks[s](name, opts)] as const));
            return verdict(name, Object.fromEntries(entries));
          }),
        );
      },
      format: formatReports,
    }),
  },
});
