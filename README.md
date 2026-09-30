# rig

Your agent tools and skills, in every harness.

- **Tools**: commands any agent can call from a shell, as `rig <command> --flags`, with one uniform contract (schema-driven flags, `--json` envelope, exit codes).
- **Skills**: `SKILL.md` folders symlinked into `~/.claude/skills` (Claude Code) and `~/.agents/skills` (Codex and other agents).
- **Instructions**: one global instructions file (`instructions/AGENTS.md`) symlinked to each harness's user-level instructions path (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`).
- **Auth**: `rig auth` walks you through the credentials each tool needs and stores them in `~/.config/rig/.env` (0600).

## Install

```sh
bun install
bun src/cli.ts sync     # links skills, and puts `rig` on PATH via ~/.local/bin/rig
rig auth                # set up any credentials tools need
```

Edits take effect immediately. There's no build step; the `rig` launcher runs `src/cli.ts` with bun.

## Commands

| Command | |
|---|---|
| `rig ls [--json]` | List tool commands (JSON includes schemas) |
| `rig <command> --help` | A command's flags |
| `rig schema <command>` | A command's JSON Schema |
| `rig new tool <name> [--auth] [--uv] [--no-skill]` | Scaffold a tool (and its skill) |
| `rig new skill <name>` | Scaffold a skill |
| `rig sync [--dry-run]` | Regenerate `rig-entryexec`; link enabled skills, global instructions, and the launcher; prune stale links; report problems |
| `rig status` | Links per target, instructions links, tools, auth state |
| `rig remove <name>` / `rig add <name>` | Disable (and unlink) or re-enable a tool/skill |
| `rig desync [--dry-run]` | Remove every link rig created |
| `rig auth [tool] [--status] [--no-verify]` | Interactive credential setup |

`sync` only ever modifies symlinks it created (recorded in `~/.local/state/rig/links.json` and still pointing where rig pointed them). Anything else in a target directory is reported as a conflict and left alone.

## Global instructions

`instructions/AGENTS.md` holds always-on rules for every agent session. `rig sync` symlinks it to each path in `instructionTargets` in `~/.config/rig/config.json`:

```json
{ "instructionTargets": ["~/.claude/CLAUDE.md", "~/.codex/AGENTS.md"] }
```

Those two are the defaults: Claude Code reads `~/.claude/CLAUDE.md`, and Codex reads `~/.codex/AGENTS.md` (it prefers `AGENTS.override.md` if present, and ignores a custom `CODEX_HOME`). To target another harness, add its user-level instructions path.

- rig doesn't ship an `instructions/AGENTS.md`; copy `instructions/AGENTS.example.md` to start one. Without it nothing is linked, and deleting it later makes the next `sync` prune the links.
- Same safety rules as skills: an existing real file or foreign symlink at a target (for example a `CLAUDE.md` you already wrote) is reported as a conflict and left alone. Move its contents into `instructions/AGENTS.md`, delete it, and re-run `rig sync`.
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
// tools/confluence/index.ts
import { z } from "zod";
import { basicAuth, defineCommand, defineTool, request } from "rig";

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

**Other languages:** `rig new tool <name> --uv` creates a `tool.json` manifest (JSON Schema args, `runtime: uv | python | bin`) and a PEP 723 `main.py`. rig passes the args as JSON on stdin, the command name as `argv[1]`, and auth vars in the environment.

**Skills:** each tool can get a `skills/<name>/SKILL.md` telling agents when and how to call it. Two skills ship with rig:

- `rig-entryexec`, **generated by `rig sync`** from the tool registry (gitignored). Its description lists every enabled command, so agents in any harness know the tools exist and use them without being told.
- `rig-core` teaches agents rig's internals: how to add, change, or refactor tools and skills.

Write each tool's `description` and `.describe()` its args carefully. They are what `rig-entryexec` shows agents.

## Development

```sh
bun test         # sandboxed: temp HOME + copied fixtures, never touches real harness dirs
bun run typecheck
```

Every path can be overridden for testing: `RIG_ROOT`, `RIG_CONFIG_DIR`, `RIG_STATE_DIR`, `RIG_BIN_DIR`.
