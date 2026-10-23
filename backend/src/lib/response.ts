import type { Response } from "express";
export const jsonSafe = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));
export const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data: jsonSafe(data), error: null });
export const fail = (res: Response, status: number, code: string, message: string) => res.status(status).json({ success: false, data: null, error: { code, message } });
