# rig

Your agent tools and skills, in every harness.

- **Tools**: commands any agent can call from a shell, as `rig <command> --flags`, with one uniform contract (schema-driven flags, `--json` envelope, exit codes).
- **Skills**: `SKILL.md` folders symlinked into each harness's skills dir (`~/.claude/skills` for Claude Code, `~/.agents/skills` for Codex and other agents).
- **Packs**: tools and skills come in packs. rig ships one, `rig`; yours live outside the install, so upgrades never touch them.
- **Instructions**: one global instructions file (`~/.config/rig/AGENTS.md`) symlinked to each harness's user-level instructions path (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`).
- **Auth**: `rig auth` walks you through the credentials each tool needs and stores them in `~/.config/rig/.env` (0600).

## Install

```sh
bun install
bun src/cli.ts sync     # links skills, and puts `rig` on PATH via ~/.local/bin/rig
rig new pack <name>     # a home for your own tools and skills: ~/.config/rig/packs/<name>
rig auth                # set up any credentials tools need
```

Edits take effect immediately. There's no build step; the `rig` launcher runs `src/cli.ts` with bun (with `--no-install`, so a missing package fails instead of being fetched).

## Commands

| Command | |
|---|---|
| `rig ls [tool] [--json]` | One line per tool, grouped by pack, or one tool's commands (JSON: commands with schemas, `pack` and `qualified` name) |
| `rig <command> --help` | A command's flags. `rig <pack>:<command>` always works |
| `rig schema <command>` | A command's JSON Schema |
| `rig new tool <name> [--auth] [--uv] [--no-skill] [--pack <name>]` | Scaffold a tool (and its skill) |
| `rig new skill <name> [--pack <name>]` | Scaffold a skill |
| `rig new pack <name> [--path <dir>]` | Scaffold a pack (default `~/.config/rig/packs/<name>`; a `--path` elsewhere is added to config) |
| `rig new instructions` | Copy `instructions/AGENTS.example.md` to `~/.config/rig/AGENTS.md` (never overwrites) |
| `rig pack ls [--json]` | Packs: origin, source path, tool and skill counts, dependency state |
| `rig pack add <path>` / `rig pack remove <name\|path>` | Add or remove a pack directory in config `packs`, then sync. Never deletes files |
| `rig pack disable <name>` / `rig pack enable <name>` | Turn a whole pack off or on, then sync |
| `rig pack install [pack]` | Run `bun install` in a pack (all packs with a `package.json` by default) |
| `rig sync [--dry-run]` | Install changed pack dependencies; link enabled skills, global instructions, and the launcher; prune stale links; report problems |
| `rig status` | Packs, links per target, instructions links, tools, auth state |
| `rig remove <name>` / `rig add <name>` | Disable (and unlink) or re-enable a tool/skill. Takes `<pack>:<name>` when the name is in more than one pack |
| `rig desync [--dry-run]` | Remove every link rig created except the `rig` command itself |
| `rig config [harnesses <name>... \| none]` | Choose which harnesses to link into besides `~/.agents` (interactive without args), then re-sync |
| `rig auth [tool] [--status] [--no-verify]` | Interactive credential setup |

`sync` only ever modifies symlinks it created (recorded in `~/.local/state/rig/links.json` and still pointing where rig pointed them). Anything else in a target directory is reported as a conflict and left alone.

## Packs

A pack is a directory of tools and skills:

```
<pack>/
  pack.json            { "name": "work", "description": "..." }
  skills/<name>/SKILL.md
  tools/<name>/index.ts | tool.json
  package.json         optional: the pack's own npm dependencies
  test/                optional: the pack's tests, run with `bun test` inside the pack
```

`name` in `pack.json` is the pack's identity, not the directory name, so a pack can be a plain folder, a git clone, a submodule, or a symlink under any name. rig finds packs in this order (also the display order; it never decides a conflict):

1. `<install>/packs/rig`: the core pack (`rig-entryexec`, `rig-core`). `rig` is reserved for it.
2. Other `<install>/packs/*`: a convenience when running from a clone (gitignored).
3. `~/.config/rig/packs/*`: the default home for your packs.
4. Paths listed in config: `"packs": ["~/Source/my-rig-pack"]`.

A scanned directory without `pack.json`, or a second pack with a name already taken, is reported by `sync` and skipped.

**Imports.** Tools import only `"rig"` (the SDK, which also re-exports `z`) and `"zod"`. rig maps both to its own copies at runtime, so a pack works wherever it lives with no `node_modules`, and every schema shares rig's zod instance. For editor types, list `rig` under the pack's `devDependencies`/`peerDependencies`.

**Dependencies.** A pack with a `package.json` gets its own `node_modules`. rig hashes `package.json` and `bun.lock` and compares them with a stamp in `~/.local/state/rig/packs.json`; when they differ, `rig sync` (or `rig pack install`) runs `bun install` in the pack, with `--frozen-lockfile` when there's a lockfile and the pack isn't a working copy with uncommitted changes. A failure affects only that pack. If the pack declares `peerDependencies.rig` and this rig's version doesn't satisfy it, its tools don't load.

### Names and collisions

Every command has a qualified name, `<pack>:<command>`, which always works. A bare name works when exactly one enabled pack defines it. Nothing is ever resolved silently by order:

- **Commands:** when two packs define the same command, neither gets the bare name. `rig check` fails with a hint listing `rig a:check` and `rig b:check`, and `sync` reports it. To give the bare name to one side, add an alias in config: `"aliases": { "check": "work:check" }`.
- **Tools:** tool names set env prefixes and `rig auth` entries, so they must be unique. When two packs define tool `x`, neither loads until you disable one: `rig remove work:x`.
- **Skills:** harness skills dirs are flat, so when two packs define skill `x`, neither is linked until you disable one.
- **Core always wins.** A user-pack command, tool, or skill named like one in the `rig` pack (or a built-in command) is reported, and the core one keeps the name. The user command stays reachable by its qualified name.

`disabled` entries in config are stored qualified (`"work:x"`). Older bare entries still match that name in every pack and are rewritten qualified the next time `rig remove`/`rig add` saves config. A whole pack is turned off with `rig pack disable <name>` (stored in `disabledPacks`).

`rig new tool/skill` writes into `--pack <name>`, else config `defaultPack`, else your only pack.

## Harnesses

Harness locations are declared once, in `HARNESSES` in `src/core/harnesses.ts`:

| Harness | Home | Skills | Instructions |
|---|---|---|---|
| `claude` | `~/.claude` | `skills/` | `CLAUDE.md` |
| `codex` | `~/.codex` | (reads `~/.agents/skills`) | `AGENTS.md` |
| `agents` (always linked) | `~/.agents` | `skills/` | |

`~/.agents/skills` is the cross-agent skills location that Codex and many third-party harnesses read, so rig always links into it. Codex also still scans its deprecated `~/.codex/skills`, and a skill in both shows up twice, so rig deliberately doesn't link there.

Skills and instructions paths are derived from each harness's home, so moving a harness is a one-line change there; the next `rig sync` prunes the old links and creates the new ones. To add a harness, add one entry. `rig status` labels its columns by harness name.

The other harnesses are on by default. To choose, run `rig config` for an interactive picker, or `rig config harnesses claude` (or `none`) from a script. Either saves the choice and re-syncs. The choice is stored in `~/.config/rig/config.json`, and names match in any case; an unknown name is an error:

```json
{ "harnesses": ["claude"] }
```

rig only writes settings you've changed to that file, so defaults keep tracking `HARNESSES`. To link somewhere new, add a harness entry.

## Global instructions

`~/.config/rig/AGENTS.md` holds always-on rules for every agent session. `rig sync` symlinks it to every configured harness that declares an instructions file. By default that's two: Claude Code reads `~/.claude/CLAUDE.md`, and Codex reads `~/.codex/AGENTS.md` (it prefers `AGENTS.override.md` if present, and ignores a custom `CODEX_HOME`). To target another harness, add it to `HARNESSES`.

- Start one with `rig new instructions`, which copies `instructions/AGENTS.example.md`. Without it nothing is linked, and deleting it later makes the next `sync` prune the links.
- It used to live at `instructions/AGENTS.md` in the repo. While that file exists and the new one doesn't, rig keeps linking it and `sync` prints the exact `mv` to run; the next `sync` after the move repairs the links.
- Packs don't ship instructions; there's one file per user.
- Same safety rules as skills: an existing real file or foreign symlink at a target (for example a `CLAUDE.md` you already wrote) is reported as a conflict and left alone. Move its contents into `~/.config/rig/AGENTS.md`, delete it, and re-run `rig sync`.
- `rig desync` removes the links; the source file stays.
- Keep it short: every harness loads it into every session. Put anything task-specific in a skill.

## The tool contract

```
rig confluence-read 15151 --json
```

- Flags come from the command's schema: kebab-case → camelCase keys, `--flag`/`--no-flag` for booleans, repeated flags for arrays, declared positionals, and `--input '<json>' | -` for whole-object input.
- stdout carries the result: text by default, or `{"ok":true,"data":…}` / `{"ok":false,"error":{code,message,hint}}` with `--json`. Diagnostics go to stderr.
- Exit codes: `0` ok · `1` tool/upstream error · `2` usage · `3` credentials missing or rejected.

## Writing a tool

`rig new tool confluence --auth` generates something like this:

```ts
// <pack>/tools/confluence/index.ts
import { basicAuth, defineCommand, defineTool, request, z } from "rig";

export default defineTool({
  name: "confluence",
  description: "Read Confluence pages",
  // CONFLUENCE_API_KEY is added automatically; other vars must be prefixed CONFLUENCE_.
  auth: [
    { name: "CONFLUENCE_BASE_URL", prompt: "Site URL", example: "https://acme.atlassian.net" },
    { name: "CONFLUENCE_EMAIL", prompt: "Atlassian account email" },
  ],
  async verify(ctx) {
    await request(`${ctx.secret("CONFLUENCE_BASE_URL")}/wiki/api/v2/spaces?limit=1`, {
      tool: "confluence",
      headers: { authorization: basicAuth(ctx.secret("CONFLUENCE_EMAIL"), ctx.secret("CONFLUENCE_API_KEY")) },
    });
  },
  commands: {
    "confluence-read": defineCommand({
      description: "Read a page",
      args: z.object({ page: z.string().describe("Page id") }),
      positional: ["page"],
      async run({ page }, ctx) {
        const res = await request<{ title: string; body: { storage: { value: string } } }>(
          `${ctx.secret("CONFLUENCE_BASE_URL")}/wiki/api/v2/pages/${page}?body-format=storage`,
          { tool: "confluence", headers: { authorization: basicAuth(ctx.secret("CONFLUENCE_EMAIL"), ctx.secret("CONFLUENCE_API_KEY")) } },
        );
        return `# ${res.title}\n\n${res.body.storage.value}`;
      },
    }),
  },
});
```

- `run` returns a string (printed as-is) or an object (JSON, or text via `format(result)`).
- `request()` maps 401/403 to exit 3 with a `rig auth <tool>` hint, 404 to not-found, and other failures to exit 1.
- `ctx.secret(name)` reads the shell env first, then `~/.config/rig/.env`. `ctx.log()` writes to stderr.
- Missing required vars fail before `run` is called, with exit 3.
- `skillFiles()` (optional) returns files that `rig sync` writes into the tool's own pack, at `skills/<tool>/`, for docs that must track something outside the pack (for example a CLI's bundled help). Gitignore those files. A pack rig can't write to is reported and skipped.

**Other languages:** `rig new tool <name> --uv` creates a `tool.json` manifest (JSON Schema args, `runtime: uv | python | bin`) and a PEP 723 `main.py`. rig passes the args as JSON on stdin, the command name as `argv[1]`, and auth vars in the environment.

**Skills:** each tool can get a `skills/<name>/SKILL.md` in its pack telling agents when and how to call it. Two skills ship in the core pack:

- `rig-entryexec` tells agents in any harness that rig exists and how to find a tool: `rig ls` (one line per tool), then `rig ls <tool>` (its commands), then `rig <command> --help`. It names no tools, so it stays small and never changes when tools are added. Tools are only in context when an agent looks them up.
- `rig-core` teaches agents rig's internals: how to add, change, or refactor tools and skills.

Write each tool's `description` for an agent that has never heard of it: what it does and when to use it, in at most 300 characters (sync reports longer ones). It's the tool's line in `rig ls`, which is how agents decide to use it. `.describe()` every arg too; that text is `--help`. A tool that also ships its own skill gets noticed through that skill's always-loaded description.

## Development

```sh
bun test         # sandboxed: temp HOME + fixture core and user packs, never touches real harness dirs
bun run typecheck
```

`bun test` only runs `test/` (see `bunfig.toml`); a pack's own tests run from inside the pack.

Every path can be overridden for testing: `RIG_ROOT`, `RIG_CONFIG_DIR`, `RIG_STATE_DIR`, `RIG_BIN_DIR`.
