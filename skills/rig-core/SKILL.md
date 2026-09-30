---
name: rig-core
description: Use when adding, changing, debugging, or refactoring the user's `rig` CLI itself — creating a new rig tool or skill, wrapping an API or script as a rig command, moving an existing skill into rig, fixing `rig sync`/`rig auth` behavior, or editing the rig repo. For just calling existing rig tools, see `rig-entryexec`.
---

# rig internals

`rig` is the user's personal agent-tooling CLI (TypeScript + Bun). It does four jobs:

1. **Tools**: commands any agent calls as `rig <command> --flags`, all following one contract.
2. **Skills**: `SKILL.md` folders symlinked into each harness's skills dir (`~/.claude/skills`, `~/.agents/skills`).
3. **Instructions**: one global instructions file linked to each harness's user-level path.
4. **Auth**: per-tool credentials set interactively with `rig auth`.

`rig status` prints the repo root (normally `~/Source/rig`). Read its `README.md` for the full reference.

## Repo map

| Path | What |
|---|---|
| `tools/<name>/index.ts` | A TS tool: `export default defineTool({...})` |
| `tools/<name>/tool.json` + entry | A non-TS tool (`runtime: uv \| python \| bin`) |
| `skills/<name>/SKILL.md` | A skill, synced to every harness |
| `skills/rig-entryexec/` | **Generated** by `rig sync` from the tool registry. Gitignored. Never edit it. |
| `src/core/*.ts` | Internals: registry, dispatch, sync, config, paths. See below. |
| `src/sdk/index.ts` | Public API tools import as `"rig"`: `defineTool`, `defineCommand`, `request`, `bearer`, `basicAuth`, `RigError`, `apiKeyVar` |
| `instructions/AGENTS.md` | Global always-on instructions, linked to each harness's instructions file. Not a skill. |
| `src/builtins/index.ts` | `BUILTINS` table. A new built-in must also go in `RESERVED` (`registry.ts`) and be named in this skill; `test/rig-core.test.ts` enforces both |
| `src/builtins/*` | `sync`, `remove`, `add`, `desync`, `status`, `config`, `ls`, `schema`, `auth`, `new` |
| `test/` | `bun test`, fully sandboxed (temp HOME plus a copy of `test/fixtures`) |

**Before changing anything in `src/core/`, read the module headers:** `grep -rn '^// @module ' src`. Every core module's first line is a `// @module <what it owns>` header, and that list is always current, so it's the map of the internals. When you add a module, start it with one in the same style. When a module's role changes, update its header.

## Adding a tool

1. Scaffold it with `rig new tool <name> [--auth] [--uv] [--no-skill]`. This creates `tools/<name>/` and, by default, `skills/<name>/SKILL.md`.
2. Define commands with `defineCommand({ description, args: z.object(...), positional?, run(args, ctx), format? })`.
   - Name commands `<tool>-<verb>` (`confluence-read`). Single-command tools can use the bare tool name. Names are lowercase kebab-case and must not match a built-in.
   - `.describe()` every arg; the text becomes `--help` and the generated skill.
   - `run` returns a string (printed as-is) or an object (JSON, or text via `format`). Write diagnostics with `ctx.log` (stderr), never `console.log`.
   - Use `request()` for HTTP: it maps 401/403 to exit 3, 404 to not-found, and other failures to exit 1. Throw `RigError(code, message, hint)` for anything else.
3. Write the tool's `description` for a reader who has never heard of it: what it does and when to use it. It goes into `rig-entryexec`'s description, which is what makes agents pick the tool up without being told.
4. Run `rig sync` (it regenerates `rig-entryexec` and links skills), then `rig <command> --help`, then try a real call.
5. If the tool's skill should carry docs generated from outside the repo (for example a CLI's bundled help), return them from `skillFiles()` in `defineTool`. `rig sync` writes them into `skills/<tool>/`; add each one to `.gitignore`.
6. Add tests under `test/`. Import the tool module directly and mock `fetch` (see `test/mint.test.ts`). Run `bun test` and `bun run typecheck`.

### Auth convention

- Declaring `auth: [...]` (even `[]`) adds `<TOOL>_API_KEY` as a required secret automatically.
- Every var must be prefixed `<TOOL>_` (`CONFLUENCE_BASE_URL`). Other secrets must end in `_API_KEY` or `_SECRET`. Mark vars that aren't needed with `optional: true`.
- Read values with `ctx.secret(name)` (throws exit 3 when unset) or `ctx.env(name)`. The shell env overrides `~/.config/rig/.env`.
- Add `verify(ctx)`: one cheap authenticated call that `rig auth` runs after saving credentials.
- The user runs `rig auth <tool>` themselves. Never read, print, or write `.env` values, and never ask for secrets in chat.

## Adding a skill

- For a standalone skill, run `rig new skill <name>` and edit `SKILL.md`. The frontmatter `name` must match the directory, and `description` says *when* to use it.
- To move an existing skill into rig (for example from a Claude plugin), copy its folder into `skills/`. Tell the user the old copy will now be a duplicate, and offer to uninstall it.
- Skills that use rig tools should reference them as `rig <command>`.
- Run `rig sync` afterwards.

## Global instructions

- `instructions/AGENTS.md` is the single source. `rig sync` links it to every harness in `HARNESSES` with an `instructions` entry. Only add a harness's `instructions` when its documented global path is confirmed.
- It's user content: edit it only when asked, and keep it to rules that apply to every session in every project.
- Instruction links go through the same `syncLinks` diffing and ownership state as skills (kind `"instructions"`), so a pre-existing real `CLAUDE.md` is a conflict, never overwritten.

## Changing rig itself

- **Contract:** exit codes 0/1/2/3, the `--json` envelope, and the flag rules are relied on by every tool and by the generated skill. Change them only deliberately, and update `README.md`, `src/core/entry.ts` and this skill together.
- **SDK:** `src/sdk` is imported by every tool. Keep changes backwards compatible, or update all of `tools/*`.
- **Sync safety:** rig only modifies a path if it's recorded in `~/.local/state/rig/links.json` *and* is still a symlink to the recorded source. Keep that invariant; tests in `test/sync.test.ts` cover it.
- **Paths:** every location can be overridden (`RIG_ROOT`, `RIG_CONFIG_DIR`, `RIG_STATE_DIR`, `RIG_BIN_DIR`). Use `paths` from `src/core/paths.ts` rather than hardcoding. Harness dirs come only from `HARNESSES` in `src/core/harnesses.ts`; never write `~/.claude` etc. elsewhere in `src/` or test setup (tests use `sb.harness(id, kind)`).
- **Config:** `saveConfig` writes only fields that differ from the defaults, so a default change in `HARNESSES` reaches users who have a `config.json`.
- **Module headers:** every `src/core/*.ts` starts with a one-line `// @module <what it owns>` header (the `@module ` prefix is what the lookup greps for, so keep it exact; `test/rig-core.test.ts` fails without it). A new core file must start with one. If a change alters what a module owns or guarantees (not just its internals), update its header in the same change.
- There's no build step. The `rig` launcher runs `src/cli.ts` with bun, so edits are live immediately.

## Before finishing

```sh
bun run typecheck && bun test && rig sync && rig ls
```

If you added or reshaped a `src/core` module, check `grep -rn '^// @module ' src` still describes each one accurately.

Commit only when the user asks. `skills/rig-entryexec/` is gitignored, so never commit it.
