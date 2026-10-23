import "dotenv/config";

export const config = {
  port: Number(process.env.APP_PORT ?? 8080),
  jwtSecret: process.env.JWT_SECRET ?? "change_me_to_a_long_random_value",
  corsOrigin: process.env.FRONTEND_URL ?? "http://localhost:3000",
};

if (config.jwtSecret === "change_me_to_a_long_random_value" && process.env.NODE_ENV === "production") {
  throw new Error("JWT_SECRET must be set in production.");
}
