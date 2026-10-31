import { z } from "zod";

// Minimal client for Turso's libSQL HTTP API (POST /v2/pipeline, https://docs.turso.tech/sdk/http/reference).
// One endpoint, so no SDK: statements go out as typed values and responses are validated with zod.

export type SqlValue = string | number | null;
export type Statement = { sql: string; args?: SqlValue[] };
export type Row = Record<string, SqlValue>;
export type ExecuteResult = { rows: Row[]; affected: number };

const ValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("null") }),
  z.object({ type: z.literal("integer"), value: z.string() }),
  z.object({ type: z.literal("float"), value: z.number() }),
  z.object({ type: z.literal("text"), value: z.string() }),
  z.object({ type: z.literal("blob"), base64: z.string() }),
]);
const ExecuteSchema = z.object({
  cols: z.array(z.object({ name: z.string().nullable() })),
  rows: z.array(z.array(ValueSchema)),
  affected_row_count: z.number(),
});
const PipelineSchema = z.object({
  results: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("ok"), response: z.object({ type: z.string(), result: ExecuteSchema.optional() }) }),
      z.object({ type: z.literal("error"), error: z.object({ message: z.string(), code: z.string().optional() }) }),
    ]),
  ),
});

export class TursoError extends Error {}

type FetchFn = typeof fetch;

export class TursoClient {
  private readonly endpoint: string;
  private readonly authToken: string | undefined;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(opts: { url: string; authToken?: string; fetchFn?: FetchFn; timeoutMs?: number }) {
    // Turso shows libsql:// URLs; the HTTP API is the same host over https.
    this.endpoint = `${opts.url.replace(/^(libsql|turso):\/\//, "https://").replace(/\/$/, "")}/v2/pipeline`;
    this.authToken = opts.authToken;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async execute(stmt: Statement): Promise<ExecuteResult> {
    return (await this.batch([stmt]))[0]!;
  }

  /** Runs the statements in order in one request. Throws if any of them failed. */
  async batch(stmts: Statement[]): Promise<ExecuteResult[]> {
    if (stmts.length === 0) return [];
    const res = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.authToken && { Authorization: `Bearer ${this.authToken}` }) },
      body: JSON.stringify({
        requests: [...stmts.map((s) => ({ type: "execute", stmt: { sql: s.sql, args: (s.args ?? []).map(encode) } })), { type: "close" }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // Never include the response body or token in errors: logs must not carry credentials.
    if (!res.ok) throw new TursoError(`Turso request failed: HTTP ${res.status}`);
    const { results } = PipelineSchema.parse(await res.json());
    return stmts.map((_, i) => {
      const r = results[i];
      if (!r) throw new TursoError("Turso response is missing results");
      if (r.type === "error") throw new TursoError(`Turso statement failed: ${r.error.code ?? r.error.message}`);
      const result = r.response.result;
      if (!result) throw new TursoError("Turso response has no execute result");
      const names = result.cols.map((c, j) => c.name ?? `col${j}`);
      return {
        rows: result.rows.map((row) => Object.fromEntries(row.map((v, j) => [names[j]!, decode(v)]))),
        affected: result.affected_row_count,
      };
    });
  }
}

function encode(v: SqlValue) {
  if (v === null) return { type: "null" };
  if (typeof v === "string") return { type: "text", value: v };
  // Integers travel as strings so large values keep their precision.
  return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
}

function decode(v: z.infer<typeof ValueSchema>): SqlValue {
  switch (v.type) {
    case "null":
      return null;
    case "integer":
      return Number(v.value);
    case "float":
      return v.value;
    case "text":
      return v.value;
    case "blob":
      return v.base64;
  }
}
