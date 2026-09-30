// @module The one place harness dirs (~/.claude, ~/.codex, ~/.agents) are declared; every other path is derived from HARNESSES.
/**
 * A coding-agent harness rig links into. `home` is its user-level dir (with `~`); `skills` and
 * `instructions` are paths inside it, present only if the harness reads that kind of file there.
 */
export interface Harness {
  home: string;
  /** Dir each skill is symlinked into, relative to `home`. */
  skills?: string;
  /** File the global instructions are linked to, relative to `home`. */
  instructions?: string;
  /** Always linked, whatever config chooses (for shared locations many agents read). */
  always?: boolean;
}

/**
 * The single source of truth for harness locations: moving a harness means changing its `home`.
 * `agents` is the cross-agent `~/.agents/skills` that Codex and many third-party harnesses read,
 * so it's always linked. Codex declares no skills dir of its own: it still scans the deprecated
 * `~/.codex/skills` as well, and a skill in both would show up twice.
 */
export const HARNESSES = {
  claude: { home: "~/.claude", skills: "skills", instructions: "CLAUDE.md" },
  codex: { home: "~/.codex", instructions: "AGENTS.md" },
  agents: { home: "~/.agents", skills: "skills", always: true },
} as const satisfies Record<string, Harness>;

export type HarnessId = keyof typeof HARNESSES;
export type HarnessPath = "skills" | "instructions";

export const HARNESS_IDS = Object.keys(HARNESSES) as HarnessId[];

const isAlways = (id: HarnessId) => (HARNESSES[id] as Harness).always === true;
/** Harnesses config can turn on or off; the rest are always linked. */
export const OPTIONAL_HARNESS_IDS = HARNESS_IDS.filter((id) => !isAlways(id));
export const ALWAYS_HARNESS_IDS = HARNESS_IDS.filter(isAlways);

/** Case-insensitive lookup of a harness name, as written in config. */
export function parseHarnessId(name: string): HarnessId | undefined {
  return HARNESS_IDS.find((id) => id === name.toLowerCase());
}

/** `~`-form path of a harness's skills dir or instructions file, or undefined if it has none. */
export function harnessPath(id: HarnessId, kind: HarnessPath): string | undefined {
  const harness: Harness = HARNESSES[id];
  const rel = harness[kind];
  return rel === undefined ? undefined : `${harness.home}/${rel}`;
}

/** `~`-form paths of each given harness that has `kind`, in the given order. */
export function harnessPaths(kind: HarnessPath, ids: readonly HarnessId[] = HARNESS_IDS): string[] {
  return ids.flatMap((id) => harnessPath(id, kind) ?? []);
}
