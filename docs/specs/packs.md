# Spec: packs

Status: draft · 2026-10-05

## Why

rig is moving toward being installed from npm/bun (`bun add -g`), so the install directory is rig's, not the user's: it gets replaced on upgrade. Today all content lives in the repo: core skills (`rig-core`, `rig-entryexec`), personal skills and tools (`blueprint`, `herdr`, `mint`, `primer`), their tests, and the personal `instructions/AGENTS.md`. To ship rig, its own content has to separate from user content, and user content has to live outside the install.

A **pack** is the unit of content: a directory of skills and tools with a name. rig ships one pack (`rig`). Users add any number of their own, stored wherever they like (a plain folder, a git clone, a submodule of a dotfiles repo, a symlink).

## Goals

- rig's repo and npm package contain only the `rig` pack and the engine.
- User packs live outside the install and survive upgrades.
- A pack's tools import only the public SDK (`"rig"`); they work no matter where the pack lives, with no `node_modules` unless the pack has its own dependencies.
- Name collisions between packs are always detected and never resolved silently.
- rig installs a pack's own npm dependencies when they change.

## Non-goals (v1)

- A pack registry or `rig pack add <git-url>` (paths only; cloning is a later phase).
- Managing Python virtualenvs. Python tools with dependencies use `runtime: "uv"` and inline script metadata.
- Renaming or prefixing skills to dodge collisions.
- Publishing to npm (package name, `files`, release flow). This spec only removes the blockers.

## Pack layout

```
<pack>/
  pack.json            { "name": "myang", "description": "..." }
  skills/<name>/SKILL.md
  tools/<name>/index.ts | tool.json
  package.json         optional: the pack's own npm deps
  bun.lock             optional
  test/                optional: the pack's tests, run by the pack, not by rig's `bun test`
```

- `pack.json` is required. `name` is the pack's identity (used in `pack:cmd`, `disabled`, state), not the directory name, so a pack can be symlinked or submoduled under any folder name.
- Pack names follow `NAME_RE` (lowercase kebab-case). `rig` is reserved for the core pack.
- Two discovered packs with the same name: the second is skipped and reported as a problem.
- Inside a pack, tools and skills keep today's rules (directory name = tool name = frontmatter name, `<TOOL>_` auth prefix, description cap). A tool's skill is still `skills/<tool>/` in the same pack.

## Where packs come from

Discovery order (also the display order in `rig ls`/`rig status`; it never decides conflicts):

1. `<root>/packs/rig`, the core pack, which ships with rig.
2. `<root>/packs/*` other than `rig`: dev convenience when running from a clone. `.gitignore` gets `packs/*` and `!packs/rig`.
3. `~/.config/rig/packs/*`, the default home for user packs (`paths.packsDir`, overridable via `RIG_CONFIG_DIR`).
4. Explicit paths in config: `"packs": ["~/Source/my-rig-pack"]`.

A directory without `pack.json` in a scanned folder is a problem, not silently ignored. Symlinked pack directories are followed.

## Module resolution

Today tools resolve `"rig"` through `paths` in the repo `tsconfig.json` and `zod` through the repo `node_modules`. Bun resolves from a file's real path, so neither works for a pack outside the repo. Tests already work around this by writing a tsconfig and symlinking `node_modules` into the sandbox (`test/helpers.ts`).

Fix: a new core module `src/core/resolve.ts` registers a runtime `Bun.plugin` before the registry imports any tool. It declares two **virtual modules** with `build.module(specifier, () => ({ exports, loader: "object" }))`, whose exports are the objects rig already imported:

| Specifier | Exports |
|---|---|
| `rig` | `import * as sdk from "../sdk"` |
| `zod` | `import * as zod from "zod"` (rig's own instance) |

Spike result (Bun 1.3.4, 2026-10-05):
- `onResolve` does **not** intercept bare specifiers at runtime, neither from a runtime plugin nor with `--preload`. Bun fails with "Cannot find package". With auto-install on, it instead fetches the unrelated npm package `rig@0.7.0`. Don't use `onResolve`.
- `build.module` **works**: a tool in a symlinked directory outside the repo, with no `node_modules`, imported `rig` and `zod`, a relative helper's own `zod` import also resolved, and `z` was the same instance as rig's.
- Subpath specifiers (`zod/v4`, `zod/mini`) are not covered. Packs import `zod` or `z` from `rig` only, and the registry reports other `zod/*` imports as a problem if this comes up.
- rig's launcher should pass `--no-install`, so a missing package in a pack fails loudly instead of being fetched from npm.

- Pinning `zod` to rig's copy matters for correctness: the registry calls `z.toJSONSchema(cmd.args)` and dispatch calls `cmd.def.args.parse`. A schema built with a different zod instance can quietly break both.
- The SDK also re-exports `z` (`import { defineTool, z } from "rig"`), so a pack with no other dependencies needs no `package.json`. Existing `import { z } from "zod"` keeps working through the plugin.
- Editor typechecking: a pack lists `rig` under `devDependencies`/`peerDependencies` for types. At runtime the plugin always wins, so the code that runs is the running rig's SDK, not the pack's installed copy. The published package exports `src/sdk/index.ts` as `"."` (bun runs TS directly).
- Once this lands, the tsconfig and `node_modules` workaround in `test/helpers.ts` is deleted. Sandboxed tests passing without it are the acceptance test for this section.

**Fallback** if a future Bun breaks virtual modules: during sync, symlink `<pack>/node_modules/rig` and `<pack>/node_modules/zod` to rig's copies (writes into the pack, but works with any resolver).

## Names and collisions

There are four namespaces, each with its own rule.

### Commands

- Every command has a qualified name `<pack>:<command>`, which always resolves (`rig myang:mint-check`).
- A bare name resolves only if exactly one enabled pack defines it.
- **Collision:** two enabled packs define the same bare command. Neither gets the bare name, both stay reachable qualified, and `rig sync` reports a problem naming both qualified forms. Running the bare name fails with `NOT_FOUND` and a hint listing the qualified options. There is no precedence order: a skill that says `rig check` must never quietly hit another pack's tool.
- **Core can't be shadowed.** A user-pack command matching a `rig` pack command or a `RESERVED` built-in is a problem for the user pack. The core command keeps the bare name. This is the only asymmetry.
- **Aliases** settle a collision on purpose: config `"aliases": { "check": "work:check" }` gives the bare name to one side. An alias targeting a missing command is a problem. An alias can't override a built-in.
- `:` is not allowed in pack, tool, or command names (already true via `NAME_RE`), so parsing is a single split.

### Tools

- A tool's name sets its env prefix (`MINT_API_KEY`), its skill directory, and its `rig ls` / `rig auth` entry, so tool names must be unique across enabled packs.
- **Collision:** two enabled packs define tool `x`. Both tools are marked as problems and neither loads, until the user disables one (`rig remove work:x`). Without unique names they would share auth variables without either author intending it.
- Against core: the user pack's tool is the problem; core's stays loaded.

### Skills

- A skill links into the harness skills directory under its own name. That directory is flat and shared with skills from outside rig, and a skill's frontmatter `name` must match its folder, so rig can't rename it.
- **Collision:** two enabled packs define skill `x`. Neither is linked, sync reports a problem, and the user resolves it by disabling one. Against core, core wins.
- Conflicts with skills from outside rig keep today's behavior (`links.ts` reports a conflict and leaves them alone).

### `disabled` and other config references

- Entries are stored qualified: `"disabled": ["myang:herdr"]`. `rig remove`/`rig add` accept a bare name when it's unambiguous and store the qualified form. When ambiguous they fail with a hint.
- Legacy bare entries already in config are matched against every pack (so existing configs keep working) and rewritten qualified the next time config is saved.
- Disabling a whole pack: `rig remove myang:` (trailing colon) or `rig pack disable myang`. Pick one at implementation time; prefer the `rig pack` subcommand.

## Dependencies

Only packs with a `package.json` are managed.

1. **Staleness:** hash `package.json` + `bun.lock` (if present) and compare with the stamp in `~/.local/state/rig/packs.json` (`{ "<pack>": { "depsHash": "...", "installedAt": "..." } }`). Hashing is cheap, so the registry checks on every load. A stale pack gets a problem: `pack myang: dependencies changed; run rig sync`.
2. **Install:** `rig sync` and `rig pack install [pack]` run `bun install` with `cwd` set to the pack, then write the stamp. `--frozen-lockfile` is used when a `bun.lock` exists and the pack isn't the user's working copy. v1 heuristic: frozen when the pack root isn't a git repo with uncommitted changes. If that proves fiddly, add `"frozenLockfile": true` to `pack.json`.
3. **Location:** `node_modules` is installed inside the pack, because Bun resolves from the importing file. The `rig new pack` scaffold gitignores it.
4. **Shared packages:** `rig` and `zod` always come from rig through the plugin, even if the pack installs them.
5. **SDK compatibility:** if the pack declares `peerDependencies.rig`, check it against rig's version with `Bun.semver.satisfies`. A mismatch is a problem for every tool in that pack, and those tools don't load.
6. **Failure:** an install or import failure is a problem scoped to that pack. Other packs and built-ins keep working; this matches today's per-tool `try` in the registry.
7. **Install scripts:** rely on Bun's default of not running lifecycle scripts for untrusted packages. rig adds no extra trust.

## Global instructions

The instructions file is user content, so it moves out of the repo:

- `paths.instructionsFile` becomes `~/.config/rig/AGENTS.md`.
- `instructions/AGENTS.example.md` stays in the repo as the template. `rig new instructions` copies it into place, refusing if the file already exists.
- **Migration:** if `<root>/instructions/AGENTS.md` exists and the config-dir file doesn't, `rig sync` reports a problem with the exact `mv` to run. It doesn't move the file itself. After the move, the next sync repairs the harness links, because `links.ts` already repairs owned links whose source changed.
- Packs don't ship instructions. One file per user keeps "two packs both want CLAUDE.md" from being a question.

## Generated skill files

`writeSkillFiles` writes into `<pack>/skills/<tool>/` instead of `paths.skills/<tool>/`. If the pack directory isn't writable, report a problem and skip writing. Moving generated files to the state directory is deferred until a read-only pack actually needs it.

## CLI changes

| Command | Change |
|---|---|
| `rig pack ls` | Packs with source path, origin (core/repo/config dir/config path), tool and skill counts, dependency state |
| `rig pack install [pack]` | Force a dependency install |
| `rig pack add <path>` / `rig pack remove <name>` | Add a path to or remove it from config `packs`, then sync. Never deletes files |
| `rig pack disable/enable <name>` | Disable or enable a whole pack |
| `rig new pack <name> [--path <dir>]` | Scaffold `pack.json`, `skills/`, `tools/`, `.gitignore` (default location `~/.config/rig/packs/<name>`) |
| `rig new tool/skill ... [--pack <name>]` | Target pack. Defaults to config `defaultPack`, else the only user pack, else a usage error listing packs. `--pack rig` is allowed for rig development |
| `rig new instructions` | See above |
| `rig ls` | Text output grouped under a pack header; conflicted commands print qualified. JSON adds `pack` and `qualified` fields |
| `rig status` | Adds a packs section; tool and skill rows show their pack |
| `rig remove/add` | Qualified names, as above |

`pack` goes into `BUILTINS` and `RESERVED`, and is named in the `rig-core` skill (`test/rig-core.test.ts` enforces this).

## Code changes

| Module | Change |
|---|---|
| `src/core/paths.ts` | Drop `tools`, `skills`, `instructions`. Add `packsDir` (repo `packs/`), `userPacksDir` (`~/.config/rig/packs`), and `instructionsFile` in the config dir |
| `src/core/packs.ts` (new) | Discover and validate packs from the four sources; read `pack.json`. Header: `// @module Discovers packs (core, repo, config dir, config paths) and validates pack.json; packs are the unit tools and skills come from.` |
| `src/core/resolve.ts` (new) | The `Bun.plugin` resolver. Header: `// @module Maps "rig" and "zod" to the running rig's copies for every tool import, wherever its pack lives.` |
| `src/core/deps.ts` (new) | Dependency hashing, stamps, `bun install`, peer range check. Header: `// @module Installs each pack's own npm deps when package.json/bun.lock change, and checks its declared rig version.` |
| `src/core/registry.ts` | Loop over packs. `ResolvedTool` and `Skill` gain `pack`. `Registry` gains `qualified: Map<string, ResolvedCommand>`; `commands` holds bare names only when unambiguous or aliased. Collision rules above. Update header |
| `src/core/config.ts` | `packs`, `aliases`, `defaultPack`; qualified `disabled` with legacy matching. Update header |
| `src/core/state.ts` | `packs.json` alongside `links.json` (or a separate small module; either is fine). Update header if it lives here |
| `src/core/generated.ts` | Write into the tool's pack. Update header |
| `src/core/instructions.ts` | New source path and migration problem. Update header |
| `src/cli.ts` | Install the resolver before `loadRegistry`; look up `qualified` when argv[0] contains `:`; ambiguous-bare `NOT_FOUND` hint |
| `src/sdk/index.ts` | Re-export `z` |
| `src/builtins/*` | `pack` builtin; `--pack` on `new`; pack-aware `ls`/`status`/`remove`/`add` |

## Content moves

- `skills/rig-core`, `skills/rig-entryexec` → `packs/rig/skills/`. Add `packs/rig/pack.json` and an empty `packs/rig/tools/`.
- `skills/{blueprint,herdr,mint,primer}`, `tools/{blueprint,herdr,mint}`, and `test/{blueprint,herdr,mint}.test.ts` → a personal pack outside the repo (e.g. `~/Source/rig-pack-myang`, symlinked or listed in config). Tool tests import tool modules relatively and `rig` through the plugin; they run with `bun test` inside the pack.
- `instructions/AGENTS.md` → `~/.config/rig/AGENTS.md`.
- herdr stays a personal pack for now. It's about an external program and needs `HERDR_ENV=1`, so it doesn't meet the bar for core. It can later become the first example of an optional official pack.
- Delete the `skills/herdr/reference.md` line from the root `.gitignore`. It becomes the personal pack's own gitignore entry.

## Docs and skills to update

- `README.md`: packs section; install via package manager; new paths; collision rules; `pack:cmd`.
- `packs/rig/skills/rig-entryexec/SKILL.md`: the `pack:cmd` form and what an ambiguous-command error means. This changes the agent contract, so it updates together with the README.
- `packs/rig/skills/rig-core/SKILL.md`: repo map (packs, `--pack`), the resolver rule ("tools import only `rig`; never rely on the repo's node_modules"), where user content lives, and the new built-in.
- `AGENTS.md` and `CLAUDE.md`, if present, wherever they mention `tools/` or `skills/`.

## Tests

- Fixtures become `test/fixtures/packs/core-fixture/` plus a user pack under the sandbox's `~/.config/rig/packs/`, so each test exercises cross-pack behavior.
- `test/helpers.ts`: delete the tsconfig and `node_modules` workaround (this verifies the resolver).
- New cases:
  - A pack outside the repo, reached through a symlink, imports `rig` and `zod` and runs.
  - A bare-command collision: both qualified forms work, the bare name gives `NOT_FOUND` with a hint, and sync reports the problem.
  - An alias settles a collision.
  - A user command named like a core command or built-in: core wins, and the user side is reported.
  - A tool-name collision: neither tool loads.
  - A skill collision: neither skill is linked; disabling one links the other.
  - A duplicate pack name, and a scanned directory without `pack.json`.
  - Qualified `disabled`, legacy bare entries, and an ambiguous `rig remove`.
  - Dependencies: a stale stamp gives a problem, sync installs and stamps, an install failure stays scoped to its pack, and a peer range mismatch disables that pack's tools.
  - Instructions migration message, and links repaired after the move.
  - `writeSkillFiles` writes into the right pack.
- `test/rig-core.test.ts` keeps enforcing module headers and BUILTINS ⊆ RESERVED; add `pack`.

## Phases

Each phase ends with `bun run typecheck && bun test && rig sync && rig ls` passing.

1. **Resolver.** `resolve.ts` (virtual modules, already proven by the spike), the SDK re-exporting `z`, `--no-install` in the launcher. Remove the test-helper workaround.
2. **Pack model.** `packs.ts`, `pack.json`, the four discovery sources, and the registry iterating packs. Move core to `packs/rig/`. In this phase the personal content moves into `packs/myang/` in the repo (gitignored) so nothing breaks.
3. **Namespacing.** Qualified commands, the collision rules, aliases, qualified `disabled`, and the CLI lookup.
4. **Dependencies.** `deps.ts`, `rig pack install`, stamps, the peer check.
5. **Instructions and generated files.** Config-dir instructions with the migration message; `writeSkillFiles` per pack.
6. **CLI and docs.** `rig pack` subcommands, `rig new pack`, `--pack`, `ls`/`status` output, README and both rig skills.
7. **Move out.** Move `packs/myang/` to its own repo and location; move personal tests with it; confirm a clean clone of rig has only the `rig` pack and passes tests.

## Open questions

- npm package name: `rig` is taken (the spike's auto-install fetched `rig@0.7.0`). This affects the `"rig"` import specifier only cosmetically, since the plugin can map any specifier, but pack authors' `peerDependencies` need the real name.
- When installed from a package manager, the binary is already on PATH, so the `~/.local/bin/rig` link from `sync` is redundant and could shadow a newer global install. Probably skip the bin link when `paths.root` is inside a `node_modules`. Settle this in the npm phase.
- Whole-pack disable syntax (`rig pack disable` vs `rig remove myang:`).
