import { afterEach, describe, expect, it, vi } from "vitest";

// Load Balancer 뒤에서는 TCP 상대가 항상 LB 다. 그 주소로 속도 제한을 걸면 모든 사용자가
// 한 덩어리가 되어 함께 429 를 맞고, 관리자 IP 제한도 의미를 잃는다.
// 반대로 X-Forwarded-For 를 무조건 믿으면 헤더를 넣어 제한을 우회할 수 있다.
// 그래서 "어디까지 믿을지"를 TRUST_PROXY 로 명시하게 했고, 그 규칙을 여기서 고정한다.

const loadConfig = async () => {
  vi.resetModules();
  return (await import("../src/config.js")).config;
};

const withEnv = async (value: string | undefined, run: () => Promise<void>) => {
  const previous = process.env.TRUST_PROXY;
  if (value === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  }
};

afterEach(() => { vi.resetModules(); });

describe("TRUST_PROXY 설정", () => {
  it("값이 없으면 프록시를 믿지 않는다", async () => {
    await withEnv(undefined, async () => {
      expect((await loadConfig()).trustProxy).toBe(false);
    });
  });

  it("빈 값과 false 도 믿지 않음으로 본다", async () => {
    for (const value of ["", "   ", "false", "FALSE"]) {
      await withEnv(value, async () => {
        expect((await loadConfig()).trustProxy).toBe(false);
      });
    }
  });

  it("true 는 거부한다", async () => {
    // 아무나 보낸 X-Forwarded-For 를 믿겠다는 뜻이라 제한을 우회할 수 있다.
    await withEnv("true", async () => {
      await expect(loadConfig()).rejects.toThrow(/TRUST_PROXY/);
    });
  });

  it("홉 수는 숫자로 읽는다", async () => {
    await withEnv("1", async () => {
      expect((await loadConfig()).trustProxy).toBe(1);
    });
  });

  it("대역 목록은 그대로 전달한다", async () => {
    await withEnv("10.0.0.0/8, 172.16.0.0/12", async () => {
      expect((await loadConfig()).trustProxy).toBe("10.0.0.0/8, 172.16.0.0/12");
    });
  });
});

describe("요청자 주소", () => {
  it("신뢰 설정이 없으면 전달된 헤더를 무시한다", async () => {
    await withEnv(undefined, async () => {
      const { app } = await import("../src/app.js");
      const { clientIp } = await import("../src/lib/clientIp.js");

      // trust proxy 를 켜지 않았으므로 Express 는 req.ip 로 TCP 상대 주소를 준다.
      expect(app.get("trust proxy")).toBeFalsy();
      const fake = { ip: "127.0.0.1", socket: { remoteAddress: "::ffff:127.0.0.1" } };
      expect(clientIp(fake as never)).toBe("127.0.0.1");
    });
  });

  it("IPv6 로 감싼 IPv4 표기를 벗긴다", async () => {
    const { clientIp } = await import("../src/lib/clientIp.js");
    // 같은 주소가 환경에 따라 다른 키로 집계되면 제한이 두 배로 느슨해진다.
    expect(clientIp({ ip: "::ffff:203.0.113.9", socket: {} } as never)).toBe("203.0.113.9");
  });

  it("주소를 알 수 없으면 unknown 으로 모은다", async () => {
    const { clientIp } = await import("../src/lib/clientIp.js");
    expect(clientIp({ socket: {} } as never)).toBe("unknown");
  });
});
