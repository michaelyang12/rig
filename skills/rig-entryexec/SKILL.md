---
name: rig-entryexec
description: "Use proactively whenever a task might already be covered by the user's personal `rig` CLI (their own services, integrations, and workflows): before writing a script, calling a service's API by hand, or doing a manual check, run `rig ls` to see which tools exist."
---

# rig tools

The user has a personal CLI, `rig`, on PATH. Its tools are theirs. When one fits the task, use it instead of writing a one-off script or calling the underlying API yourself, even if the user didn't mention rig.

## Finding a tool

1. `rig ls`: one line per tool, saying what it does and when to use it. Choose by meaning, not by matching words exactly.
2. `rig ls <tool>`: that tool's commands. If the output says `has a skill: <name>`, load that skill.
3. `rig <command> --help`: flags. Check it before the first call.

## Calling convention

- Flags are kebab-case. Booleans are bare `--flag` / `--no-flag`. Array flags repeat or take trailing positionals. Complex input: `--input '<json>'`.
- `--json` returns `{"ok":true,"data":…}` or `{"ok":false,"error":{"code","message","hint"}}`.
- Exit codes: `0` ok, `1` tool/upstream error, `2` bad arguments, `3` credentials missing or rejected.
- On exit `3`, ask the user to run `rig auth <tool>` in their terminal (it's interactive). Never ask for secrets in chat, and never read `~/.config/rig/.env`.

To add, change, or refactor rig tools and skills, use the `rig-core` skill.
