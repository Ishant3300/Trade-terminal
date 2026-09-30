import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Single admin login. Credentials and the cookie-signing secret come from
// environment variables (ADMIN_USERNAME, ADMIN_PASSWORD, SESSION_SECRET), so
// they can be changed in Vercel without touching code. Server-only.

export const SESSION_COOKIE = "tt_session";
export const SESSION_HOURS = 12;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (32+ characters)");
  return s;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

/** Compares via SHA-256 digests so length differences don't leak timing. */
function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

export function checkCredentials(username: string, password: string): boolean {
  const u = process.env.ADMIN_USERNAME;
  const p = process.env.ADMIN_PASSWORD;
  if (!u || !p) return false;
  // Evaluate both so a wrong username takes as long as a wrong password.
  const okUser = safeEqual(username.trim().toLowerCase(), u.toLowerCase());
  const okPass = safeEqual(password, p);
  return okUser && okPass;
}

/** Token: "<username>.<expiresEpochMs>.<hmac>" */
export function createSessionToken(username: string): string {
  const payload = `${encodeURIComponent(username)}.${Date.now() + SESSION_HOURS * 3600_000}`;
  return `${payload}.${sign(payload)}`;
}

/** Returns the username for a valid, unexpired token, else null. */
export function verifySessionToken(token: string | undefined): string | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const payload = token.slice(0, i);
  if (!safeEqual(token.slice(i + 1), sign(payload))) return null;
  const [user, exp] = payload.split(".");
  if (!(Number(exp) > Date.now())) return null;
  return decodeURIComponent(user);
}
