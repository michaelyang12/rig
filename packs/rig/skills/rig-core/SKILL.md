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

Tools and skills come in **packs**: a directory with `pack.json` (`name` is its identity), `skills/`, `tools/`, and optionally `package.json`. rig ships only the core pack, `rig`. The user's own content lives in their packs, outside the install (`~/.config/rig/packs/*` or config `packs` paths); `rig pack ls` shows where each one is.

`rig status` prints the install root (normally `~/Source/rig`). Read its `README.md` for the full reference.

## Repo map

| Path | What |
|---|---|
| `<pack>/tools/<name>/index.ts` | A TS tool: `export default defineTool({...})` |
| `<pack>/tools/<name>/tool.json` + entry | A non-TS tool (`runtime: uv \| python \| bin`) |
| `<pack>/skills/<name>/SKILL.md` | A skill, synced to every harness |
| `packs/rig/` | The core pack. Holds only rig's own skills; user content never goes here |
| `packs/rig/skills/rig-entryexec/` | Static skill that sends agents to `rig ls`. Names no tools; edit it only to change how agents find or call tools |
| `src/core/*.ts` | Internals: registry, packs, resolver, deps, dispatch, sync, config, paths. See below. |
| `src/sdk/index.ts` | Public API tools import as `"rig"`: `defineTool`, `defineCommand`, `request`, `bearer`, `basicAuth`, `RigError`, `apiKeyVar`, and `z` |
| `~/.config/rig/AGENTS.md` | Global always-on instructions, linked to each harness's instructions file. Not a skill, not in any pack. |
| `instructions/AGENTS.example.md` | Template `rig new instructions` copies into place |
| `src/builtins/index.ts` | `BUILTINS` table. A new built-in must also go in `RESERVED` (`registry.ts`) and be named in this skill; `test/rig-core.test.ts` enforces both |
| `src/builtins/*` | `sync`, `remove`, `add`, `desync`, `status`, `config`, `ls`, `schema`, `auth`, `new`, `pack` |
| `test/` | `bun test`, fully sandboxed (temp HOME, a core fixture pack at `<root>/packs/rig`, and a user pack `demo` in the config dir). Only `test/` runs; pack tests run inside their pack |

**Before changing anything in `src/core/`, read the module headers:** `grep -rn '^// @module ' src`. Every core module's first line is a `// @module <what it owns>` header, and that list is always current, so it's the map of the internals. When you add a module, start it with one in the same style. When a module's role changes, update its header.

## Adding a tool

1. Scaffold it with `rig new tool <name> [--auth] [--uv] [--no-skill] [--pack <name>]`. This creates `tools/<name>/` and, by default, `skills/<name>/SKILL.md` in the target pack: `--pack`, else config `defaultPack`, else the user's only pack. Never put a user's tool in `packs/rig`; use `--pack rig` only when changing rig's own content.
   - Import only `"rig"` (and `"zod"`, or `z` from `"rig"`). rig maps both to its own copies at runtime, so never rely on the repo's `node_modules` or a tsconfig path. Other npm packages go in the pack's own `package.json`; `rig sync` installs them.
2. Define commands with `defineCommand({ description, args: z.object(...), positional?, run(args, ctx), format? })`.
   - Name commands `<tool>-<verb>` (`confluence-read`). Single-command tools can use the bare tool name. Names are lowercase kebab-case and must not match a built-in or a core command. Every command is also reachable as `<pack>:<command>`; a bare name another pack already uses becomes ambiguous (see README, "Names and collisions").
   - `.describe()` every arg; the text becomes `--help` and `rig schema`.
   - `run` returns a string (printed as-is) or an object (JSON, or text via `format`). Write diagnostics with `ctx.log` (stderr), never `console.log`.
   - Use `request()` for HTTP: it maps 401/403 to exit 3, 404 to not-found, and other failures to exit 1. Throw `RigError(code, message, hint)` for anything else.
3. Write the tool's `description` for a reader who has never heard of it: what it does and when to use it, in at most 300 chars (the registry reports longer ones). It's the tool's line in `rig ls`, which agents read to decide whether a tool fits.
4. The tool shows up in `rig ls` immediately; no sync is needed for that. Run `rig sync` to link a new skill. Check `rig ls <tool>` and `rig <command> --help`, then try a real call.
5. If the tool's skill should carry docs generated from outside the pack (for example a CLI's bundled help), return them from `skillFiles()` in `defineTool`. `rig sync` writes them into the pack's `skills/<tool>/`; add each one to the pack's `.gitignore`.
6. Add tests under the pack's `test/`. Import the tool module directly and mock `fetch`. Run them with `bun test` inside the pack.

### Auth convention

- Declaring `auth: [...]` (even `[]`) adds `<TOOL>_API_KEY` as a required secret automatically.
- Every var must be prefixed `<TOOL>_` (`CONFLUENCE_BASE_URL`). Other secrets must end in `_API_KEY` or `_SECRET`. Mark vars that aren't needed with `optional: true`.
- Read values with `ctx.secret(name)` (throws exit 3 when unset) or `ctx.env(name)`. The shell env overrides `~/.config/rig/.env`.
- Add `verify(ctx)`: one cheap authenticated call that `rig auth` runs after saving credentials.
- The user runs `rig auth <tool>` themselves. Never read, print, or write `.env` values, and never ask for secrets in chat.

## Adding a skill

- For a standalone skill, run `rig new skill <name> [--pack <name>]` and edit `SKILL.md`. The frontmatter `name` must match the directory, and `description` says *when* to use it.
- Skill names share one flat harness dir, so a name another enabled pack uses links neither until one is disabled (core always wins).
- To move an existing skill into rig (for example from a Claude plugin), copy its folder into a user pack's `skills/`. Tell the user the old copy will now be a duplicate, and offer to uninstall it.
- A new pack: `rig new pack <name> [--path <dir>]`. Manage packs with `rig pack` (`ls`, `add`, `remove`, `disable`, `enable`, `install`).
- Skills that use rig tools should reference them as `rig <command>`.
- Run `rig sync` afterwards.

## Global instructions

- `~/.config/rig/AGENTS.md` is the single source (`paths.instructionsFile`; start it with `rig new instructions`). `rig sync` links it to every harness in `HARNESSES` with an `instructions` entry. Only add a harness's `instructions` when its documented global path is confirmed.
- It's user content: edit it only when asked, and keep it to rules that apply to every session in every project.
- Instruction links go through the same `syncLinks` diffing and ownership state as skills (kind `"instructions"`), so a pre-existing real `CLAUDE.md` is a conflict, never overwritten.

## Changing rig itself

- **Contract:** exit codes 0/1/2/3, the `--json` envelope, `<pack>:<command>`, and the flag rules are relied on by every tool and by `rig-entryexec`. Change them only deliberately, and update `README.md`, `packs/rig/skills/rig-entryexec/SKILL.md` and this skill together.
- **SDK:** `src/sdk` is imported by every tool in every pack, including packs you can't see. Keep changes backwards compatible. `src/core/resolve.ts` serves it as `"rig"`, and `"zod"` as rig's own copy, through `Bun.plugin` virtual modules (`build.module`; `onResolve` doesn't see bare specifiers at runtime).
- **Names:** collisions are never settled by order. Only core is privileged; everything else is ambiguous until an alias or a disable settles it (`registry.ts`).
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

Commit only when the user asks.
