import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTINS } from "../src/builtins";
import { RESERVED } from "../src/core/registry";
import { REPO } from "./helpers";

// rig-core is hand-written and deliberately curated (it doesn't map every file). Only the command
// surface is checked: a built-in missing from rig-core or from RESERVED is a real defect, not a style gap.
const skill = readFileSync(join(REPO, "skills", "rig-core", "SKILL.md"), "utf8");

describe("rig-core skill stays in sync", () => {
  test("names every built-in command", () => {
    const missing = Object.keys(BUILTINS).filter((name) => !skill.includes(`\`${name}\``) && !skill.includes(`rig ${name}`));
    expect(missing).toEqual([]);
  });

  test("every built-in is reserved, so no tool command can be shadowed by one", () => {
    expect(Object.keys(BUILTINS).filter((name) => !RESERVED.includes(name))).toEqual([]);
  });
});
