// @module Writes tools' skillFiles() output into <pack>/skills/<tool>/ during sync.
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isActive, type Registry } from "./registry";

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write each enabled tool's `skillFiles()` into `skills/<tool>/` of the tool's own pack. Only writes files
 * whose content changed. Returns the paths (`<pack>/skills/<tool>/<file>`) written or, on a dry run, that would be; problems go to `reg.problems`.
 */
export async function writeSkillFiles(reg: Registry, { dryRun = false } = {}): Promise<string[]> {
  const written: string[] = [];
  for (const tool of reg.tools) {
    if (!isActive(tool) || !tool.skillFiles) continue;
    let files: Record<string, string | undefined>;
    try {
      files = await tool.skillFiles();
    } catch (err) {
      reg.problems.push(`tool ${tool.name}: skillFiles failed: ${(err as Error).message}`);
      continue;
    }
    const dir = join(tool.pack.dir, "skills", tool.name);
    if (!existsSync(join(dir, "SKILL.md"))) {
      reg.problems.push(`tool ${tool.name}: skillFiles needs skills/${tool.name}/SKILL.md to write into`);
      continue;
    }
    for (const [rel, content] of Object.entries(files)) {
      if (content === undefined) continue;
      const file = resolve(dir, rel);
      if (relative(dir, file).startsWith("..") || rel === "SKILL.md") {
        reg.problems.push(`tool ${tool.name}: skillFiles path "${rel}" must stay inside skills/${tool.name}/ and not be SKILL.md`);
        continue;
      }
      if (existsSync(file) && readFileSync(file, "utf8") === content) continue;
      if (!writable(dir)) {
        reg.problems.push(`tool ${tool.name}: pack ${tool.pack.name} isn't writable, so skillFiles were not written to skills/${tool.name}/`);
        break;
      }
      if (!dryRun) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
      written.push(join(tool.pack.name, relative(tool.pack.dir, file)));
    }
  }
  return written;
}
