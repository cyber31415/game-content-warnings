import {
  DddErrorSchema,
  DddItemDetailSchema,
  DddSearchResponseSchema,
  DddTopicCategorySchema,
  DddTopicSchema,
  DddTopicSuperCategorySchema,
  type DddItemDetail,
  type DddItemSummary,
} from "./schema.ts";

type FetchFn = typeof fetch;

/** DDD blocks generic client User-Agents (curl, node, axios...) with HTTP 403. */
export const DDD_USER_AGENT = "TwitchContentWarningsEBS/0.1 (Twitch extension backend)";

export class DddError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;
  constructor(message: string, opts: { code: string; status: number; retryAfterSeconds?: number }) {
    super(message);
    this.code = opts.code;
    this.status = opts.status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

/**
 * Client-side limiter: a minimum spacing between requests (to stay under the
 * per-minute tier limit) plus a circuit that opens after a 429 until Retry-After.
 */
class Limiter {
  private nextSlot = 0;
  private blockedUntil = 0;
  private readonly spacingMs: number;
  private readonly now: () => number;

  constructor(perMinute: number, now: () => number) {
    this.spacingMs = Math.ceil(60_000 / perMinute);
    this.now = now;
  }

  /** Reserves a slot; returns how long the caller must wait, or throws if blocked. */
  reserve(maxWaitMs: number): number {
    const now = this.now();
    if (now < this.blockedUntil) {
      throw new DddError("DDD rate limit in effect", { code: "rate_limited_local", status: 429, retryAfterSeconds: Math.ceil((this.blockedUntil - now) / 1000) });
    }
    const slot = Math.max(now, this.nextSlot);
    const wait = slot - now;
    if (wait > maxWaitMs) throw new DddError("DDD request queue full", { code: "queue_full", status: 429 });
    this.nextSlot = slot + this.spacingMs;
    return wait;
  }

  block(seconds: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + seconds * 1000);
  }
}

export type DddBudget = { remainingMinute: number | null; remainingMonth: number | null; limitMonth: number | null };

export class DddClient {
  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly fetchFn: FetchFn;
  private readonly limiter: Limiter;
  private readonly maxQueueWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Last rate-limit headers seen; lets health checks / logs watch the monthly quota. */
  budget: DddBudget = { remainingMinute: null, remainingMonth: null, limitMonth: null };

  constructor(opts: {
    apiKey: string;
    apiBase: string;
    fetchFn?: FetchFn;
    perMinute?: number;
    maxQueueWaitMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.apiKey = opts.apiKey;
    this.apiBase = opts.apiBase;
    this.fetchFn = opts.fetchFn ?? fetch;
    // Free tier allows 30/min; leave headroom for the fixture/audit scripts.
    this.limiter = new Limiter(opts.perMinute ?? 20, opts.now ?? Date.now);
    this.maxQueueWaitMs = opts.maxQueueWaitMs ?? 15_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async search(query: string): Promise<DddItemSummary[]> {
    return DddSearchResponseSchema.parse(await this.getRaw(`/api/v3/items?q=${encodeURIComponent(query)}`));
  }

  async getItem(itemId: number): Promise<DddItemDetail> {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) throw new RangeError("itemId must be a positive integer");
    return DddItemDetailSchema.parse(await this.getRaw(`/api/v3/items/${itemId}`));
  }

  /** Topic catalogue: ~290 topics, their categories and the 11 broad "super" categories. */
  async getTopicCatalog() {
    const topics = DddTopicSchema.array().parse(await this.getRaw("/api/v3/topics"));
    const categories = DddTopicCategorySchema.array().parse(await this.getRaw("/api/v3/topiccategories"));
    const superCategories = DddTopicSuperCategorySchema.array().parse(await this.getRaw("/api/v3/topicsupercategories"));
    return { topics, categories, superCategories };
  }

  /** Rate-limited GET returning unvalidated JSON (also used by fixture capture scripts). */
  async getRaw(path: string): Promise<unknown> {
    const wait = this.limiter.reserve(this.maxQueueWaitMs);
    if (wait > 0) await this.sleep(wait);

    const res = await this.fetchFn(`${this.apiBase}${path}`, {
      headers: { "X-API-KEY": this.apiKey, Accept: "application/json", "User-Agent": DDD_USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    this.readBudget(res.headers);

    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      if (res.status === 429) this.limiter.block(retryAfter ?? 60);
      const body = DddErrorSchema.safeParse(await res.json().catch(() => null));
      const code = body.success ? body.data.error : `http_${res.status}`;
      throw new DddError(`DDD ${path.split("?")[0]} failed: ${code}`, { code, status: res.status, retryAfterSeconds: retryAfter });
    }
    return res.json();
  }

  private readBudget(h: Headers): void {
    const num = (name: string) => {
      const v = h.get(name);
      return v === null || v === "" ? null : Number(v);
    };
    this.budget = {
      remainingMinute: num("x-ratelimit-remaining-minute") ?? this.budget.remainingMinute,
      remainingMonth: num("x-ratelimit-remaining-month") ?? this.budget.remainingMonth,
      limitMonth: num("x-ratelimit-limit-month") ?? this.budget.limitMonth,
    };
  }
}
