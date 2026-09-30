import { headers } from "next/headers";

/** Real client IP as seen by the host (Vercel sets x-forwarded-for). Server-only. */
export async function requestIp(): Promise<string> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip") || "";
  return ip === "::1" || ip === "::ffff:127.0.0.1" ? "127.0.0.1" : ip;
}
