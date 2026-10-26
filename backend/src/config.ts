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

const production = process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
const jwtExpiresIn = process.env.JWT_EXPIRES_IN ?? (production ? "900s" : "12h");
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

// Load Balancer 뒤에서는 TCP 상대가 항상 LB 다. 그 주소를 그대로 쓰면 속도 제한이
// 모든 사용자를 한 덩어리로 묶고, 관리자 IP 제한도 의미를 잃는다.
// 그렇다고 X-Forwarded-For 를 무조건 믿으면 헤더를 넣어 제한을 우회할 수 있다.
// 그래서 "어디까지 믿을지"를 배포 환경이 명시하게 한다. 값이 없으면 믿지 않는다(현재 동작 유지).
const parseTrustProxy = () => {
  const raw = (process.env.TRUST_PROXY ?? "").trim();
  if (raw === "" || raw.toLowerCase() === "false") return false;
  // 아무나 보낸 헤더를 믿겠다는 뜻이라 허용하지 않는다. 대역이나 홉 수로 적어야 한다.
  if (raw.toLowerCase() === "true") {
    throw new Error("TRUST_PROXY must name the trusted hops or ranges, not 'true'.");
  }
  if (/^[1-9]\d*$/.test(raw)) return Number(raw);
  return raw;
};
const trustProxy = parseTrustProxy();

export const config = {
  production,
  trustProxy,
  port: Number(process.env.APP_PORT ?? 8080),
  jwtSecret,
  jwtExpiresIn: jwtExpiresIn as NonNullable<SignOptions["expiresIn"]>,
  jwtAlgorithm: "HS256" as const,
  jwtIssuer,
  jwtAudience,
  corsOrigin: process.env.FRONTEND_URL ?? "http://localhost:3000",
};
