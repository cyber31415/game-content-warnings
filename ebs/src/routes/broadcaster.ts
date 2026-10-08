import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BroadcasterConfigResponse, DddSearchResult } from "../../../shared/api.d.ts";
import type { Store } from "../cache/db.ts";
import type { DddClient } from "../ddd/client.ts";
import type { LiveUpdates } from "../live.ts";
import type { WarningsService } from "../warnings.ts";

const OverrideBody = z.object({ dddItemId: z.number().int().positive().max(2_147_483_647).nullable() });
const SearchQuery = z.object({ q: z.string().trim().min(2).max(100) });

/** Searches cost DDD quota, so each channel gets a small allowance. */
const SEARCHES_PER_MINUTE = 6;

export function broadcasterRoutes(deps: { store: Store; ddd: DddClient; warnings: WarningsService; live: LiveUpdates }) {
  const searchLog = new Map<string, number[]>();

  return async (app: FastifyInstance) => {
    app.addHook("preHandler", async (request, reply) => {
      if (request.ext.role !== "broadcaster") return reply.code(403).send({ error: "broadcaster only" });
    });

    app.get("/api/broadcaster/config", async (request): Promise<BroadcasterConfigResponse> => {
      const channelId = request.ext.channel_id;
      deps.store.touchChannel(channelId);
      void deps.live.ensureSubscribed(channelId);
      const current = await deps.warnings.forChannel(channelId);
      const game = await deps.warnings.channelGame(channelId).catch(() => undefined);
      return {
        overrideDddItemId: game?.id ? deps.store.overrideFor(channelId, game.id) : null,
        current,
        candidates: game?.id ? deps.warnings.candidatesFor(game.id) : [],
        liveUpdates: deps.live.enabled,
      };
    });

    app.put("/api/broadcaster/override", async (request, reply) => {
      const body = OverrideBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "dddItemId must be a positive integer or null" });
      const channelId = request.ext.channel_id;
      // A correction belongs to the category being streamed; without one there's nothing to correct.
      const game = await deps.warnings.channelGame(channelId).catch(() => undefined);
      if (body.data.dddItemId !== null && !game?.id) {
        return reply.code(409).send({ error: "Set a category for your channel in Stream Manager first" });
      }
      if (body.data.dddItemId !== null) {
        // Validates the id exists (and warms the cache) before saving it.
        try {
          await deps.warnings.item(body.data.dddItemId);
        } catch {
          return reply.code(422).send({ error: "DDD item not found or DDD unavailable" });
        }
      }
      deps.store.setChannelOverride(channelId, body.data.dddItemId, game?.id ?? null);
      deps.warnings.invalidateResponses();
      void deps.live.broadcastCurrent(channelId);
      return { ok: true, overrideDddItemId: body.data.dddItemId };
    });

    app.get("/api/broadcaster/search", async (request, reply) => {
      const q = SearchQuery.safeParse(request.query);
      if (!q.success) return reply.code(400).send({ error: "q must be 2-100 characters" });
      const channelId = request.ext.channel_id;
      const now = Date.now();
      const recent = (searchLog.get(channelId) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= SEARCHES_PER_MINUTE) return reply.code(429).send({ error: "too many searches, wait a minute" });
      searchLog.set(channelId, [...recent, now]);
      try {
        const items = await deps.ddd.search(q.data.q);
        const results: DddSearchResult[] = items.slice(0, 20).map((i) => ({
          id: i.id,
          name: i.name,
          releaseYear: i.releaseYear,
          isVideoGame: /video ?game/i.test(i.itemTypeName ?? ""),
        }));
        return results.sort((a, b) => Number(b.isVideoGame) - Number(a.isVideoGame));
      } catch {
        return reply.code(503).send({ error: "DDD search unavailable" });
      }
    });
  };
}
