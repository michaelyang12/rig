---
name: rig
description: Use when a task needs one of the user's custom tools (internal APIs, docs, services wrapped by the `rig` CLI), when a `rig` command fails, or when the user asks to add or change a rig tool or skill.
---

# rig

`rig` is the user's personal tool CLI. Every tool command is called like a normal shell command, the same way you would call `grep`.

## Using tools

1. Run `rig ls` to see the available commands (`rig ls --json` gives full JSON Schemas).
2. Run `rig <command> --help` to see its flags before calling it for the first time.
3. Call it: `rig <command> [positional] --flag value`. Flags are kebab-case; booleans take a bare `--flag` or `--no-flag`; array flags repeat (`--tag a --tag b`). For complex input, pass `--input '<json>'`.
4. Add `--json` when you need structured output. It returns `{"ok":true,"data":...}` or `{"ok":false,"error":{"code","message","hint"}}`.

Exit codes:
- `0`: ok.
- `1`: tool or upstream error. Read the message.
- `2`: bad arguments. Check `--help`.
- `3`: credentials missing or rejected. Ask the user to run `rig auth <tool>` in their terminal (it's interactive). Never ask them to paste secrets into the chat, and never read `~/.config/rig/.env`.

## Adding a tool (when the user asks)

The repo lives at the path shown by `rig status` (`root`).

- `rig new tool <name> [--auth] [--uv]` scaffolds `tools/<name>/` and `skills/<name>/SKILL.md`.
- TS tools export `defineTool({ name, description, auth?, verify?, commands })` from `tools/<name>/index.ts`. Each command is a `defineCommand({ description, args: z.object(...), positional?, run(args, ctx), format? })`. Import helpers from `"rig"`: `request` maps 401/403 to exit 3 and 404 to not-found; `bearer` and `basicAuth` build auth headers; `RigError` is for custom errors.
- Auth: declaring `auth` adds `<TOOL>_API_KEY` automatically. Any other vars must be prefixed `<TOOL>_` (for example `CONFLUENCE_BASE_URL`). Read them with `ctx.secret(name)` or `ctx.env(name)`. Add `verify(ctx)` so `rig auth` can check the credentials.
- Name commands `<tool>-<verb>` (for example `confluence-read`). Return strings or markdown for text output, or objects plus an optional `format()`.
- Python tools (`--uv`): a `tool.json` manifest plus `main.py`. Args arrive as JSON on stdin and the command name as `argv[1]`. Print the result; exit 2 or 3 for usage or auth failures.
- Afterwards, run `rig sync`, then `rig <command> --help` to check it loads. The user runs `rig auth <tool>`.
