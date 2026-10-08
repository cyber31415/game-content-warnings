import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthError, extractToken, verifyExtensionJwt, type ExtensionToken } from "./jwt.ts";

declare module "fastify" {
  interface FastifyRequest {
    ext: ExtensionToken;
  }
}

/** preHandler that rejects requests without a valid extension JWT and exposes its claims as request.ext. */
export function requireExtensionAuth(secret: Uint8Array) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = extractToken(request.headers);
    if (!token) return reply.code(401).send({ error: "missing token" });
    try {
      request.ext = await verifyExtensionJwt(token, secret);
    } catch (err) {
      if (err instanceof AuthError) return reply.code(401).send({ error: err.message });
      throw err;
    }
  };
}
