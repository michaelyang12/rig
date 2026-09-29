import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, tildify } from "../core/paths";
import { RESERVED } from "../core/registry";
import { c, takeFlags } from "../core/ui";
import { apiKeyVar, envPrefix, RigError } from "../sdk";

const tsWithAuth = (name: string) => {
  const prefix = envPrefix(name);
  return `import { z } from "zod";
import { bearer, defineCommand, defineTool, request } from "rig";

// ${prefix}_API_KEY is added automatically; declare any companion vars below.
// Every var must be prefixed ${prefix}_. Set them with: rig auth ${name}
const api = (ctx: { secret(name: string): string }, path: string) =>
  request(\`\${ctx.secret("${prefix}_BASE_URL")}\${path}\`, {
    tool: "${name}",
    headers: { authorization: bearer(ctx.secret("${apiKeyVar(name)}")) },
  });

export default defineTool({
  name: "${name}",
  description: "Describe what ${name} does in one line",
  auth: [{ name: "${prefix}_BASE_URL", prompt: "${name} base URL", example: "https://api.example.com" }],

  // Cheap authenticated call; rig auth runs it after saving credentials.
  async verify(ctx) {
    await api(ctx, "/me");
  },

  commands: {
    "${name}-get": defineCommand({
      description: "Fetch an item by id",
      args: z.object({
        id: z.string().describe("Item id"),
      }),
      positional: ["id"],
      async run({ id }, ctx) {
        return api(ctx, \`/items/\${encodeURIComponent(id)}\`);
      },
    }),
  },
});
`;
};

const tsNoAuth = (name: string) => `import { z } from "zod";
import { defineCommand, defineTool } from "rig";

export default defineTool({
  name: "${name}",
  description: "Describe what ${name} does in one line",
  commands: {
    "${name}": defineCommand({
      description: "Say hello",
      args: z.object({
        name: z.string().default("world").describe("Who to greet"),
        loud: z.boolean().default(false).describe("Shout it"),
      }),
      positional: ["name"],
      run({ name, loud }) {
        const msg = \`hello \${name}\`;
        return loud ? msg.toUpperCase() : msg;
      },
    }),
  },
});
`;

const uvToolJson = (name: string, auth: boolean) =>
  JSON.stringify(
    {
      name,
      description: `Describe what ${name} does in one line`,
      runtime: "uv",
      entry: "main.py",
      ...(auth ? { auth: [], verify: `${name}-verify` } : {}),
      commands: {
        [name]: {
          description: "Say hello",
          args: {
            type: "object",
            properties: { name: { type: "string", description: "Who to greet", default: "world" } },
          },
          positional: ["name"],
        },
        ...(auth ? { [`${name}-verify`]: { description: "Check credentials" } } : {}),
      },
    },
    null,
    2,
  ) + "\n";

const uvMain = (name: string, auth: boolean) => `# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""rig tool: args arrive as JSON on stdin, the command name as argv[1].
Print the result to stdout (JSON or text). Exit 2 for bad input, 3 for bad credentials."""
import json
import os
import sys


def hello(args):
    return {"message": f"hello {args.get('name', 'world')}"}
${
  auth
    ? `

def verify(args):
    if not os.environ.get("${apiKeyVar(name)}"):
        print("${apiKeyVar(name)} is not set", file=sys.stderr)
        sys.exit(3)
    return "ok"
`
    : ""
}

COMMANDS = {"${name}": hello${auth ? `, "${name}-verify": verify` : ""}}


if __name__ == "__main__":
    command = sys.argv[1]
    if command not in COMMANDS:
        print(f"unknown command {command}", file=sys.stderr)
        sys.exit(2)
    result = COMMANDS[command](json.load(sys.stdin))
    print(result if isinstance(result, str) else json.dumps(result))
`;

const skillMd = (name: string, commands: string) => `---
name: ${name}
description: Use when <describe the situations where an agent should reach for ${name}>.
---

# ${name}

This skill is backed by the \`rig\` CLI.

- ${commands}
- Run \`rig <command> --help\` for flags. Add \`--json\` for a \`{ok, data}\` envelope.
- Exit code 3 means credentials are missing or invalid: ask the user to run \`rig auth ${name}\`. Never ask them to paste keys into chat.
`;

function checkName(kind: string, name: string | undefined): string {
  if (!name) throw new RigError("USAGE", `usage: rig new ${kind} <name>`);
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new RigError("USAGE", "name must be lowercase kebab-case");
  if (RESERVED.includes(name)) throw new RigError("USAGE", `${name} is a reserved rig command`);
  return name;
}

function write(file: string, content: string): void {
  writeFileSync(file, content);
  console.log(`  ${c.green("+")} ${tildify(file)}`);
}

export async function newCmd(argv: string[]): Promise<number> {
  const { flags, rest } = takeFlags(argv, ["--auth", "--uv", "--no-skill"]);
  const [kind, rawName] = rest;

  if (kind === "skill") {
    const name = checkName("skill", rawName);
    const dir = join(paths.skills, name);
    if (existsSync(dir)) throw new RigError("USAGE", `${tildify(dir)} already exists`);
    mkdirSync(dir, { recursive: true });
    write(join(dir, "SKILL.md"), skillMd(name, "Describe how to do the task, and which `rig` commands to use"));
    console.log(c.dim(`\nnext: edit SKILL.md, then rig sync`));
    return 0;
  }

  if (kind !== "tool") throw new RigError("USAGE", "usage: rig new tool <name> [--auth] [--uv] [--no-skill] | rig new skill <name>");

  const name = checkName("tool", rawName);
  const dir = join(paths.tools, name);
  if (existsSync(dir)) throw new RigError("USAGE", `${tildify(dir)} already exists`);
  mkdirSync(dir, { recursive: true });
  const auth = flags.has("--auth");

  let firstCommand: string;
  if (flags.has("--uv")) {
    write(join(dir, "tool.json"), uvToolJson(name, auth));
    write(join(dir, "main.py"), uvMain(name, auth));
    firstCommand = name;
  } else {
    write(join(dir, "index.ts"), auth ? tsWithAuth(name) : tsNoAuth(name));
    firstCommand = auth ? `${name}-get <id>` : `${name} [name]`;
  }

  if (!flags.has("--no-skill")) {
    const skillDir = join(paths.skills, name);
    if (!existsSync(skillDir)) {
      mkdirSync(skillDir, { recursive: true });
      write(join(skillDir, "SKILL.md"), skillMd(name, `\`rig ${firstCommand}\`: describe what it returns`));
    }
  }

  console.log(c.dim(`\nnext: edit the tool${flags.has("--no-skill") ? "" : " and SKILL.md"}, then rig sync${auth ? ` && rig auth ${name}` : ""}`));
  return 0;
}
