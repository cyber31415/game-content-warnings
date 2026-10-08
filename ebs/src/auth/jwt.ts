import { jwtVerify, SignJWT, errors as joseErrors } from "jose";
import { z } from "zod";

// Payload of the JWT that Twitch hands the extension frontend via
// window.Twitch.ext.onAuthorized. Signed HS256 with the base64-decoded extension secret.
const ExtensionTokenSchema = z.object({
  channel_id: z.string().regex(/^\d+$/),
  opaque_user_id: z.string(),
  role: z.enum(["broadcaster", "moderator", "viewer", "external"]),
  user_id: z.string().optional(),
  is_unlinked: z.boolean().optional(),
  exp: z.number(),
});

export type ExtensionToken = z.infer<typeof ExtensionTokenSchema>;

export class AuthError extends Error {}

export async function verifyExtensionJwt(token: string, secret: Uint8Array): Promise<ExtensionToken> {
  let payload: unknown;
  try {
    // Pin the algorithm: never let the token choose (blocks alg=none / alg confusion).
    ({ payload } = await jwtVerify(token, secret, { algorithms: ["HS256"], requiredClaims: ["exp"] }));
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new AuthError("token expired");
    throw new AuthError("invalid token");
  }
  const parsed = ExtensionTokenSchema.safeParse(payload);
  if (!parsed.success) throw new AuthError("unexpected token claims");
  return parsed.data;
}

/** Pulls the token from `Authorization: Bearer <jwt>` or the `x-extension-jwt` header. */
export function extractToken(headers: Record<string, string | string[] | undefined>): string | undefined {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const custom = headers["x-extension-jwt"];
  if (typeof custom === "string" && custom.length > 0) return custom;
  return undefined;
}

/**
 * JWT the EBS signs itself to call extension-specific Helix endpoints
 * (Extension PubSub, configuration segments). Short-lived by design.
 */
export async function signEbsJwt(
  secret: Uint8Array,
  opts: { ownerId: string; channelId?: string; pubsubSend?: string[]; ttlSeconds?: number },
): Promise<string> {
  const claims: Record<string, unknown> = { user_id: opts.ownerId, role: "external" };
  if (opts.channelId) claims.channel_id = opts.channelId;
  if (opts.pubsubSend) claims.pubsub_perms = { send: opts.pubsubSend };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 120))
    .sign(secret);
}
