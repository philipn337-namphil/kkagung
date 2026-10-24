import "dotenv/config";
import type { SignOptions } from "jsonwebtoken";

const jwtSecret = process.env.JWT_SECRET;
const knownDevelopmentSecrets = new Set([
  "change_me_to_a_long_random_value",
  "local_development_secret_change_before_production",
]);
if (!jwtSecret || jwtSecret !== jwtSecret.trim() || Buffer.byteLength(jwtSecret, "utf8") < 32 || knownDevelopmentSecrets.has(jwtSecret)) {
  throw new Error("JWT_SECRET must be a private random value of at least 32 UTF-8 bytes, without surrounding whitespace.");
}

const jwtExpiresIn = process.env.JWT_EXPIRES_IN ?? (process.env.NODE_ENV === "production" ? "900s" : "12h");
// Require explicit units: jsonwebtoken interprets a unitless string as milliseconds.
const duration = /^([1-9]\d*)(s|m|h|d)$/.exec(jwtExpiresIn);
const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
if (!duration || duration[0].length !== jwtExpiresIn.length || !Number.isSafeInteger(Number(duration[1]) * units[duration[2]])) {
  throw new Error("JWT_EXPIRES_IN must be a positive whole duration with s, m, h or d units.");
}
const jwtIssuer = process.env.AUTH_JWT_ISSUER ?? "kkagung-api";
const jwtAudience = process.env.AUTH_JWT_AUDIENCE ?? "kkagung-client";
if (!jwtIssuer.trim() || !jwtAudience.trim()) throw new Error("JWT issuer and audience must not be empty.");
if (process.env.AUTH_JWT_ALGORITHM && process.env.AUTH_JWT_ALGORITHM !== "HS256") {
  throw new Error("Only the HS256 JWT algorithm is supported.");
}

export const config = {
  port: Number(process.env.APP_PORT ?? 8080),
  jwtSecret,
  jwtExpiresIn: jwtExpiresIn as NonNullable<SignOptions["expiresIn"]>,
  jwtAlgorithm: "HS256" as const,
  jwtIssuer,
  jwtAudience,
  corsOrigin: process.env.FRONTEND_URL ?? "http://localhost:3000",
};
