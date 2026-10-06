import { z } from "zod";
import { defineCommand, defineTool } from "rig";

export default defineTool({
  name: "greet",
  description: "Greets people",
  commands: {
    greet: defineCommand({
      description: "Say hello",
      args: z.object({
        name: z.string().describe("Who to greet"),
        loud: z.boolean().default(false),
        times: z.number().int().min(1).default(1),
        tag: z.array(z.string()).default([]),
      }),
      positional: ["name"],
      run({ name, loud, times, tag }) {
        const msg = `hello ${name}${tag.length ? ` [${tag.join(",")}]` : ""}`;
        return Array(times).fill(loud ? msg.toUpperCase() : msg).join("\n");
      },
    }),
    "greet-obj": defineCommand({
      description: "Structured greeting",
      args: z.object({ name: z.string() }),
      run: ({ name }) => ({ greeting: `hi ${name}` }),
      format: (r: { greeting: string }) => `>> ${r.greeting}`,
    }),
  },
});
