// Public SDK for rig tools. Tools import from "rig" (a tsconfig path alias to this file).
import type { z } from "zod";

export type ErrorCode = "USAGE" | "AUTH" | "NOT_FOUND" | "UPSTREAM" | "INTERNAL";

const EXIT_CODES: Record<ErrorCode, number> = {
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 1,
  UPSTREAM: 1,
  INTERNAL: 1,
};

export class RigError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "RigError";
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

/** An environment variable a tool needs. `<TOOL>_API_KEY` is added automatically when `auth` is set. */
export interface AuthVar {
  name: string;
  prompt: string;
  secret?: boolean;
  optional?: boolean;
  example?: string;
}

export interface Context {
  tool: string;
  /** Resolved value of a variable (process env first, then ~/.config/rig/.env). */
  env(name: string): string | undefined;
  /** Like env(), but throws an AUTH error pointing at `rig auth <tool>` when unset. */
  secret(name: string): string;
  /** Diagnostics go to stderr so stdout stays clean for agents. */
  log(...args: unknown[]): void;
}

export interface CommandDef<S extends z.ZodObject = z.ZodObject> {
  description: string;
  args: S;
  /** Arg names that may also be passed positionally, in order. */
  positional?: (keyof z.input<S> & string)[];
  run(args: z.output<S>, ctx: Context): unknown | Promise<unknown>;
  /** Render the result as text for non --json output. Defaults to strings as-is, everything else as JSON. */
  format?(result: any): string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** Declaring auth (even `[]`) adds the `<TOOL>_API_KEY` secret. All vars must be prefixed `<TOOL>_`. */
  auth?: AuthVar[];
  /** Cheap authenticated call run by `rig auth` after setup. Throw to signal bad credentials. */
  verify?(ctx: Context): Promise<void>;
  /**
   * Files generated into `skills/<tool>/` on every `rig sync`, keyed by path relative to that folder.
   * For content that must track something outside the repo (e.g. a CLI's bundled docs); gitignore them.
   * An `undefined` value skips that file, e.g. when the upstream binary isn't installed.
   */
  skillFiles?(): Record<string, string | undefined> | Promise<Record<string, string | undefined>>;
  commands: Record<string, CommandDef<any>>;
}

export function defineTool<T extends ToolDef>(tool: T): T {
  return tool;
}

/** Typed helper so `run` infers its args from the zod schema. */
export function defineCommand<S extends z.ZodObject>(command: CommandDef<S>): CommandDef<S> {
  return command;
}

export function envPrefix(tool: string): string {
  return tool.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function apiKeyVar(tool: string): string {
  return `${envPrefix(tool)}_API_KEY`;
}

export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}

export interface RequestOptions extends RequestInit {
  /** Tool name, used in the `rig auth <tool>` hint on 401/403. */
  tool?: string;
  /** Parse the response body as JSON (default) or return text. */
  as?: "json" | "text";
}

/**
 * fetch() that maps HTTP failures onto rig's error contract:
 * 401/403 → AUTH (exit 3), 404 → NOT_FOUND, other non-2xx → UPSTREAM.
 */
export async function request<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  const { tool, as = "json", ...init } = opts;
  const headers = new Headers(init.headers);
  if (as === "json" && !headers.has("accept")) headers.set("accept", "application/json");

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (err) {
    throw new RigError("UPSTREAM", `request to ${url} failed: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 500);
    const detail = body ? `: ${body}` : "";
    if (res.status === 401 || res.status === 403) {
      throw new RigError(
        "AUTH",
        `${res.status} ${res.statusText} from ${url}${detail}`,
        tool ? `check credentials with: rig auth ${tool}` : undefined,
      );
    }
    if (res.status === 404) throw new RigError("NOT_FOUND", `not found: ${url}`);
    throw new RigError("UPSTREAM", `${res.status} ${res.statusText} from ${url}${detail}`);
  }

  return (as === "text" ? await res.text() : await res.json()) as T;
}
