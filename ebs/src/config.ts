import { z } from "zod";

const base64Secret = z
  .string()
  .min(1)
  .refine((s) => /^[A-Za-z0-9+/]+={0,2}$/.test(s), "must be base64 (copy the Extension Secret from the Developer Console)");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8081),

  TWITCH_EXT_CLIENT_ID: z.string().min(1),
  // API client secret: used for the Helix app access token (client credentials).
  TWITCH_EXT_CLIENT_SECRET: z.string().min(1),
  // Extension secret (base64): signs/verifies extension JWTs. Different from the client secret.
  TWITCH_EXT_SECRET: base64Secret,
  // Twitch user ID of the account that owns the extension; required in EBS-signed JWTs.
  TWITCH_EXT_OWNER_ID: z.string().regex(/^\d+$/),

  TWITCH_API_BASE: z.url().default("https://api.twitch.tv/helix"),
  // Full token endpoint URL (overridable for the Twitch CLI mock API: http://localhost:8090/auth/token).
  TWITCH_TOKEN_URL: z.url().default("https://id.twitch.tv/oauth2/token"),

  DDD_API_KEY: z.string().min(1),
  DDD_API_BASE: z.url().default("https://www.doesthedogdie.com"),

  DATABASE_PATH: z.string().default("./data/cache.sqlite"),
  // SQLite VFS override. "unix-dotfile" is needed on network shares (CIFS/SMB)
  // that don't support POSIX byte-range locks. Leave empty on normal disks.
  DATABASE_VFS: z.string().optional(),

  // Comma-separated. Defaults to the extension's own frontend origin.
  ALLOWED_ORIGINS: z.string().optional(),

  // Live category updates (EventSub webhook -> Extension PubSub). Enabled when EVENTSUB_SECRET
  // is set. The callback must be public HTTPS on port 443, e.g. https://ebs.example.com/eventsub;
  // on Render it defaults to $RENDER_EXTERNAL_URL/eventsub.
  EVENTSUB_CALLBACK_URL: z.url().optional().or(z.literal("")),
  RENDER_EXTERNAL_URL: z.url().optional().or(z.literal("")),
  EVENTSUB_SECRET: z.string().min(10).max(100).optional().or(z.literal("")),

  // Where broadcaster corrections live: "twitch" = the channel's developer configuration
  // segment (durable on hosts with ephemeral disks; needs "Extension Configuration Service"
  // selected in the Developer Console); "local" = SQLite only (development / Twitch CLI mock).
  CORRECTIONS_STORE: z.enum(["twitch", "local"]).optional(),
  // Header carrying the real client IP, set by a proxy the client can't spoof
  // (e.g. "cf-connecting-ip" behind Cloudflare, as on Render). Used for per-IP rate limiting.
  CLIENT_IP_HEADER: z.string().regex(/^[a-z0-9-]+$/i).optional().or(z.literal("")),

  // Shown on /privacy and /terms (mirrors of the GitHub Pages policy files).
  EXT_NAME: z.string().min(1).max(40).default("Game Content Warnings (Unofficial)"),
  OPERATOR_NAME: z.string().min(1).default("the developer of this extension"),
  CONTACT_EMAIL: z.email().optional().or(z.literal("")),
}).refine((e) => e.NODE_ENV !== "production" || Boolean(e.CONTACT_EMAIL), {
  message: "CONTACT_EMAIL is required in production (it appears on the privacy and terms pages)",
  path: ["CONTACT_EMAIL"],
}).refine((e) => Boolean(e.EVENTSUB_CALLBACK_URL || e.RENDER_EXTERNAL_URL) || !e.EVENTSUB_SECRET, {
  message: "EVENTSUB_SECRET is set but there's no public callback (set EVENTSUB_CALLBACK_URL)",
  path: ["EVENTSUB_CALLBACK_URL"],
}).refine((e) => !e.EVENTSUB_CALLBACK_URL || Boolean(e.EVENTSUB_SECRET), {
  message: "set both EVENTSUB_CALLBACK_URL and EVENTSUB_SECRET, or neither",
  path: ["EVENTSUB_SECRET"],
});

export type Config = {
  env: "development" | "production" | "test";
  host: string;
  port: number;
  twitch: {
    clientId: string;
    clientSecret: string;
    extensionSecret: Uint8Array;
    ownerId: string;
    apiBase: string;
    tokenUrl: string;
  };
  ddd: { apiKey: string; apiBase: string };
  database: { path: string; vfs: string | undefined };
  allowedOrigins: string[];
  eventsub: { callbackUrl: string; secret: string } | undefined;
  legal: { extName: string; operator: string; contactEmail: string };
  correctionsStore: "twitch" | "local";
  clientIpHeader: string | undefined;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const e = parsed.data;
  const allowedOrigins = e.ALLOWED_ORIGINS
    ? e.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : [`https://${e.TWITCH_EXT_CLIENT_ID}.ext-twitch.tv`];
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    twitch: {
      clientId: e.TWITCH_EXT_CLIENT_ID,
      clientSecret: e.TWITCH_EXT_CLIENT_SECRET,
      extensionSecret: new Uint8Array(Buffer.from(e.TWITCH_EXT_SECRET, "base64")),
      ownerId: e.TWITCH_EXT_OWNER_ID,
      apiBase: e.TWITCH_API_BASE.replace(/\/$/, ""),
      tokenUrl: e.TWITCH_TOKEN_URL,
    },
    ddd: { apiKey: e.DDD_API_KEY, apiBase: e.DDD_API_BASE.replace(/\/$/, "") },
    database: { path: e.DATABASE_PATH, vfs: e.DATABASE_VFS || undefined },
    allowedOrigins,
    eventsub: e.EVENTSUB_SECRET
      ? { callbackUrl: e.EVENTSUB_CALLBACK_URL || `${e.RENDER_EXTERNAL_URL!.replace(/\/$/, "")}/eventsub`, secret: e.EVENTSUB_SECRET }
      : undefined,
    legal: { extName: e.EXT_NAME, operator: e.OPERATOR_NAME, contactEmail: e.CONTACT_EMAIL || "(contact email not configured)" },
    correctionsStore: e.CORRECTIONS_STORE ?? (e.NODE_ENV === "production" ? "twitch" : "local"),
    clientIpHeader: e.CLIENT_IP_HEADER ? e.CLIENT_IP_HEADER.toLowerCase() : undefined,
  };
}
