---
name: blueprint
description: Use when the user says "blueprint X", "write a blueprint for X", "draft a project plan for X", or otherwise asks for a project design doc / implementation plan to be saved; also when they ask to build, implement, or revisit an existing blueprint ("build my keeper blueprint"). Blueprints live in the user's Obsidian vault and are managed with `rig blueprint-*`.
---

# Blueprint

Capture a project's design and implementation plan as a markdown doc in the user's Obsidian vault. Blueprints are short, opinionated, and meant to be revised — they are the starting shape of a project, not a spec.

## When to use

Trigger when the user says any of:

- "blueprint X" / "blueprint this"
- "write a blueprint for ..."
- "draft a project plan for ..."
- "design doc for ..."

Do **not** trigger for: in-code TODOs, brainstorming without intent to persist, or implementation plans for a single PR (those belong in the conversation or a planning tool, not the vault).

## Process

1. **Pick a slug.**
   - One lowercase word or short hyphenated phrase, matching the project's name if it has one (e.g. `keeper`, `glance`).
   - If the project is unnamed, ask the user, or suggest invoking the `mint` skill to name it first.
   - Check for an existing blueprint first: `rig blueprint-ls <slug>`. If one exists, ask whether to revise it instead of starting fresh.

2. **Resolve the path.** Run `rig blueprint-path <slug>`. It creates the directory and prints `<dir>/<slug>-YYYY-MM-DD.md` (local date).
   - If it reports `exists: yes`, ask whether to overwrite, write the suggested `-vN` revision path, or abort.
   - If it fails because `OBSIDIAN_VAULT` is unset, stop and tell the user. Do not guess a path.

3. **Draft the blueprint** using the template below. Fill every section based on what you know; mark unknowns with `?` rather than fabricating. Keep it tight. A blueprint that fits on one screen is more useful than a thorough one nobody re-reads.

4. **Write the file** with the `Write` tool at exactly the path from step 2.

## Building from a blueprint

When the user asks to implement or revisit one ("build the loom blueprint"):

1. `rig blueprint-read <name>` prints it. On an ambiguity error, show the candidates and ask which.
2. Treat it as the starting shape, not a spec: confirm open questions (`?` items) before building, and tick off milestones in the file as they land.

## Template

**This is a template, not example content.** Copy the structure, replace every `{{ … }}` placeholder with real content, and delete the braces. No `{{`, `}}`, or placeholder guidance text should remain in the written file. Where a section has nothing real to say yet, write `?` instead.

```markdown
# {{ project name }}

*Status: Draft · {{ today, YYYY-MM-DD }}*

## Overview
{{ One paragraph: what this is and why it should exist. Lead with the one-line pitch if there is one. }}

## Goals / Non-Goals
- **Goal:** {{ goal }}
- **Non-goal:** {{ something deliberately out of scope }}

## Architecture
{{ Key components and how they fit together, as prose, a module list, or an ASCII/Mermaid diagram, whichever is fastest to read. Mention the stack inline. }}

## Milestones
- [ ] M1: {{ first shippable slice }}
- [ ] M2: {{ … }}

## Open Questions
- {{ an unresolved decision, or `?` }}
```

Add or remove list items as needed. The counts in the template are not targets.

## Defaults & conventions

- **Stack defaults** (apply unless the user specifies otherwise): Bun + TypeScript for web/JS, SvelteKit for web apps, Rust (cargo) or Go for CLIs, Docker for self-hosted services. Local-first / single-user assumptions are the norm.
- **Tone:** Direct, telegraphic. No marketing language. No emojis.
- **Length:** Aim for under ~60 lines of markdown. If a section wants to grow large, that's a sign it should become its own follow-up note.

## Anti-patterns

- Writing the blueprint without confirming the project name or slug first.
- Inventing milestones or architecture detail the user didn't supply — leave `?` instead.
- Dumping a long spec. A blueprint is a starting point; depth comes from iteration.
- Writing anywhere other than the path `rig blueprint-path` returned. Never silently fall back to a different location.

## Output to user

After writing, respond with:

```
Blueprint written: <absolute path>
```

Followed by 1–2 sentences highlighting the open questions worth resolving next.
