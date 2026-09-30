import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { defineCommand, defineTool, RigError, type Context } from "rig";

/** herdr's own rule for agent names; the slug doubles as one. */
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
/** Where the handoff brief lands inside a spawned worktree (git-excluded, never committed). */
export const HANDOFF = ".rig/handoff.md";
/** Repo-owned setup hook; when present it replaces lockfile-based dependency installs. */
export const SETUP_SCRIPT = ".rig/worktree-setup";

const KICKOFF = `Read ${HANDOFF}: it's a handoff brief from another agent session that spun off this worktree. Follow it, starting with anything it says to check first.`;

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface Agent {
  name?: string;
  agent: string;
  agent_status: AgentStatus;
  pane_id: string;
  workspace_id: string;
  cwd?: string;
  terminal_title_stripped?: string;
}

interface Workspace {
  workspace_id: string;
  label: string;
}

interface Worktree {
  branch?: string | null;
  label: string;
  path: string;
  open_workspace_id?: string | null;
  is_linked_worktree: boolean;
}

/** Thin wrapper over the `herdr` CLI. The installed binary is the authority on syntax, so rig never talks to the socket directly. */
export class Herdr {
  async raw(args: string[]): Promise<string> {
    if (!Bun.which("herdr")) throw new RigError("NOT_FOUND", "herdr is not installed", "brew install herdr, or see https://herdr.dev");
    const proc = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) {
      const detail = errorMessage(out) ?? errorMessage(err) ?? (err.trim() || out.trim() || `exit ${code}`);
      throw new RigError("UPSTREAM", `herdr ${args.slice(0, 2).join(" ")}: ${detail}`);
    }
    return out;
  }

  async json<T = any>(args: string[]): Promise<T> {
    const out = await this.raw(args);
    try {
      return JSON.parse(out).result as T;
    } catch {
      throw new RigError("UPSTREAM", `herdr ${args.slice(0, 2).join(" ")} returned non-JSON output`);
    }
  }

  agents = () => this.json<{ agents: Agent[] }>(["agent", "list"]).then((r) => r.agents);
  workspaces = () => this.json<{ workspaces: Workspace[] }>(["workspace", "list"]).then((r) => r.workspaces);
  worktrees = (cwd: string) => this.json<{ worktrees: Worktree[] }>(["worktree", "list", "--cwd", cwd]).then((r) => r.worktrees);
}

function errorMessage(text: string): string | undefined {
  try {
    const err = JSON.parse(text).error;
    if (err) return [err.code, err.message].filter(Boolean).join(": ");
  } catch {}
  return undefined;
}

/** herdr's skill forbids driving the focused session from outside it: an agent there could hijack the user's panes. */
export function requireHerdr(ctx: Pick<Context, "env">): void {
  if (ctx.env("HERDR_ENV") !== "1") {
    throw new RigError("USAGE", "not running inside a herdr pane (HERDR_ENV is not 1)", "start the agent from a herdr pane, or do this manually");
  }
}

function git(cwd: string, args: string[], { check = true } = {}): string {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (check && proc.exitCode !== 0) {
    throw new RigError("UPSTREAM", `git ${args.join(" ")}: ${proc.stderr.toString().trim()}`);
  }
  return proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
}

export function repoRoot(cwd: string): string {
  const root = git(cwd, ["rev-parse", "--show-toplevel"], { check: false });
  if (!root) throw new RigError("USAGE", `${cwd} is not inside a git repository`);
  return root;
}

/** origin/HEAD when it's set, else whichever of main/master exists locally, else the current branch. */
export function defaultBranch(repo: string): string {
  const remote = git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { check: false });
  if (remote) return remote.replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    if (git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], { check: false })) return b;
  }
  return git(repo, ["branch", "--show-current"]) || "HEAD";
}

export interface SetupReport {
  copied: string[];
  ran?: string;
  ok: boolean;
  error?: string;
}

/** Lockfile → install command, first match wins. */
const INSTALLERS: [lockfile: string, cmd: string[]][] = [
  ["bun.lock", ["bun", "install"]],
  ["bun.lockb", ["bun", "install"]],
  ["pnpm-lock.yaml", ["pnpm", "install"]],
  ["yarn.lock", ["yarn", "install"]],
  ["package-lock.json", ["npm", "install"]],
  ["uv.lock", ["uv", "sync"]],
];

/**
 * Make a fresh checkout runnable: copy ignored .env files over (git won't), then run the repo's own
 * setup script if it has one, otherwise install deps by lockfile. Failures are reported, not thrown:
 * the spawned agent can fix a broken install, but it can't recover a missing brief.
 */
export async function prepareWorktree(source: string, dest: string, log: (...a: unknown[]) => void): Promise<SetupReport> {
  const report: SetupReport = { copied: [], ok: true };
  const ignored = git(source, ["ls-files", "--others", "--ignored", "--exclude-standard"], { check: false });
  for (const rel of ignored.split("\n")) {
    const name = rel.split("/").pop() ?? "";
    if (!name.startsWith(".env") || rel.includes("node_modules/")) continue;
    const to = join(dest, rel);
    if (existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(source, rel), to);
    report.copied.push(rel);
  }

  const script = join(dest, SETUP_SCRIPT);
  const cmd = existsSync(script) ? [script] : INSTALLERS.find(([lock]) => existsSync(join(dest, lock)))?.[1];
  if (!cmd) return report;
  report.ran = cmd.join(" ");
  if (!existsSync(script) && !Bun.which(cmd[0]!)) {
    return { ...report, ok: false, error: `${cmd[0]} is not installed` };
  }
  log(`herdr-spawn: running ${report.ran} in ${dest}`);
  const proc = Bun.spawn(cmd, { cwd: dest, stdout: "pipe", stderr: "pipe", env: { ...process.env, RIG_SOURCE_CHECKOUT: source } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    const tail = (err.trim() || out.trim()).split("\n").slice(-5).join("\n");
    return { ...report, ok: false, error: `${report.ran} exited ${code}: ${tail}` };
  }
  return report;
}

/** Write the brief into the worktree and hide it from git via the shared info/exclude. */
export function placeBrief(worktree: string, brief: string): string {
  const path = join(worktree, HANDOFF);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, brief.endsWith("\n") ? brief : brief + "\n");
  const common = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const exclude = join(common, "info", "exclude");
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!current.split("\n").includes(`/${HANDOFF}`)) {
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}/${HANDOFF}\n`);
  }
  return path;
}

export interface SpawnResult {
  agent: string;
  kind: string;
  status: "started" | "blocked";
  branch: string;
  base: string;
  path: string;
  workspaceId: string;
  paneId: string;
  brief: string;
  setup: SetupReport | null;
  note?: string;
}

export interface SpawnArgs {
  slug: string;
  brief: string;
  kind: string;
  base?: string;
  branch?: string;
  cwd?: string;
  focus: boolean;
  setup: boolean;
  agentArgs?: string[];
}

export async function spawnSession(a: SpawnArgs, ctx: Pick<Context, "env" | "log">, herdr = new Herdr()): Promise<SpawnResult> {
  requireHerdr(ctx);
  const briefPath = resolve(a.brief);
  if (!existsSync(briefPath) || !statSync(briefPath).isFile()) throw new RigError("USAGE", `brief not found: ${a.brief}`);
  const brief = readFileSync(briefPath, "utf8");
  if (!brief.trim()) throw new RigError("USAGE", `brief is empty: ${a.brief}`);

  const repo = repoRoot(a.cwd ?? process.cwd());
  const base = a.base ?? defaultBranch(repo);
  const branch = a.branch ?? `feature/${a.slug}`;
  if (git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { check: false })) {
    throw new RigError("USAGE", `branch ${branch} already exists`, `pick another slug, or pass --branch; to reopen it: herdr worktree open --branch ${branch}`);
  }
  if ((await herdr.agents()).some((ag) => ag.name === a.slug)) {
    throw new RigError("USAGE", `a live agent is already named ${a.slug}`, "pick another slug (see: rig herdr-peers)");
  }

  const repoName = repo.split("/").pop()!;
  const created = await herdr.json<{ workspace: Workspace; worktree: Worktree }>([
    "worktree", "create", "--cwd", repo, "--branch", branch, "--base", base,
    "--label", `${repoName}-${a.slug}`, a.focus ? "--focus" : "--no-focus",
  ]);
  const workspaceId = created.workspace.workspace_id;
  const path = created.worktree.path;
  const { panes } = await herdr.json<{ panes: { pane_id: string }[] }>(["pane", "list", "--workspace", workspaceId]);
  const paneId = panes[0]?.pane_id;
  if (!paneId) throw new RigError("UPSTREAM", `workspace ${workspaceId} has no pane to start the agent in`);

  const setup = a.setup ? await prepareWorktree(repo, path, ctx.log) : null;
  if (setup && !setup.ok) ctx.log(`herdr-spawn: setup failed, continuing: ${setup.error}`);
  const placed = placeBrief(path, brief);

  const result: SpawnResult = { agent: a.slug, kind: a.kind, status: "started", branch, base, path, workspaceId, paneId, brief: placed, setup };
  const extra = a.agentArgs?.length ? ["--", ...a.agentArgs] : [];
  try {
    await herdr.json(["agent", "start", a.slug, "--kind", a.kind, "--pane", paneId, ...extra]);
  } catch (err) {
    // Usually a first-run trust or login prompt in the new directory: the agent exists but needs a human.
    if (err instanceof RigError && err.message.includes("agent_not_ready")) {
      return { ...result, status: "blocked", note: `${a.kind} is waiting on a startup prompt in ${paneId}; ask the user to answer it, then run: herdr agent prompt ${a.slug} "${KICKOFF}"` };
    }
    throw err;
  }
  // No --wait: the caller keeps working while the new session reads its brief.
  await herdr.json(["agent", "prompt", a.slug, KICKOFF]);
  return result;
}

export interface Peer {
  target: string;
  kind: string;
  status: AgentStatus;
  workspace: string;
  pane: string;
  cwd?: string;
  title?: string;
  tail?: string;
}

const NEEDS_YOU: AgentStatus[] = ["blocked", "done"];

export async function listPeers(
  a: { waiting: boolean; workspace?: string; lines: number },
  ctx: Pick<Context, "env">,
  herdr = new Herdr(),
): Promise<Peer[]> {
  requireHerdr(ctx);
  const [agents, workspaces] = await Promise.all([herdr.agents(), herdr.workspaces()]);
  const labels = new Map(workspaces.map((w) => [w.workspace_id, w.label]));
  const self = ctx.env("HERDR_PANE_ID");
  const peers = agents
    .filter((ag) => ag.pane_id !== self)
    .filter((ag) => !a.waiting || NEEDS_YOU.includes(ag.agent_status))
    .filter((ag) => !a.workspace || ag.workspace_id === a.workspace || labels.get(ag.workspace_id) === a.workspace)
    .map<Peer>((ag) => ({
      target: ag.name ?? ag.pane_id,
      kind: ag.agent,
      status: ag.agent_status,
      workspace: labels.get(ag.workspace_id) ?? ag.workspace_id,
      pane: ag.pane_id,
      cwd: ag.cwd,
      title: ag.terminal_title_stripped || undefined,
    }));
  if (a.lines > 0) {
    await Promise.all(
      peers.map(async (p) => {
        const out = await herdr.raw(["agent", "read", p.target, "--source", "recent-unwrapped", "--lines", String(a.lines)]).catch(() => "");
        p.tail = out.trimEnd() || undefined;
      }),
    );
  }
  return peers;
}

function formatPeers(peers: Peer[]): string {
  if (!peers.length) return "no other agents";
  return peers
    .map((p) => {
      const head = [p.target, p.kind, p.status, p.workspace, p.title].filter(Boolean).join("\t");
      return p.tail ? `${head}\n${p.tail.replace(/^/gm, "    ")}` : head;
    })
    .join("\n");
}

export interface LandResult {
  branch: string;
  path: string;
  workspaceId: string;
  removed: true;
  branchDeleted: boolean;
}

export async function landSession(
  a: { target: string; base?: string; force: boolean; keepBranch: boolean; cwd?: string },
  ctx: Pick<Context, "env" | "log">,
  herdr = new Herdr(),
): Promise<LandResult> {
  requireHerdr(ctx);
  const repo = repoRoot(a.cwd ?? process.cwd());
  const worktrees = (await herdr.worktrees(repo)).filter((w) => w.is_linked_worktree);
  const agents = await herdr.agents();
  const byAgent = agents.find((ag) => ag.name === a.target || ag.pane_id === a.target);
  const wt = worktrees.find(
    (w) =>
      w.branch === a.target ||
      w.branch === `feature/${a.target}` ||
      w.label === a.target ||
      w.open_workspace_id === a.target ||
      (byAgent && w.open_workspace_id === byAgent.workspace_id) ||
      (isAbsolute(a.target) && w.path === a.target),
  );
  if (!wt) {
    const known = worktrees.map((w) => w.branch ?? w.path).join(", ") || "none";
    throw new RigError("NOT_FOUND", `no linked worktree of ${repo} matches "${a.target}"`, `linked worktrees: ${known}`);
  }
  if (!wt.open_workspace_id) {
    throw new RigError("USAGE", `${wt.path} has no open herdr workspace`, `remove it with: git worktree remove ${wt.path}`);
  }
  if (wt.open_workspace_id === ctx.env("HERDR_WORKSPACE_ID")) {
    throw new RigError("USAGE", "refusing to land the workspace this agent is running in", "run herdr-land from another session");
  }

  const branch = wt.branch ?? "";
  const base = a.base ?? defaultBranch(repo);
  if (!a.force) {
    const dirty = git(wt.path, ["status", "--porcelain", "--untracked-files=all"], { check: false })
      .split("\n")
      .filter((l) => l && !l.endsWith(HANDOFF));
    if (dirty.length) {
      throw new RigError("USAGE", `${wt.path} has uncommitted changes:\n${dirty.slice(0, 10).join("\n")}`, "commit or discard them, or pass --force");
    }
    if (branch && !isAncestor(repo, branch, base)) {
      throw new RigError("USAGE", `${branch} is not merged into ${base}`, "merge it (or open a PR) first; pass --force if it was squash-merged or should be dropped");
    }
    const busy = agents.find((ag) => ag.workspace_id === wt.open_workspace_id && ag.agent_status === "working");
    if (busy) throw new RigError("USAGE", `${busy.name ?? busy.pane_id} is still working in that workspace`, "wait for it, or pass --force");
  }

  await herdr.json(["worktree", "remove", "--workspace", wt.open_workspace_id, ...(a.force ? ["--force"] : [])]);
  let branchDeleted = false;
  if (branch && !a.keepBranch) {
    // -d refuses unmerged branches, so --force never silently destroys unmerged commits.
    branchDeleted = Bun.spawnSync(["git", "-C", repo, "branch", "-d", branch], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    if (!branchDeleted) ctx.log(`herdr-land: kept branch ${branch} (not fully merged)`);
  }
  return { branch, path: wt.path, workspaceId: wt.open_workspace_id, removed: true, branchDeleted };
}

function isAncestor(repo: string, branch: string, base: string): boolean {
  return Bun.spawnSync(["git", "-C", repo, "merge-base", "--is-ancestor", branch, base]).exitCode === 0;
}

/** herdr's bundled agent skill, regenerated on every `rig sync` so it tracks the installed version. */
function herdrReference(): string | undefined {
  if (!Bun.which("herdr")) return undefined;
  const proc = Bun.spawnSync(["herdr", "--skill"], { stdout: "pipe", stderr: "ignore" });
  if (proc.exitCode !== 0) return undefined;
  const body = proc.stdout.toString().replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "");
  const version = Bun.spawnSync(["herdr", "--version"], { stdout: "pipe" }).stdout.toString().trim();
  return `<!-- Generated by \`rig sync\` from \`herdr --skill\` (${version}). Do not edit. -->\n\n${body}`;
}

export default defineTool({
  name: "herdr",
  description:
    "Orchestrate parallel coding-agent sessions in herdr (the terminal workspace manager the user runs agents in). Use when the user wants to spin a feature off into its own worktree + agent session, check what their other agents are doing, or clean up a finished session",
  skillFiles: () => ({ "reference.md": herdrReference() }),
  commands: {
    "herdr-spawn": defineCommand({
      description:
        "Start a new agent session for a feature: creates a git worktree on feature/<slug> in its own herdr workspace, copies .env files and installs deps, drops the brief at .rig/handoff.md, starts the agent, and tells it to read the brief. Returns without waiting for the agent",
      args: z.object({
        slug: z.string().regex(AGENT_NAME, "slug must match [a-z][a-z0-9_-]{0,31}").describe("Short feature slug; becomes the agent name and branch feature/<slug>"),
        brief: z.string().describe("Path to the handoff brief (markdown) the new agent starts from"),
        kind: z.string().default("claude").describe("Agent kind: claude, codex, pi, opencode, … (see `herdr agent start --help`)"),
        base: z.string().optional().describe("Ref to branch from (default: the repo's default branch)"),
        branch: z.string().optional().describe("Branch name override (default: feature/<slug>)"),
        cwd: z.string().optional().describe("Any path inside the source repo (default: current directory)"),
        focus: z.boolean().default(false).describe("Switch the herdr UI to the new workspace"),
        setup: z.boolean().default(true).describe("Copy .env files and run .rig/worktree-setup or a lockfile install"),
        agentArgs: z.array(z.string()).optional().describe("Extra CLI args passed through to the agent"),
      }),
      positional: ["slug"],
      run: (args, ctx) => spawnSession(args, ctx),
      format: (r: SpawnResult) =>
        [
          `${r.status === "started" ? "started" : "BLOCKED"} ${r.agent} (${r.kind}) in ${r.workspaceId} ${r.paneId}`,
          `branch  ${r.branch} (from ${r.base})`,
          `path    ${r.path}`,
          r.setup && `setup   ${r.setup.ok ? "ok" : `failed: ${r.setup.error}`}${r.setup.copied.length ? `; copied ${r.setup.copied.join(", ")}` : ""}${r.setup.ran ? `; ran ${r.setup.ran}` : ""}`,
          r.note,
        ]
          .filter(Boolean)
          .join("\n"),
    }),

    "herdr-peers": defineCommand({
      description:
        "List the other agents running in herdr with their state (idle, working, blocked, done, unknown), workspace, and title; optionally the last lines of each one's output",
      args: z.object({
        waiting: z.boolean().default(false).describe("Only agents that need the user: blocked or done"),
        workspace: z.string().optional().describe("Only this workspace (id like w3, or its label)"),
        lines: z.number().int().min(0).max(200).default(0).describe("Include this many recent output lines per agent"),
      }),
      run: (args, ctx) => listPeers(args, ctx),
      format: formatPeers,
    }),

    "herdr-land": defineCommand({
      description:
        "Clean up a finished herdr-spawn session: checks the worktree is clean, merged, and idle, then removes the worktree and its workspace and deletes the merged branch",
      args: z.object({
        target: z.string().describe("Slug, agent name, branch, workspace id, or worktree path"),
        base: z.string().optional().describe("Branch it must be merged into (default: the repo's default branch)"),
        force: z.boolean().default(false).describe("Skip the clean/merged/idle checks and force-remove the worktree"),
        keepBranch: z.boolean().default(false).describe("Keep the branch after removing the worktree"),
        cwd: z.string().optional().describe("Any path inside the source repo (default: current directory)"),
      }),
      positional: ["target"],
      run: (args, ctx) => landSession(args, ctx),
      format: (r: LandResult) => `removed ${r.path} (${r.workspaceId})${r.branch ? `; branch ${r.branch} ${r.branchDeleted ? "deleted" : "kept"}` : ""}`,
    }),
  },
});
