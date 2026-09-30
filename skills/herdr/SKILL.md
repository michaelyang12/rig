---
name: herdr
description: Use when the user wants to spin work off into a parallel agent session ("start a new session for this feature", "spin this off", "have another agent do X in a worktree"), asks what their other agents are doing or which ones need them, wants to clean up / land a finished session, or mentions herdr panes, tabs, workspaces, or agents. Only works when running inside herdr (HERDR_ENV=1).
---

# herdr sessions

herdr is the terminal workspace manager the user runs coding agents in. rig wraps its multi-step workflows as single commands:

| Command | Use it for |
|---|---|
| `rig herdr-spawn <slug> --brief <file>` | Start a new worktree + workspace + agent for a feature, handing it a brief |
| `rig herdr-peers [--waiting] [--lines N]` | See the other agents: status, workspace, title, recent output |
| `rig herdr-land <slug>` | Remove a finished session's worktree, workspace, and merged branch |

First check `test "${HERDR_ENV:-}" = 1`. If it fails you are not inside herdr: say so and stop. Do not drive herdr from outside it.

## Spawning a session for a feature

When the user says something like "let's start a new session for this feature":

1. **Pick a slug**: short kebab-case, `[a-z][a-z0-9_-]{0,31}` (e.g. `bus-retry`). It becomes the agent name and branch `feature/<slug>`. Confirm it only if the feature is ambiguous.
2. **Write the brief.** The new agent starts with zero context, and the brief is the only thing it gets, so make it self-contained. Write it to a scratch file (your scratchpad directory, or `$TMPDIR`), not into the current repo, using this template:

   ```markdown
   # <Feature name>

   ## Goal
   What to build and why, in 2-4 sentences. The user-visible outcome.

   ## Decided
   Choices already made in this conversation (approach, libraries, naming, scope cuts) and the reason for each,
   so the new session doesn't reopen them.

   ## Context
   - Relevant files and what matters in each (`path:line` where useful)
   - Related prior work, commands, docs, or links
   - Gotchas already discovered

   ## Open questions
   Things still undecided. Say which ones to ask the user about vs. decide alone.

   ## Done when
   Concrete acceptance checks: tests passing, behavior verified, docs updated. Say whether to commit, and whether to open a PR.
   ```

   Write only what's been established. Leave a section as "none" rather than inventing content, and don't paste the whole conversation.
3. **Spawn**: `rig herdr-spawn <slug> --brief <file>`. The defaults are `--kind claude`, branch from the repo's default branch, and focus stays with the user. Pass `--kind codex` etc. if the user names an agent, `--base <ref>` if the work builds on unmerged changes (commit them first: uncommitted work doesn't carry over), and `--focus` if they want to jump there.
4. **Report back** the workspace, branch, and path from the output. If it reports `BLOCKED`, the agent is stuck on a startup prompt (usually a folder-trust dialog in the new directory). Tell the user to answer it in that pane, then send the kickoff shown in the note.

Setup runs automatically before the agent starts. Ignored `.env*` files are copied from the source checkout. Then, if the repo has an executable `.rig/worktree-setup`, rig runs it (with `RIG_SOURCE_CHECKOUT` set); otherwise it installs deps from the lockfile (bun/pnpm/yarn/npm/uv). A setup failure doesn't stop the spawn: it's reported so the new agent or the user can fix it.

## Checking on other agents

- `rig herdr-peers`: every other agent, with status `idle` / `working` / `blocked` / `done` / `unknown`.
- `rig herdr-peers --waiting`: only the ones that need the user (`blocked` on a question or approval, or `done`).
- `rig herdr-peers --lines 20`: include each one's recent output. Use it to summarize progress, not to act on it.

`blocked` means the agent is showing an approval or question UI. Tell the user, and don't answer it for them unless they ask.

## Landing a finished session

`rig herdr-land <slug>` refuses unless the worktree is clean, its branch is merged into the default branch, and its agent isn't working. Then it removes the worktree and workspace and deletes the branch with `git branch -d`.

- For a squash-merged PR, the branch won't look merged. Confirm with the user, then pass `--force`.
- Run it from the source repo (or pass `--cwd`), never from inside the session being landed.
- `--keep-branch` keeps the branch.

## Anything else in herdr

For raw control (splitting panes, running commands in panes, prompting a specific agent, reading output), read `reference.md` in this skill's folder. It's herdr's own agent guide, regenerated from the installed binary by `rig sync`. The `herdr` CLI's `--help` is the authority on syntax.
