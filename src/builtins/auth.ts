import { lookupVar, readEnvFile, upsertEnvFile } from "../core/env";
import { makeContext, resolveAuth, spawnExternal } from "../core/dispatch";
import { paths, tildify } from "../core/paths";
import { loadRegistry, type ResolvedTool } from "../core/registry";
import { c, takeFlags } from "../core/ui";
import { RigError } from "../sdk";

export async function verifyTool(tool: ResolvedTool): Promise<void> {
  resolveAuth(tool);
  if (tool.verify) return tool.verify(makeContext(tool));
  if (tool.verifyCommand) {
    const { code, stderr } = await spawnExternal(tool, tool.verifyCommand, {}, { json: false, capture: true });
    if (code !== 0) throw new Error(stderr.trim() || `${tool.verifyCommand} exited with code ${code}`);
  }
}

function canVerify(tool: ResolvedTool): boolean {
  return Boolean(tool.verify || tool.verifyCommand);
}

function printStatus(tools: ResolvedTool[]): boolean {
  const file = readEnvFile();
  let ok = true;
  for (const tool of tools) {
    console.log(c.bold(tool.name));
    for (const v of tool.auth) {
      const found = lookupVar(v.name, file);
      if (found) console.log(`  ${c.green("✓")} ${v.name} ${c.dim(found.source === "env" ? "(shell env)" : "(rig .env)")}`);
      else if (v.optional) console.log(`  ${c.dim("-")} ${v.name} ${c.dim("(optional)")}`);
      else {
        ok = false;
        console.log(`  ${c.red("✗")} ${v.name}`);
      }
    }
  }
  return ok;
}

export async function auth(argv: string[]): Promise<number> {
  const { flags, rest } = takeFlags(argv, ["--status", "--no-verify"]);
  const [name] = rest;
  const reg = await loadRegistry();
  const withAuth = reg.tools.filter((t) => !t.disabled && t.auth.length);

  let tools = withAuth;
  if (name) {
    const tool = reg.tools.find((t) => t.name === name);
    if (!tool) throw new RigError("NOT_FOUND", `no tool named ${name}`, "see: rig status");
    if (!tool.auth.length) {
      console.log(`${name} doesn't need any credentials`);
      return 0;
    }
    tools = [tool];
  }

  if (!tools.length) {
    console.log("no tools need credentials");
    return 0;
  }

  if (flags.has("--status")) return printStatus(tools) ? 0 : 3;

  if (!process.stdin.isTTY) {
    printStatus(tools);
    throw new RigError(
      "USAGE",
      "rig auth is interactive and needs a terminal",
      `ask the user to run \`rig auth${name ? " " + name : ""}\`, or set the vars in ${tildify(paths.envFile)}`,
    );
  }

  const p = await import("@clack/prompts");
  p.intro(c.bold(" rig auth "));

  const file = readEnvFile();
  // With no tool named, only walk tools that are missing something.
  const queue = name ? tools : tools.filter((t) => t.auth.some((v) => !v.optional && !lookupVar(v.name, file)));
  if (!queue.length) {
    p.outro("All tools are configured. Use `rig auth <tool>` to change credentials.");
    return 0;
  }

  let failures = 0;
  for (const tool of queue) {
    p.log.step(`${c.bold(tool.name)} ${c.dim(tool.description)}`);
    const updates: Record<string, string> = {};

    for (const v of tool.auth) {
      const found = lookupVar(v.name, file);
      if (found?.source === "env") {
        p.log.info(`${v.name} is set in your shell env, which overrides rig's .env; skipping`);
        continue;
      }
      if (found && !name) continue;

      const label = `${v.prompt} ${c.dim(v.name)}`;
      const required = !v.optional && !found;
      const validate = (s: string | undefined) => (required && !s?.trim() ? `${v.name} is required` : undefined);
      const answer = v.secret
        ? await p.password({ message: found ? `${label} ${c.dim("(enter to keep current)")}` : label, validate })
        : await p.text({ message: label, placeholder: v.example, initialValue: found?.value, validate });

      if (p.isCancel(answer)) {
        p.cancel("Cancelled; nothing saved for " + tool.name);
        return 1;
      }
      const value = (answer ?? "").trim();
      if (value && value !== found?.value) updates[v.name] = value;
    }

    const keys = Object.keys(updates);
    if (keys.length) {
      upsertEnvFile(updates);
      Object.assign(file, updates);
      p.log.success(`Saved ${keys.join(", ")} to ${tildify(paths.envFile)}`);
    }

    if (canVerify(tool) && !flags.has("--no-verify")) {
      const s = p.spinner();
      s.start(`Verifying ${tool.name} credentials`);
      try {
        await verifyTool(tool);
        s.stop(`${tool.name} credentials work`);
      } catch (err) {
        failures++;
        s.error(`${tool.name} verification failed: ${(err as Error).message}`);
      }
    }
  }

  p.outro(failures ? c.yellow(`${failures} tool(s) failed verification; re-run rig auth <tool>`) : "Done");
  return failures ? 3 : 0;
}
