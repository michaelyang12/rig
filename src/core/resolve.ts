// @module Maps "rig" and "zod" to the running rig's copies for every tool import, wherever its pack lives.
import * as zod from "zod";
import * as sdk from "../sdk";

let installed = false;

/**
 * Virtual modules, not onResolve: Bun's runtime onResolve never sees bare specifiers, while
 * build.module does, even from files outside the repo with no node_modules. Idempotent.
 */
export function installResolver(): void {
  if (installed) return;
  installed = true;
  Bun.plugin({
    name: "rig-resolver",
    setup(build) {
      build.module("rig", () => ({ exports: { ...sdk }, loader: "object" }));
      build.module("zod", () => ({ exports: { ...zod }, loader: "object" }));
    },
  });
}
