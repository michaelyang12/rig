import { z } from "zod";
import { bearer, defineCommand, defineTool, request } from "rig";

const api = (ctx: { secret(name: string): string }, path: string) =>
  request(`${ctx.secret("ACME_BASE_URL")}${path}`, {
    tool: "acme",
    headers: { authorization: bearer(ctx.secret("ACME_API_KEY")) },
  });

export default defineTool({
  name: "acme",
  description: "Talks to the Acme API",
  auth: [
    { name: "ACME_BASE_URL", prompt: "Acme base URL", example: "https://acme.test" },
    { name: "ACME_REGION", prompt: "Region", optional: true },
  ],
  async verify(ctx) {
    await api(ctx, "/me");
  },
  commands: {
    "acme-whoami": defineCommand({
      description: "Show the current user",
      args: z.object({}),
      run: (_args, ctx) => api(ctx, "/me"),
    }),
  },
});
