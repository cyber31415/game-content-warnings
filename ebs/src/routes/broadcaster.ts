import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BroadcasterConfigResponse, DddSearchResult } from "../../../shared/api.d.ts";
import type { DddClient } from "../ddd/client.ts";
import type { LiveUpdates } from "../live.ts";
import type { WarningsService } from "../warnings.ts";

const OverrideBody = z.object({
  dddItemId: z.number().int().positive().max(2_147_483_647).nullable(),
  // The category the broadcaster saw when choosing; must still be the channel's category.
  twitchGameId: z.string().regex(/^\d+$/),
});
const SearchQuery = z.object({ q: z.string().trim().min(2).max(100) });

/** DDD requests cost monthly quota, so broadcaster actions get small per-channel allowances. */
const SEARCHES_PER_MINUTE = 6;
const SEARCHES_PER_DAY = 60;
const SAVES_PER_DAY = 30;
/** Below this many requests left this month, keep the rest for viewers' lookups. */
const MONTHLY_RESERVE = 300;

const DAY = 24 * 60 * 60_000;

/** Sliding-window counter per key, kept in memory (resets on restart, which is fine). */
class Allowance {
  private readonly hits = new Map<string, number[]>();
  take(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

export function broadcasterRoutes(deps: { ddd: DddClient; warnings: WarningsService; live: LiveUpdates }) {
  const perMinute = new Allowance();
  const perDay = new Allowance();

  const budgetLow = () => {
    const left = deps.ddd.budget.remainingMonth;
    return left !== null && left < MONTHLY_RESERVE;
  };

  return async (app: FastifyInstance) => {
    app.addHook("preHandler", async (request, reply) => {
      if (request.ext.role !== "broadcaster") return reply.code(403).send({ error: "broadcaster only" });
    });

    app.get("/api/broadcaster/config", async (request): Promise<BroadcasterConfigResponse> => {
      const channelId = request.ext.channel_id;
      deps.warnings.noteChannelSeen(channelId);
      void deps.live.ensureSubscribed(channelId);
      const current = await deps.warnings.forChannel(channelId);
      const game = await deps.warnings.channelGame(channelId).catch(() => undefined);
      return {
        overrideDddItemId: game?.id ? await deps.warnings.corrections.for(channelId, game.id) : null,
        current,
        candidates: game?.id ? deps.warnings.candidatesFor(game.id) : [],
        liveUpdates: deps.live.enabled,
      };
    });

    app.put("/api/broadcaster/override", async (request, reply) => {
      const body = OverrideBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "dddItemId must be a positive integer or null, with twitchGameId" });
      const channelId = request.ext.channel_id;
      const { dddItemId, twitchGameId } = body.data;

      // Check the live category (not the cache) so a correction can't land on the previous game.
      const game = await deps.warnings.channelGame(channelId, undefined, { fresh: true }).catch(() => undefined);
      if (!game?.id) return reply.code(409).send({ error: "Set a category for your channel in Stream Manager first" });
      if (game.id !== twitchGameId) return reply.code(409).send({ error: "Your category just changed. Reopen this page and try again." });

      if (!perDay.take(`save:${channelId}`, SAVES_PER_DAY, DAY)) return reply.code(429).send({ error: "Too many changes today. Try again tomorrow." });
      if (dddItemId !== null) {
        if (budgetLow()) return reply.code(503).send({ error: "Lookups are limited right now. Try again later." });
        // Validates the id exists (and warms the cache) before saving it.
        try {
          await deps.warnings.item(dddItemId);
        } catch {
          return reply.code(422).send({ error: "DDD item not found or DDD unavailable" });
        }
      }
      try {
        await deps.warnings.corrections.set(channelId, game.id, dddItemId);
      } catch (err) {
        request.log.warn({ channelId, err: String(err) }, "saving correction failed");
        return reply.code(503).send({ error: "Couldn't save right now. Try again in a minute." });
      }
      deps.warnings.invalidateResponses();
      void deps.live.broadcastCurrent(channelId);
      return { ok: true, overrideDddItemId: dddItemId };
    });

    app.get("/api/broadcaster/search", async (request, reply) => {
      const q = SearchQuery.safeParse(request.query);
      if (!q.success) return reply.code(400).send({ error: "q must be 2-100 characters" });
      const channelId = request.ext.channel_id;
      if (!perMinute.take(`search:${channelId}`, SEARCHES_PER_MINUTE, 60_000)) {
        return reply.code(429).send({ error: "Too many searches, wait a minute." });
      }
      if (!perDay.take(`search:${channelId}`, SEARCHES_PER_DAY, DAY)) return reply.code(429).send({ error: "Daily search limit reached. Try again tomorrow." });
      if (budgetLow()) return reply.code(503).send({ error: "Search is limited right now. Try again later." });
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
