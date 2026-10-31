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
import { CacheMirror } from "./cache/mirror.ts";
import { TursoClient } from "./cache/turso.ts";
import { UsageStats, requestField } from "./usage.ts";

export type Deps = { config: Config; helix: HelixClient; ddd: DddClient; store: Store; usage?: UsageStats; mirror?: CacheMirror };

const RESTORE_TIMEOUT_MS = 20_000;
const USAGE_FLUSH_MS = 5 * 60_000;

export async function buildServer(deps: Deps): Promise<FastifyInstance> {
  const { config, helix, ddd, store, usage, mirror } = deps;
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

  // The code list is authoritative: pins removed from it are removed from the database too.
  store.syncManualMatches(MANUAL_MAPPINGS);
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

  if (usage) {
    // Requests and bytes per category of route; the socket counter includes headers and
    // reflects compression, i.e. roughly what the host bills as outbound bandwidth.
    const startBytes = new WeakMap<object, number>();
    app.addHook("onRequest", async (req) => {
      startBytes.set(req, req.raw.socket?.bytesWritten ?? 0);
    });
    app.addHook("onResponse", async (req, reply) => {
      usage.add(requestField(req.method, req.url));
      const sent = (req.raw.socket?.bytesWritten ?? 0) - (startBytes.get(req) ?? 0);
      usage.add("bytesSent", sent > 0 ? sent : Number(reply.getHeader("content-length")) || 0);
    });
    ddd.onRequest = () => usage.add("dddRequests");
  }

  await app.register(healthRoutes({ ddd, store, ...(usage && { usage }), ...(mirror && { mirror }) }));
  await app.register(legalRoutes({ ...config.legal, updated: LEGAL_UPDATED }));
  if (config.eventsub) await app.register(eventsubRoutes({ secret: config.eventsub.secret, live }));

  await app.register(async (api) => {
    api.addHook("preHandler", requireExtensionAuth(config.twitch.extensionSecret));
    await api.register(warningsRoutes({ warnings, live }));
    await api.register(broadcasterRoutes({ ddd, warnings, live }));
  });

  // DDD terms: never keep cached data longer than 30 days. Purge at startup and every 6 h with a
  // cutoff one interval early, so no row can outlive 30 days between runs.
  const PURGE_EVERY = 6 * 60 * 60_000;
  const runPurge = () => {
    store.purgeItemsOlderThan(Date.now() - (TTL.itemMaxStale - PURGE_EVERY));
    warnings.pruneCaches();
  };
  runPurge();
  const purge = setInterval(runPurge, PURGE_EVERY);
  purge.unref();
  app.addHook("onClose", async () => clearInterval(purge));

  if (mirror) {
    mirror.log = app.log;
    // Load the saved cache before serving (and before the catalogue warm-up below, which then
    // finds the saved catalogue instead of spending DDD requests). Never blocks startup for long.
    app.addHook("onReady", async () => {
      try {
        const cutoff = Date.now() - (TTL.itemMaxStale - PURGE_EVERY);
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), RESTORE_TIMEOUT_MS).unref());
        app.log.info(await Promise.race([mirror.restore(cutoff), timeout]), "restored DDD cache from Turso");
      } catch (err) {
        app.log.warn({ err: String(err) }, "restoring the DDD cache from Turso failed; starting with an empty cache");
      }
      mirror.attach();
    });
    const flush = setInterval(() => void mirror.flushUsage().catch(() => {}), USAGE_FLUSH_MS);
    flush.unref();
    app.addHook("onClose", async () => {
      clearInterval(flush);
      await mirror.flushUsage().catch((err) => app.log.warn({ err: String(err) }, "saving usage counts to Turso failed"));
      await mirror.idle();
    });
  }

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
  const usage = new UsageStats();
  usage.add("wakeups");
  const mirror = config.turso ? new CacheMirror({ store, usage, remote: new TursoClient(config.turso) }) : undefined;
  const app = await buildServer({ config, helix, ddd, store, usage, ...(mirror && { mirror }) });
  if (config.tursoProblem) app.log.warn(`Turso disabled: ${config.tursoProblem}`);
  // The store closes after the server (and the mirror's last writes) have finished.
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void app.close().finally(() => store.close()));
  await app.listen({ host: config.host, port: config.port });
  app.log.info({ liveUpdates: Boolean(config.eventsub), origins: config.allowedOrigins, turso: Boolean(mirror) }, "EBS ready");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
