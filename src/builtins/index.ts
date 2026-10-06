import { auth } from "./auth";
import { config } from "./config";
import { add, desync, remove, status, sync } from "./links";
import { ls, schema } from "./ls";
import { newCmd } from "./new";
import { pack } from "./pack";

/** Built-in commands. Every name here must also be in `RESERVED` (src/core/registry.ts); a test enforces it. */
export const BUILTINS: Record<string, (argv: string[]) => Promise<number>> = {
  ls,
  schema,
  sync,
  remove,
  add,
  desync,
  status,
  auth,
  config,
  new: newCmd,
  pack,
};
