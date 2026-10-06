---
name: mint
description: This skill should be used when the user asks to "name a project", "come up with a project name", "what should I call this", "name this tool", "suggest a name", "brainstorm names", or needs a creative name for a CLI tool, API, library, or project.
---

# Simple Namer

Generate creative project names that follow the user's established naming convention: single-word (or single-compound-word) English metaphors drawn from everyday physical actions or objects. The name should poetically evoke what the project does without being a direct synonym.

## The Naming Theme

The user's existing projects reveal a consistent naming philosophy:

| Project | What it does | Why the name works |
|---------|-------------|-------------------|
| **keeper** | Password manager CLI | A keeper guards and holds things safe — not "vault" or "lock" (too literal) |
| **glance** | MTA train time feed | You glance at a schedule — quick, effortless looking |
| **knock** | Command helper CLI | You knock on a door to get in, to get access — a gateway gesture |
| **frame** | Image processing API | A frame holds and presents a picture — structural, not "filter" |
| **slate** | Note-taking app | You write on a slate — a clean writing surface |
| **mint** | Project naming skill | Minting a fresh name — creating something new |
| **rig** | Agent tool CLI | Your outfitted set of gear — everything rigged up and ready |

### Pattern Analysis

The naming convention follows these principles:

1. **Single word** — one English word, lowercase. Compound words that read as one are acceptable (e.g., "whatsthis") but simple single words are preferred.
2. **Physical-world metaphor** — the name is a concrete noun or verb from the physical world (objects, actions, gestures), not an abstract concept.
3. **Evocative, not descriptive** — the name makes you think of the function through association and analogy, not through direct description. It should make someone go "oh, that's clever" once they know what it does.
4. **Not too literal** — avoid names that are obvious synonyms for the function. "vault" for a password manager is too on-the-nose. "keeper" works because it's one step removed — it implies guardianship without screaming "security."
5. **Not too abstract** — avoid names that require a lengthy explanation to connect to the function. The metaphor should click naturally.
6. **Short and memorable** — easy to type in a terminal, easy to say out loud, easy to remember.
7. **Lowercase, no hyphens** — matches CLI/package naming conventions.

## Process

When asked to name a project:

1. **Understand the project** — Ask what the project does if not already clear. Identify the core function in one sentence.
2. **Identify the essence** — Distill the project's purpose to its most fundamental action or role. What is this thing *being* or *doing* at its core? Not the technical implementation, but the human-level function.
3. **Find physical metaphors** — Brainstorm concrete nouns and verbs from the physical world that share that essence. Think about: tools, gestures, household objects, natural phenomena, human roles, spatial concepts.
4. **Filter candidates** — Discard names that are too literal (direct synonyms), too abstract (require explanation), too long, or already widely used by popular tools.
5. **Check availability** — Run `rig mint-check <name> <name> ...` on every shortlisted candidate in one call. Drop any with verdict `conflict` (a command on PATH, an existing `~/Source` project, a Homebrew formula/cask, an existing repo on the user's GitHub, or a popular npm package). Low-download npm/PyPI/crates squats are fine to ignore. If `rig` isn't available, fall back to `which <name>` and `ls ~/Source`.
6. **Present options** — Offer 5-7 candidates, each with a one-line explanation of why the metaphor works. Rank them by fit.

## Anti-Patterns

Avoid these common naming traps:

- **Tech jargon** — "sync", "pipe", "flux", "node" (too technical, not metaphorical)
- **Greek/Latin roots** — "omni", "neo", "proto" (feels corporate, not personal)
- **Direct synonyms** — if the project sends messages, don't call it "messenger" (too literal)
- **Overly cute** — puns or wordplay that sacrifice clarity for cleverness
- **Already taken** — never recommend a name `rig mint-check` flags as a conflict

## Example Naming Session

> "I'm building a CLI that scaffolds project boilerplate."

Essence: This tool lays the groundwork, sets up the foundation before real work begins.

Candidates:
1. **stencil** — a stencil provides the outline to fill in (strong)
2. **draft** — a first draft is the starting shape of something (good)
3. **primer** — a primer coat goes down before the paint (strong)
4. **mold** — a mold gives shape to what's poured into it (good)
5. **sow** — sowing seeds is the first act before growth (moderate — might be too nature-y)

## Output Format

Present names in a ranked list:

```
Here are some names for [brief project description]:

1. **name** — [one-line metaphor explanation]
2. **name** — [one-line metaphor explanation]
...

My top pick: **name** — [why it fits best with the existing family of names]
```

Mention anything notable from the availability check (e.g. "free everywhere", or "npm name squatted, 6 downloads/wk"). Always explain the metaphor connection so the user can evaluate fit. Highlight which name best complements the existing set (keeper, knock, frame) in tone and style.
