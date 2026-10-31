// Aggregate usage counters per UTC day, to measure real load (no viewer identifiers, ever).
// Counts not yet saved are kept here; CacheMirror adds them to Turso every few minutes.

export const USAGE_FIELDS = [
  "wakeups", // EBS process starts (on the free host: each wake from sleep)
  "viewerRequests", // /api/warnings and /api/topics
  "configRequests", // /api/broadcaster/*
  "preflights", // CORS OPTIONS requests the browser sends before API calls
  "eventsubNotifications", // Twitch EventSub webhook deliveries
  "otherRequests", // /usage, legal pages, anything else
  "healthChecks", // /health: mostly the host's own automatic checks (every few seconds on Render)
  "bytesSent", // response bytes written (headers + body, after compression), excluding /health
  "dddRequests", // HTTP requests to DoesTheDogDie (what its monthly quota counts)
] as const;

export type UsageField = (typeof USAGE_FIELDS)[number];
export type UsageCounts = Record<UsageField, number>;

export const emptyCounts = (): UsageCounts => Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0])) as UsageCounts;

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class UsageStats {
  private pending = new Map<string, UsageCounts>();
  readonly startedAt: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.startedAt = now();
  }

  add(field: UsageField, n = 1): void {
    if (!(n > 0)) return;
    const day = utcDay(this.now());
    let c = this.pending.get(day);
    if (!c) this.pending.set(day, (c = emptyCounts()));
    c[field] += n;
  }

  /** Counts not yet saved, by day. */
  peek(): Map<string, UsageCounts> {
    return new Map([...this.pending].map(([d, c]) => [d, { ...c }]));
  }

  /** Hands over the unsaved counts; give them back with restore() if saving fails. */
  take(): Map<string, UsageCounts> {
    const out = this.pending;
    this.pending = new Map();
    return out;
  }

  restore(taken: Map<string, UsageCounts>): void {
    for (const [day, counts] of taken) {
      let c = this.pending.get(day);
      if (!c) this.pending.set(day, (c = emptyCounts()));
      for (const f of USAGE_FIELDS) c[f] += counts[f];
    }
  }
}

/** Which counter an incoming request belongs to (by method and path only). */
export function requestField(method: string, url: string): UsageField {
  if (method === "OPTIONS") return "preflights";
  const path = url.split("?")[0]!;
  if (path === "/api/warnings" || path === "/api/topics") return "viewerRequests";
  if (path.startsWith("/api/broadcaster/")) return "configRequests";
  if (path === "/eventsub") return "eventsubNotifications";
  if (path === "/health") return "healthChecks";
  return "otherRequests";
}
