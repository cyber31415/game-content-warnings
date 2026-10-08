import type { FastifyInstance } from "fastify";
import {
  ChannelUpdateNotificationSchema,
  ReplayGuard,
  RevocationSchema,
  VerificationSchema,
  verifyEventSub,
} from "../twitch/eventsub.ts";
import type { LiveUpdates } from "../live.ts";

/** Twitch EventSub webhook receiver (POST /eventsub). Needs the raw body for the HMAC. */
export function eventsubRoutes(deps: { secret: string; live: LiveUpdates }) {
  const replay = new ReplayGuard();

  return async (app: FastifyInstance) => {
    app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 64 * 1024 }, (_req, body, done) =>
      done(null, body),
    );

    app.post("/eventsub", async (request, reply) => {
      const raw = typeof request.body === "string" ? request.body : "";
      const check = verifyEventSub(deps.secret, request.headers, raw);
      if (!check.ok) return reply.code(403).send({ error: check.reason });

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: "invalid json" });
      }

      switch (check.messageType) {
        case "webhook_callback_verification": {
          const v = VerificationSchema.safeParse(json);
          if (!v.success) return reply.code(400).send();
          return reply.type("text/plain").send(v.data.challenge);
        }
        case "notification": {
          if (!replay.firstTime(check.messageId)) return reply.code(204).send();
          const n = ChannelUpdateNotificationSchema.safeParse(json);
          if (n.success) {
            const e = n.data.event;
            // Acknowledge fast; Twitch expects a 2xx within a few seconds.
            void deps.live.onCategoryChange(e.broadcaster_user_id, { id: e.category_id, name: e.category_name });
          }
          return reply.code(204).send();
        }
        case "revocation": {
          const r = RevocationSchema.safeParse(json);
          if (r.success) deps.live.onRevoked(r.data.subscription.id, r.data.subscription.condition.broadcaster_user_id);
          return reply.code(204).send();
        }
        default:
          return reply.code(204).send();
      }
    });
  };
}
