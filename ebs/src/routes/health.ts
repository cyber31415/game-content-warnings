import type { FastifyInstance } from "fastify";
import type { DddClient } from "../ddd/client.ts";
import type { Store } from "../cache/db.ts";
import type { CacheMirror } from "../cache/mirror.ts";
import { USAGE_FIELDS, emptyCounts, type UsageCounts, type UsageStats } from "../usage.ts";

export function healthRoutes(deps: { ddd: DddClient; store: Store; usage?: UsageStats; mirror?: CacheMirror }) {
  return async (app: FastifyInstance) => {
    // DDD quota is included so uptime monitors can alert before the monthly limit runs out.
    app.get("/health", async () => ({ ok: true, uptimeSeconds: Math.round(process.uptime()), dddQuota: deps.ddd.budget }));

    // Aggregate load figures (counts only, no viewer identifiers): per UTC day, saved in Turso
    // when it's configured, otherwise only since this process started.
    app.get("/usage", async (_req, reply) => {
      reply.header("Cache-Control", "no-store");
      const { usage, mirror } = deps;
      let saved: { day: string; counts: UsageCounts }[] = [];
      let persisted = false;
      if (mirror) {
        try {
          saved = await mirror.usageHistory(31);
          persisted = true;
        } catch (err) {
          app.log.warn({ err: String(err) }, "reading usage history from Turso failed");
        }
      }
      // Add counts not saved yet (they're flushed every few minutes).
      const byDay = new Map(saved.map((d) => [d.day, { ...d.counts }]));
      for (const [day, c] of usage?.peek() ?? []) {
        const t = byDay.get(day) ?? emptyCounts();
        for (const f of USAGE_FIELDS) t[f] += c[f];
        byDay.set(day, t);
      }
      const days = [...byDay].sort(([a], [b]) => (a < b ? 1 : -1)).map(([day, counts]) => ({ day, ...counts, bandwidthMB: mb(counts.bytesSent) }));
      const total = emptyCounts();
      for (const d of days) for (const f of USAGE_FIELDS) total[f] += d[f];
      return {
        persisted,
        processStartedAt: new Date(usage?.startedAt ?? Date.now() - process.uptime() * 1000).toISOString(),
        dddQuota: deps.ddd.budget,
        cache: deps.store.cacheCounts(),
        totals: { days: days.length, ...total, bandwidthMB: mb(total.bytesSent) },
        days,
      };
    });
  };
}

const mb = (bytes: number) => Math.round((bytes / 1_048_576) * 100) / 100;
