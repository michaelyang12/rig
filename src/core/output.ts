// @module The stdout contract: text or the --json envelope, and mapping errors to exit codes 0/1/2/3.
import { z } from "zod";
import { RigError } from "../sdk";

export function renderResult(result: unknown, format?: (r: any) => string): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (format) return format(result);
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

export function printResult(result: unknown, json: boolean, format?: (r: any) => string): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, data: result ?? null }));
    return;
  }
  const text = renderResult(result, format);
  if (text !== undefined) console.log(text);
}

export function toRigError(err: unknown): RigError {
  if (err instanceof RigError) return err;
  if (err instanceof z.ZodError) return new RigError("USAGE", z.prettifyError(err), "see --help for usage");
  return new RigError("INTERNAL", err instanceof Error ? err.message : String(err));
}

/** Print an error per the contract and return the exit code. */
export function printError(err: unknown, json: boolean): number {
  const e = toRigError(err);
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { code: e.code, message: e.message, hint: e.hint } }));
  } else {
    console.error(`error: ${e.message}`);
    if (e.hint) console.error(`hint: ${e.hint}`);
    if (e.code === "INTERNAL" && err instanceof Error && process.env.RIG_DEBUG) console.error(err.stack);
  }
  return e.exitCode;
}
