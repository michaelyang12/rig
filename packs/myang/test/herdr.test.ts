import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RigError } from "rig";
import { HANDOFF, Herdr, landSession, listPeers, prepareWorktree, spawnSession, type Agent } from "../tools/herdr";

const IN_HERDR = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" };
const ctxWith = (env: Record<string, string> = IN_HERDR) => ({ env: (n: string) => env[n], log: () => {} });

function sh(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", cwd, ...args], { stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
}

/**
 * Stand-in for the herdr CLI. `worktree create` makes a real git worktree so the rest of the
 * pipeline (setup, brief, git checks) runs against real files.
 */
class FakeHerdr extends Herdr {
  calls: string[][] = [];
  agentList: Agent[] = [];
  worktreeList: object[] = [];
  startError?: string;

  constructor(private worktreeRoot: string) {
    super();
  }

  override async raw(args: string[]): Promise<string> {
    this.calls.push(args);
    const ok = (result: object) => JSON.stringify({ id: "x", result });
    const [group, verb] = args;
    const flag = (name: string) => args[args.indexOf(name) + 1]!;
    if (group === "agent" && verb === "list") return ok({ agents: this.agentList });
    if (group === "workspace" && verb === "list") return ok({ workspaces: [{ workspace_id: "w1", label: "home" }, { workspace_id: "w9", label: "repo-feat" }] });
    if (group === "worktree" && verb === "list") return ok({ worktrees: this.worktreeList });
    if (group === "worktree" && verb === "create") {
      const path = join(this.worktreeRoot, flag("--branch").replace("/", "-"));
      sh(flag("--cwd"), "worktree", "add", "-b", flag("--branch"), path, flag("--base"));
      return ok({ workspace: { workspace_id: "w9", label: flag("--label") }, worktree: { path, branch: flag("--branch"), label: "x", is_linked_worktree: true } });
    }
    if (group === "pane" && verb === "list") return ok({ panes: [{ pane_id: "w9:p1" }] });
    if (group === "agent" && verb === "start") {
      if (this.startError) throw new RigError("UPSTREAM", `herdr agent start: ${this.startError}`);
      return ok({ type: "agent_started" });
    }
    if (group === "agent" && verb === "read") return `output of ${args[2]}\n`;
    return ok({ type: "ok" });
  }

  called = (group: string, verb: string) => this.calls.find((c) => c[0] === group && c[1] === verb);
}

let dir: string;
let repo: string;
let herdr: FakeHerdr;
let brief: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "rig-herdr-")));
  repo = join(dir, "repo");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), ".env*\n");
  writeFileSync(join(repo, "README.md"), "hi\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  brief = join(dir, "brief.md");
  writeFileSync(brief, "# Feature\n\n## Goal\nDo it.\n");
  herdr = new FakeHerdr(join(dir, "worktrees"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const spawnArgs = (over: object = {}) => ({ slug: "feat", brief, kind: "claude", cwd: repo, focus: false, setup: true, ...over });

describe("herdr-spawn", () => {
  test("refuses to run outside herdr", async () => {
    await expect(spawnSession(spawnArgs(), ctxWith({}), herdr)).rejects.toThrow("not running inside a herdr pane");
    expect(herdr.calls).toEqual([]);
  });

  test("creates the worktree, copies .env, places a git-excluded brief, starts and prompts the agent", async () => {
    const r = await spawnSession(spawnArgs(), ctxWith(), herdr);
    expect(r).toMatchObject({ agent: "feat", status: "started", branch: "feature/feat", base: "main", workspaceId: "w9", paneId: "w9:p1" });
    expect(herdr.called("worktree", "create")).toContain("--no-focus");
    expect(readFileSync(join(r.path, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(r.setup).toEqual({ copied: [".env"], ok: true });
    expect(readFileSync(join(r.path, HANDOFF), "utf8")).toContain("## Goal");
    expect(Bun.spawnSync(["git", "-C", r.path, "status", "--porcelain"]).stdout.toString()).toBe("");
    expect(herdr.called("agent", "start")).toEqual(["agent", "start", "feat", "--kind", "claude", "--pane", "w9:p1"]);
    expect(herdr.called("agent", "prompt")?.[3]).toContain(HANDOFF);
  });

  test("passes agent args after --", async () => {
    await spawnSession(spawnArgs({ kind: "codex", agentArgs: ["--model", "x"] }), ctxWith(), herdr);
    expect(herdr.called("agent", "start")?.slice(-3)).toEqual(["--", "--model", "x"]);
  });

  test("refuses an existing branch or a taken agent name before creating anything", async () => {
    sh(repo, "branch", "feature/feat");
    await expect(spawnSession(spawnArgs(), ctxWith(), herdr)).rejects.toThrow("branch feature/feat already exists");
    herdr.agentList = [{ name: "other", agent: "claude", agent_status: "idle", pane_id: "w2:p1", workspace_id: "w2" }];
    await expect(spawnSession(spawnArgs({ slug: "other" }), ctxWith(), herdr)).rejects.toThrow("already named other");
    expect(herdr.called("worktree", "create")).toBeUndefined();
  });

  test("reports a blocked startup instead of prompting", async () => {
    herdr.startError = "agent_not_ready: blocked";
    const r = await spawnSession(spawnArgs(), ctxWith(), herdr);
    expect(r.status).toBe("blocked");
    expect(r.note).toContain("herdr agent prompt feat");
    expect(herdr.called("agent", "prompt")).toBeUndefined();
  });
});

describe("prepareWorktree", () => {
  test("a repo setup script replaces the lockfile install, and failures are reported not thrown", async () => {
    const dest = join(dir, "dest");
    mkdirSync(join(dest, ".rig"), { recursive: true });
    writeFileSync(join(dest, "bun.lock"), "");
    const script = join(dest, ".rig", "worktree-setup");
    writeFileSync(script, '#!/bin/sh\necho "from $RIG_SOURCE_CHECKOUT" > marker\nexit 3\n');
    chmodSync(script, 0o755);
    const r = await prepareWorktree(repo, dest, () => {});
    expect(r.ran).toBe(script);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("exited 3");
    expect(readFileSync(join(dest, "marker"), "utf8")).toBe(`from ${repo}\n`);
  });
});

describe("herdr-peers", () => {
  beforeEach(() => {
    herdr.agentList = [
      { agent: "claude", agent_status: "working", pane_id: "w1:p1", workspace_id: "w1" },
      { name: "feat", agent: "codex", agent_status: "blocked", pane_id: "w9:p1", workspace_id: "w9", terminal_title_stripped: "Feature" },
      { agent: "claude", agent_status: "working", pane_id: "w1:p2", workspace_id: "w1" },
    ];
  });

  test("lists everyone but the caller, by name when there is one, with workspace labels", async () => {
    const peers = await listPeers({ waiting: false, lines: 0 }, ctxWith(), herdr);
    expect(peers.map((p) => [p.target, p.workspace, p.status])).toEqual([
      ["feat", "repo-feat", "blocked"],
      ["w1:p2", "home", "working"],
    ]);
  });

  test("--waiting keeps blocked/done; --workspace matches a label; --lines reads output", async () => {
    const waiting = await listPeers({ waiting: true, lines: 0 }, ctxWith(), herdr);
    expect(waiting.map((p) => p.target)).toEqual(["feat"]);
    const home = await listPeers({ waiting: false, workspace: "home", lines: 5 }, ctxWith(), herdr);
    expect(home).toMatchObject([{ target: "w1:p2", tail: "output of w1:p2" }]);
  });
});

describe("herdr-land", () => {
  let wt: string;
  beforeEach(() => {
    wt = join(dir, "worktrees", "feature-feat");
    sh(repo, "worktree", "add", "-q", "-b", "feature/feat", wt, "main");
    herdr.worktreeList = [
      { branch: "main", label: "repo", path: repo, open_workspace_id: "w1", is_linked_worktree: false },
      { branch: "feature/feat", label: "repo-feat", path: wt, open_workspace_id: "w9", is_linked_worktree: true },
    ];
  });
  const land = (over: object = {}, env = IN_HERDR) =>
    landSession({ target: "feat", force: false, keepBranch: false, cwd: repo, ...over }, ctxWith(env), herdr);
  const branchExists = () => Bun.spawnSync(["git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/feature/feat"]).exitCode === 0;

  test("refuses uncommitted changes (ignoring the brief)", async () => {
    mkdirSync(join(wt, ".rig"));
    writeFileSync(join(wt, HANDOFF), "brief");
    writeFileSync(join(wt, "wip.ts"), "x");
    await expect(land()).rejects.toThrow("uncommitted changes:\n?? wip.ts");
  });

  test("refuses an unmerged branch unless forced", async () => {
    writeFileSync(join(wt, "new.ts"), "x");
    sh(wt, "add", ".");
    sh(wt, "commit", "-qm", "work");
    await expect(land()).rejects.toThrow("feature/feat is not merged into main");
    const r = await land({ force: true });
    expect(herdr.called("worktree", "remove")).toEqual(["worktree", "remove", "--workspace", "w9", "--force"]);
    expect(r.branchDeleted).toBe(false);
    expect(branchExists()).toBe(true);
  });

  test("refuses while its agent is working", async () => {
    herdr.agentList = [{ name: "feat", agent: "claude", agent_status: "working", pane_id: "w9:p1", workspace_id: "w9" }];
    await expect(land()).rejects.toThrow("feat is still working");
  });

  test("refuses to land the caller's own workspace", async () => {
    await expect(land({}, { ...IN_HERDR, HERDR_WORKSPACE_ID: "w9" })).rejects.toThrow("running in");
  });

  test("removes a merged, clean, idle session and deletes its branch", async () => {
    const r = await land({ target: "feature/feat" });
    expect(r).toEqual({ branch: "feature/feat", path: wt, workspaceId: "w9", removed: true, branchDeleted: false });
    // The fake doesn't really remove the worktree, so git keeps the branch checked out; do it and retry deletion.
    sh(repo, "worktree", "remove", wt);
    const again = await land({ target: "repo-feat" });
    expect(again.branchDeleted).toBe(true);
    expect(branchExists()).toBe(false);
  });

  test("an unknown target lists the linked worktrees", async () => {
    await expect(land({ target: "nope" })).rejects.toThrow("no linked worktree");
  });
});
