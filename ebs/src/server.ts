import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import compress from "@fastify/compress";
import { loadConfig, type Config } from "./config.ts";
import { healthRoutes } from "./routes/health.ts";
import { warningsRoutes } from "./routes/warnings.ts";
import { broadcasterRoutes } from "./routes/broadcaster.ts";
import { eventsubRoutes } from "./routes/eventsub.ts";
import { LEGAL_UPDATED, legalRoutes } from "./routes/legal.ts";
import { requireExtensionAuth } from "./auth/hook.ts";
import { AppTokenManager, HelixClient } from "./twitch/helix.ts";
import { DddClient } from "./ddd/client.ts";
import { Store } from "./cache/db.ts";
import { TTL, WarningsService } from "./warnings.ts";
import { LiveUpdates } from "./live.ts";
import { TopicCatalog } from "./topics.ts";
import { MANUAL_MAPPINGS } from "./match/manual-mappings.ts";
import { Corrections } from "./corrections.ts";

export type Deps = { config: Config; helix: HelixClient; ddd: DddClient; store: Store };

export async function buildServer(deps: Deps): Promise<FastifyInstance> {
  const { config, helix, ddd, store } = deps;
  const app = Fastify({
    trustProxy: config.env === "production", // behind the host's TLS proxy
    logger:
      config.env === "test"
        ? false
        : {
            // Never log tokens or viewer identifiers: requests are logged as method + path only
            // (Fastify's default would include the client IP and port).
            serializers: {
              req: (req: { method?: string; url?: string }) => ({ method: req.method, url: req.url?.split("?")[0] }),
            },
          },
  });

  for (const m of MANUAL_MAPPINGS) store.putManualMatch(m.twitchGameId, m.twitchName, m.dddItemId);
  const topics = new TopicCatalog({ store, ddd, log: app.log });
  const corrections = new Corrections({
    store,
    helix,
    extensionSecret: config.twitch.extensionSecret,
    ownerId: config.twitch.ownerId,
    mode: config.correctionsStore,
    log: app.log,
  });
  const warnings = new WarningsService({ store, ddd, helix, topics, corrections, log: app.log });
  const live = new LiveUpdates({
    store,
    helix,
    warnings,
    extensionSecret: config.twitch.extensionSecret,
    ownerId: config.twitch.ownerId,
    eventsub: config.eventsub,
    log: app.log,
  });

  await app.register(compress, { global: true, threshold: 2048 });
  await app.register(cors, {
    origin: config.allowedOrigins,
    allowedHeaders: ["Authorization", "Content-Type", "X-Extension-JWT"],
    methods: ["GET", "PUT"],
  });
  // Generous per-IP limit: many viewers can share one IP (NAT, campuses). Upstream
  // protection comes from caching + single-flight, not from limiting viewers per channel.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    allowList: (req) => req.url === "/health" || req.url === "/eventsub",
    // Prefer a client-IP header set by a proxy the client can't spoof (X-Forwarded-For can be forged).
    keyGenerator: (req) => {
      const v = config.clientIpHeader ? req.headers[config.clientIpHeader] : undefined;
      return (typeof v === "string" && v.split(",")[0]!.trim()) || req.ip;
    },
  });

  await app.register(healthRoutes({ ddd }));
  await app.register(legalRoutes({ ...config.legal, updated: LEGAL_UPDATED }));
  if (config.eventsub) await app.register(eventsubRoutes({ secret: config.eventsub.secret, live }));

  await app.register(async (api) => {
    api.addHook("preHandler", requireExtensionAuth(config.twitch.extensionSecret));
    await api.register(warningsRoutes({ warnings, live }));
    await api.register(broadcasterRoutes({ ddd, warnings, live }));
  });

  // DDD terms: never keep cached data longer than 30 days.
  const purge = setInterval(() => store.purgeItemsOlderThan(Date.now() - TTL.itemMaxStale), 6 * 60 * 60_000);
  purge.unref();
  app.addHook("onClose", async () => clearInterval(purge));

  if (config.env !== "test") {
    // Warm the topic catalogue (3 DDD requests, cached a week) so no viewer waits for it.
    app.addHook("onReady", async () => {
      topics.get().catch((err) => app.log.warn({ err: String(err) }, "topic catalogue prefetch failed"));
    });
  }

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const tokens = new AppTokenManager({
    clientId: config.twitch.clientId,
    clientSecret: config.twitch.clientSecret,
    tokenUrl: config.twitch.tokenUrl,
  });
  const helix = new HelixClient({ clientId: config.twitch.clientId, apiBase: config.twitch.apiBase, tokens });
  const ddd = new DddClient({ apiKey: config.ddd.apiKey, apiBase: config.ddd.apiBase });
  const store = new Store(config.database.path, { vfs: config.database.vfs });
  const app = await buildServer({ config, helix, ddd, store });
  app.addHook("onClose", async () => store.close());
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void app.close());
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ liveUpdates: Boolean(config.eventsub), origins: config.allowedOrigins }, "EBS ready");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
