import type { FastifyInstance } from "fastify";
import type { DddClient } from "../ddd/client.ts";

export function healthRoutes(deps: { ddd: DddClient }) {
  return async (app: FastifyInstance) => {
    // DDD quota is included so uptime monitors can alert before the monthly limit runs out.
    app.get("/health", async () => ({ ok: true, uptimeSeconds: Math.round(process.uptime()), dddQuota: deps.ddd.budget }));
  };
}
