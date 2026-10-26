import type { Request } from "express";

/**
 * 요청자의 주소. 속도 제한과 관리자 IP 제한이 같은 값을 써야 한다.
 *
 * Express 의 trust proxy 설정을 따른다. 설정이 없으면 req.ip 가 TCP 상대 주소와 같으므로
 * 직접 연결 환경의 동작이 그대로 유지되고, 설정이 있으면 신뢰 구간을 제외한 바깥쪽 주소를 준다.
 * IPv4 를 IPv6 로 감싼 표기(::ffff:)는 벗겨 양쪽 환경에서 같은 키가 나오게 한다.
 */
export const clientIp = (req: Request) =>
  (req.ip ?? req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/i, "");
