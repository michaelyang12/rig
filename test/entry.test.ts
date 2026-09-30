import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../src/core/registry";
import { REPO, sandbox, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

function addTool(name: string, description: string, command = name) {
  mkdirSync(join(sb.root, "tools", name));
  writeFileSync(
    join(sb.root, "tools", name, "index.ts"),
    `import { z } from "zod";
import { defineCommand, defineTool } from "rig";
export default defineTool({
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(description)},
  commands: {
    ${JSON.stringify(command)}: defineCommand({
      description: "Get the forecast for a city",
      args: z.object({ city: z.string() }),
      positional: ["city"],
      run: ({ city }) => city,
    }),
  },
});
`,
  );
}

describe("rig-entryexec is a static skill", () => {
  const file = join(REPO, "skills", "rig-entryexec", "SKILL.md");
  const text = readFileSync(file, "utf8");
  const fm = parseFrontmatter(text);

  test("has a valid frontmatter within the Agent Skills limits", () => {
    expect(fm.name).toBe("rig-entryexec");
    expect(fm.description!.length).toBeGreaterThan(0);
    expect(fm.description!.length).toBeLessThanOrEqual(1024);
    expect(fm.description).toContain("rig ls");
  });

  test("names no tool, so it never needs to change when tools do", () => {
    const tools = readdirSync(join(REPO, "tools")).filter((d) => statSync(join(REPO, "tools", d)).isDirectory());
    for (const tool of tools) expect(text).not.toMatch(new RegExp(`\\b${tool}\\b`));
  });

  test("stays small", () => {
    expect(text.length).toBeLessThanOrEqual(2048);
  });
});

describe("rig ls", () => {
  test("lists tools, one line each, without their commands", async () => {
    const { code, stdout } = await sb.run(["ls"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/greet\s+Greets people/);
    expect(stdout).not.toContain("greet-obj");
    expect(stdout).toContain("rig ls <tool>");
  });

  test("<tool> shows that tool's commands", async () => {
    const { stdout } = await sb.run(["ls", "greet"]);
    expect(stdout).toMatch(/rig greet <name>\s+Say hello/);
    expect(stdout).toContain("rig greet-obj");
    expect(stdout).not.toContain("pyecho");
    expect(stdout).not.toContain("has a skill");
  });

  test("a command name resolves to its tool", async () => {
    const { stdout } = await sb.run(["ls", "greet-obj"]);
    expect(stdout).toContain("rig greet <name>");
  });

  test("points to a tool's own skill", async () => {
    mkdirSync(join(sb.root, "skills", "greet"));
    writeFileSync(join(sb.root, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: Greeting.\n---\n");
    expect((await sb.run(["ls", "greet"])).stdout).toContain("has a skill: greet");
  });

  test("unknown and disabled names are not found", async () => {
    const r = await sb.run(["ls", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no tool or command named nope");
    await sb.run(["remove", "greet"]);
    expect((await sb.run(["ls", "greet"])).code).toBe(1);
  });

  test("--help prints usage", async () => {
    const { code, stdout } = await sb.run(["ls", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("usage: rig ls [tool]");
  });

  test("--json filters to a tool", async () => {
    const { data } = JSON.parse((await sb.run(["ls", "--json", "greet"])).stdout);
    expect(data.map((d: { command: string }) => d.command)).toEqual(["greet", "greet-obj"]);
    expect(data[0].args.required).toEqual(["name"]);
  });

  test("finds a newly added tool without re-syncing", async () => {
    await sb.run(["sync"]);
    addTool("weather", "Weather forecasts for any city", "weather-forecast");
    expect((await sb.run(["ls"])).stdout).toMatch(/weather\s+Weather forecasts for any city/);
    expect((await sb.run(["ls", "weather"])).stdout).toContain("rig weather-forecast <city>");
    expect((await sb.run(["weather-forecast", "Oslo"])).stdout.trim()).toBe("Oslo");
  });

  test("sync generates nothing", async () => {
    const { stdout } = await sb.run(["sync"]);
    expect(stdout).not.toContain("regenerated");
    expect(readdirSync(join(sb.root, "skills")).sort()).toEqual(["alpha", "beta"]);
  });

  test("an over-long tool description is reported as a problem", async () => {
    addTool("wordy", "x".repeat(301));
    const { code, stdout } = await sb.run(["sync"]);
    expect(code).toBe(1);
    expect(stdout).toContain("tool wordy: description is 301 chars; keep it to 300");
  });
});
