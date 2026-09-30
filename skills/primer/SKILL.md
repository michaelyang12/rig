---
name: primer
description: Use when the user asks to "write an AGENTS.md", "create a CLAUDE.md", "prime this repo for agents", "set up agent instructions", "onboard agents to this codebase", or otherwise wants the repo-level entrypoint file that agents read first. Produces AGENTS.md as the canonical file plus a CLAUDE.md that imports it. Also use to rewrite or restructure an existing one from scratch; for small edits to an existing CLAUDE.md, prefer claude-md-improver.
---

# Primer

Write the file an agent reads first when it lands in a repository: what this codebase is, how to build and verify it, where things live, and the rules that aren't obvious from the code. A good primer lets a fresh agent make a correct, idiomatic change on its first try.

## Files produced

- **`AGENTS.md`** at the repo root: the canonical content. Codex, Cursor, Aider, Gemini, and most other harnesses read it.
- **`CLAUDE.md`** at the repo root, containing only:

  ```markdown
  @AGENTS.md
  ```

  Claude Code expands `@path` imports, so both harnesses see one source of truth and nothing drifts. Add Claude-specific notes (hooks, skills, subagents) below the import only if they genuinely don't apply to other agents.

- If either file already exists, read it first. Preserve hand-written rules, merge them into the new structure, and tell the user what you moved or dropped. If `CLAUDE.md` is the one with content, migrate it into `AGENTS.md` and replace it with the import. Never silently overwrite.
- Only if the user asks for one file, write just that file with the full content.

## Process

1. **Survey before writing.** Evidence beats guessing. Read, in roughly this order:
   - `README*`, `CONTRIBUTING*`, existing `AGENTS.md`/`CLAUDE.md`/`.cursorrules`/`.github/copilot-instructions.md`
   - Manifests and scripts: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`, `justfile`, `Taskfile`
   - Lint, format, and type config: `tsconfig`, `eslint`/`biome`, `ruff`, `rustfmt`, `.editorconfig`
   - CI workflows (`.github/workflows/*`): the most reliable record of how the project is actually built and checked
   - `git log --oneline -30`: commit message style and what is actively changing
   - The directory tree (two or three levels, ignoring vendored and build output)
   - Three or four representative source files and their tests, to learn the real idioms

2. **Verify commands.** Run the build, test, lint, and typecheck commands you intend to document (when they're cheap and side-effect free). Document what works, not what the README claims. If something fails or needs setup you can't do, say so in the file.

3. **Extract conventions from the code, not from general best practice.** Look for things an agent would get wrong without being told:
   - Where new code of each kind goes (a new route, command, model, test)
   - Error handling style (throw vs. result types, custom error classes, exit codes)
   - Naming, module layout, import style, how dependencies are injected
   - Patterns to copy: name a concrete file that is the best example ("model new tools on `tools/mint/`")
   - Hazards: generated files, invariants, anything that looks editable but isn't
   - For every rule, prefer one that you saw consistently in 3+ places. One-offs are not conventions.

4. **Ask about what the code can't tell you.** Before writing, briefly ask the user (one batch of questions, skip any already answered) about: preferences that aren't enforced by tooling, areas that are off-limits or mid-migration, and whether agents may commit, push, or add dependencies. Unknowns you can't resolve become `?` in the file, not invented rules.

5. **Write** using the template below, then show the user a summary of the non-obvious rules you included and which ones you inferred versus confirmed.

## Template

Drop any section that would be empty. Order is by what an agent needs first.

````markdown
# AGENTS.md

<One or two sentences: what this project is, who uses it, and the stack.>

## Commands

```sh
<install>
<dev / run>
<test>            # single test: <how to run one file or case>
<lint / format>
<typecheck>
```

Before finishing any change, run: `<the exact verification chain>`

## Layout

| Path | What |
|---|---|
| `src/...` | ... |

## Conventions

- <Rule the code follows that an agent wouldn't guess.> See `path/to/example`.
- ...

## Adding a <common unit of work>

1. ...
2. ...

## Don'ts

- Don't edit `<generated path>`; it's produced by `<command>`.
- ...

## Git

<Commit message style, branch conventions, whether agents may commit or push.>
````

## Principles

- **Write for a capable engineer on day one.** They know the language; they don't know this repo. Skip generic advice ("write clean code", "add tests", "use meaningful names"). Every line should be specific to this codebase.
- **Short beats complete.** Aim for under ~150 lines. The file is loaded into every session's context, so each line costs tokens forever. If a topic needs depth, put it in a doc and link it (`See docs/architecture.md`) rather than inlining it.
- **Commands must be copy-pasteable and exact.** Include how to run a single test; agents need that constantly.
- **Point at exemplars.** "Follow the pattern in `src/handlers/users.ts`" teaches more than a paragraph of description, and stays true when the pattern evolves.
- **Say why for surprising rules.** "Don't use `fs.watch`: it misses events on macOS, use `chokidar`" is followed; "Don't use `fs.watch`" gets second-guessed.
- **Imperative, telegraphic tone.** No marketing, no emojis, no restating the README's pitch.
- **Nested files for monorepos.** If packages differ meaningfully (different language, commands, or rules), put a short `AGENTS.md` in each package root covering only what differs, and keep the root file about the whole repo. Nearer files take precedence.

## Anti-patterns

- Documenting commands you didn't run or that the README merely claims.
- Describing the directory tree file by file. Only list paths an agent needs to find or avoid.
- Copying rules already enforced by the linter or formatter. The tool will catch them; just say to run it.
- Inventing conventions from one example or from what "most projects" do.
- Duplicating content between `AGENTS.md` and `CLAUDE.md`.
- Including secrets, internal URLs with tokens, or personal machine paths.

## Output to user

After writing, respond with the files written, then 2-4 bullets naming the most important non-obvious rules you captured, and any `?` items worth the user filling in.
