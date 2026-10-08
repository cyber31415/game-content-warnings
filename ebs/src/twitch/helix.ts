import { z } from "zod";

type FetchFn = typeof fetch;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string(),
});

/**
 * Manages a Helix app access token (OAuth client-credentials grant).
 * Refreshes shortly before expiry, de-duplicates concurrent refreshes, and can be
 * invalidated when Helix answers 401.
 */
export class AppTokenManager {
  private token: { value: string; expiresAt: number } | undefined;
  private inflight: Promise<string> | undefined;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tokenUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly refreshMarginMs: number;

  constructor(opts: {
    clientId: string;
    clientSecret: string;
    tokenUrl: string;
    fetchFn?: FetchFn;
    now?: () => number;
    refreshMarginMs?: number;
  }) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.tokenUrl = opts.tokenUrl;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.refreshMarginMs = opts.refreshMarginMs ?? 5 * 60_000;
  }

  async getToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - this.refreshMarginMs) return this.token.value;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.token = undefined;
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "client_credentials",
    });
    const res = await this.fetchFn(this.tokenUrl, {
      method: "POST",
      // Explicit type: Node appends ";charset=UTF-8" otherwise, which the Twitch CLI mock rejects.
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Twitch token request failed: HTTP ${res.status}`);
    const data = TokenResponseSchema.parse(await res.json());
    this.token = { value: data.access_token, expiresAt: this.now() + data.expires_in * 1000 };
    return data.access_token;
  }
}

const ChannelSchema = z.object({
  broadcaster_id: z.string(),
  broadcaster_name: z.string(),
  game_id: z.string(),
  game_name: z.string(),
});
const GameSchema = z.object({
  id: z.string(),
  name: z.string(),
  igdb_id: z.string().optional().default(""),
});
const dataOf = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item) });

export type HelixChannel = z.infer<typeof ChannelSchema>;
export type HelixGame = z.infer<typeof GameSchema>;

export class HelixClient {
  private readonly clientId: string;
  private readonly apiBase: string;
  private readonly tokens: AppTokenManager;
  private readonly fetchFn: FetchFn;

  constructor(opts: { clientId: string; apiBase: string; tokens: AppTokenManager; fetchFn?: FetchFn }) {
    this.clientId = opts.clientId;
    this.apiBase = opts.apiBase;
    this.tokens = opts.tokens;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** Current category of a channel (also set while offline: it's the last category used). */
  async getChannel(broadcasterId: string): Promise<HelixChannel | undefined> {
    const json = await this.get(`/channels?broadcaster_id=${encodeURIComponent(broadcasterId)}`);
    return dataOf(ChannelSchema).parse(json).data[0];
  }

  /** Most-viewed categories right now (for the match audit). Pages of up to 100. */
  async getTopGames(total: number): Promise<HelixGame[]> {
    const out: HelixGame[] = [];
    let cursor = "";
    while (out.length < total) {
      const json = await this.get(`/games/top?first=${Math.min(100, total - out.length)}${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`);
      const page = dataOf(GameSchema).extend({ pagination: z.object({ cursor: z.string().optional() }).optional() }).parse(json);
      out.push(...page.data);
      cursor = page.pagination?.cursor ?? "";
      if (!cursor || page.data.length === 0) break;
    }
    return out;
  }

  async getGame(gameId: string): Promise<HelixGame | undefined> {
    const json = await this.get(`/games?id=${encodeURIComponent(gameId)}`);
    return dataOf(GameSchema).parse(json).data[0];
  }

  /**
   * Subscribes to channel.update (category/title changes) via webhook. Requires an
   * app access token. Returns the subscription id; on 409 (already subscribed) looks it up.
   */
  async subscribeChannelUpdate(broadcasterId: string, callback: string, secret: string): Promise<string> {
    const res = await this.send("POST", "/eventsub/subscriptions", {
      type: "channel.update",
      version: "2",
      condition: { broadcaster_user_id: broadcasterId },
      transport: { method: "webhook", callback, secret },
    });
    if (res.status === 409) {
      const existing = await this.findSubscription(broadcasterId);
      if (existing) return existing;
    }
    if (!res.ok) throw new Error(`Helix create EventSub subscription failed: HTTP ${res.status}`);
    return dataOf(z.object({ id: z.string() })).parse(await res.json()).data[0]!.id;
  }

  private async findSubscription(broadcasterId: string): Promise<string | undefined> {
    // Twitch allows only one filter per request: filter by user, then by type here.
    const json = await this.get(`/eventsub/subscriptions?user_id=${encodeURIComponent(broadcasterId)}`);
    const subs = dataOf(z.object({ id: z.string(), type: z.string(), status: z.string() })).parse(json).data;
    return subs.find((s) => s.type === "channel.update" && (s.status === "enabled" || s.status.startsWith("webhook_callback_verification")))?.id;
  }

  async deleteSubscription(id: string): Promise<void> {
    const res = await this.send("DELETE", `/eventsub/subscriptions?id=${encodeURIComponent(id)}`);
    if (!res.ok && res.status !== 404) throw new Error(`Helix delete EventSub subscription failed: HTTP ${res.status}`);
  }

  /**
   * Extension PubSub broadcast to every viewer of a channel's extension.
   * Authenticated with an EBS-signed JWT (role external, pubsub_perms.send broadcast),
   * not the app token. Message must be <= 5 KB.
   */
  async sendExtensionBroadcast(ebsJwt: string, broadcasterId: string, message: string): Promise<void> {
    const res = await this.fetchFn(`${this.apiBase}/extensions/pubsub`, {
      method: "POST",
      headers: { "Client-Id": this.clientId, Authorization: `Bearer ${ebsJwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target: ["broadcast"], broadcaster_id: broadcasterId, is_global_broadcast: false, message }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Helix extension PubSub failed: HTTP ${res.status}`);
  }

  /**
   * Per-channel "developer" configuration segment (Twitch Extension Configuration Service):
   * writable only by the EBS, survives restarts, 5 KB max. Authenticated with an EBS-signed JWT.
   */
  async getDeveloperSegment(ebsJwt: string, broadcasterId: string): Promise<string | undefined> {
    const q = `extension_id=${encodeURIComponent(this.clientId)}&segment=developer&broadcaster_id=${encodeURIComponent(broadcasterId)}`;
    const res = await this.fetchFn(`${this.apiBase}/extensions/configurations?${q}`, {
      headers: { "Client-Id": this.clientId, Authorization: `Bearer ${ebsJwt}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Helix get configuration segment failed: HTTP ${res.status}`);
    const parsed = dataOf(z.object({ content: z.string().optional() })).parse(await res.json());
    return parsed.data[0]?.content;
  }

  async setDeveloperSegment(ebsJwt: string, broadcasterId: string, content: string): Promise<void> {
    const res = await this.fetchFn(`${this.apiBase}/extensions/configurations`, {
      method: "PUT",
      headers: { "Client-Id": this.clientId, Authorization: `Bearer ${ebsJwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ extension_id: this.clientId, segment: "developer", broadcaster_id: broadcasterId, content, version: "1" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Helix set configuration segment failed: HTTP ${res.status}`);
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.send("GET", path);
    if (!res.ok) throw new Error(`Helix GET ${path.split("?")[0]} failed: HTTP ${res.status}`);
    return res.json();
  }

  /** App-token request with one retry on 401 (expired/revoked token). */
  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.getToken();
      const headers: Record<string, string> = { "Client-Id": this.clientId, Authorization: `Bearer ${token}` };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await this.fetchFn(`${this.apiBase}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 && attempt === 0) {
        this.tokens.invalidate();
        continue;
      }
      return res;
    }
  }
}
