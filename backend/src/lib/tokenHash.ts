import { createHash } from "node:crypto";

// Store only a digest, never a bearer token or signed photo URL.
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
