import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

// 액세스 토큰 발급은 이 함수 하나만 쓴다.
// requireAuth 가 issuer·audience·jti 를 필수로 검증하므로, 발급 경로가 나뉘면
// 한쪽만 클레임을 빠뜨려도 그 토큰은 전부 401 이 된다.
export const issueAccessToken = (user: { id: bigint; role: "USER" | "ADMIN" }) => jwt.sign(
  { role: user.role }, config.jwtSecret,
  { subject: user.id.toString(), algorithm: config.jwtAlgorithm, expiresIn: config.jwtExpiresIn,
    issuer: config.jwtIssuer, audience: config.jwtAudience, jwtid: randomUUID() },
);
