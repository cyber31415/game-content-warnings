import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { WarningsService } from "../warnings.ts";
import type { LiveUpdates } from "../live.ts";

const Query = z.object({ hint: z.string().max(200).optional() });

export function warningsRoutes(deps: { warnings: WarningsService; live: LiveUpdates }) {
  return async (app: FastifyInstance) => {
    app.get("/api/warnings", async (request, reply) => {
      const q = Query.safeParse(request.query);
      if (!q.success) return reply.code(400).send({ error: "bad query" });
      const channelId = request.ext.channel_id; // only ever from the verified token
      if (deps.warnings.noteChannelSeen(channelId)) void deps.live.ensureSubscribed(channelId);
      const body = await deps.warnings.forChannel(channelId, { hint: q.data.hint });
      reply.header("Cache-Control", "private, max-age=30");
      return body;
    });

    // Topic names, broad categories and search keywords (changes ~weekly).
    // Clients request it with ?v=<topicsVersion> so the browser cache stays valid per version.
    app.get("/api/topics", async (_request, reply) => {
      try {
        const dict = await deps.warnings.topics.get();
        reply.header("Cache-Control", "private, max-age=86400");
        return dict;
      } catch {
        return reply.code(503).send({ error: "topic catalogue unavailable" });
      }
    });
  };
}
