import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig, saveConfig } from "../core/config";
import { CORE_PACK, discoverPacks, type Pack } from "../core/packs";
import { expandHome, paths, tildify } from "../core/paths";
import { RESERVED } from "../core/registry";
import { c, takeFlags } from "../core/ui";
import { apiKeyVar, envPrefix, RigError } from "../sdk";

const tsWithAuth = (name: string) => {
  const prefix = envPrefix(name);
  return `import { bearer, defineCommand, defineTool, request, z } from "rig";

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

const tsNoAuth = (name: string) => `import { defineCommand, defineTool, z } from "rig";

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

/** Refuses a name another pack already uses, since that would be a collision. */
function checkUnused(kind: "tools" | "skills", name: string, except?: Pack): void {
  const owner = discoverPacks(loadConfig()).packs.find((p) => p.dir !== except?.dir && existsSync(join(p.dir, kind, name)));
  if (owner) throw new RigError("USAGE", `${tildify(join(owner.dir, kind, name))} already exists (pack ${owner.name})`);
}

/**
 * `--pack`, else config `defaultPack`, else the only user pack. `--pack rig` targets the core pack, for
 * rig development.
 */
function targetPack(flag: string | undefined): Pack {
  const config = loadConfig();
  const { packs } = discoverPacks(config);
  const listed = `packs: ${packs.map((p) => p.name).join(", ")}`;
  const name = flag ?? config.defaultPack;
  if (name) {
    const pack = packs.find((p) => p.name === name);
    if (!pack) throw new RigError("USAGE", `no pack named ${name}${flag ? "" : " (config defaultPack)"}`, listed);
    return pack;
  }
  const user = packs.filter((p) => p.name !== CORE_PACK);
  if (user.length === 1) return user[0]!;
  if (user.length) throw new RigError("USAGE", "more than one pack; choose one with --pack <name>, or set defaultPack in config", listed);
  throw new RigError("USAGE", "no user pack yet", "create one with: rig new pack <name>");
}

const packGitignore = "node_modules\n";

/** Scaffolds a pack in `~/.config/rig/packs/<name>`, or at --path (which is then added to config "packs"). */
function newPack(rawName: string | undefined, path: string | undefined): number {
  const name = checkName("pack", rawName);
  if (name === CORE_PACK) throw new RigError("USAGE", `"${CORE_PACK}" is reserved for the core pack`);
  const config = loadConfig();
  const taken = discoverPacks(config).packs.find((p) => p.name === name);
  if (taken) throw new RigError("USAGE", `a pack named ${name} already exists at ${tildify(taken.dir)}`);
  const dir = path ? resolve(expandHome(path)) : join(paths.userPacksDir, name);
  if (existsSync(join(dir, "pack.json"))) throw new RigError("USAGE", `${tildify(dir)} already has a pack.json`);
  for (const sub of ["skills", "tools"]) mkdirSync(join(dir, sub), { recursive: true });
  write(join(dir, "pack.json"), JSON.stringify({ name, description: `Describe what the ${name} pack is for` }, null, 2) + "\n");
  write(join(dir, ".gitignore"), packGitignore);
  if (path && !dir.startsWith(paths.userPacksDir + "/")) {
    saveConfig({ ...config, packs: [...config.packs, tildify(dir)] });
    console.log(c.dim(`  added ${tildify(dir)} to config "packs"`));
  }
  console.log(c.dim(`\nnext: rig new tool <name> --pack ${name}`));
  return 0;
}

function write(file: string, content: string): void {
  writeFileSync(file, content);
  console.log(`  ${c.green("+")} ${tildify(file)}`);
}

export async function newCmd(argv: string[]): Promise<number> {
  const { flags, values, rest } = takeFlags(argv, ["--auth", "--uv", "--no-skill"], ["--pack", "--path"]);
  const [kind, rawName] = rest;

  if (kind === "pack") return newPack(rawName, values.get("--path"));

  if (kind === "instructions") {
    if (existsSync(paths.instructionsFile)) throw new RigError("USAGE", `${tildify(paths.instructionsFile)} already exists`);
    mkdirSync(dirname(paths.instructionsFile), { recursive: true });
    write(paths.instructionsFile, readFileSync(paths.instructionsExample, "utf8"));
    console.log(c.dim(`\nnext: edit it, then rig sync`));
    return 0;
  }

  if (kind === "skill") {
    const name = checkName("skill", rawName);
    const dir = join(targetPack(values.get("--pack")).dir, "skills", name);
    checkUnused("skills", name);
    mkdirSync(dir, { recursive: true });
    write(join(dir, "SKILL.md"), skillMd(name, "Describe how to do the task, and which `rig` commands to use"));
    console.log(c.dim(`\nnext: edit SKILL.md, then rig sync`));
    return 0;
  }

  if (kind !== "tool") throw new RigError("USAGE", "usage: rig new tool <name> [--auth] [--uv] [--no-skill] [--pack <name>] | rig new skill <name> [--pack <name>] | rig new pack <name> [--path <dir>] | rig new instructions");

  const name = checkName("tool", rawName);
  const pack = targetPack(values.get("--pack"));
  const dir = join(pack.dir, "tools", name);
  checkUnused("tools", name);
  if (!flags.has("--no-skill")) checkUnused("skills", name, pack);
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
    const skillDir = join(pack.dir, "skills", name);
    if (!existsSync(skillDir)) {
      mkdirSync(skillDir, { recursive: true });
      write(join(skillDir, "SKILL.md"), skillMd(name, `\`rig ${firstCommand}\`: describe what it returns`));
    }
  }

  console.log(c.dim(`\nnext: edit the tool${flags.has("--no-skill") ? "" : " and SKILL.md"}, then rig sync${auth ? ` && rig auth ${name}` : ""}`));
  return 0;
}
