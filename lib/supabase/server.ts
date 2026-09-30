import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

// Server-only database client using the secret key. The browser never talks
// to Supabase directly; RLS (no policies) blocks every other key.
let client: SupabaseClient | undefined;

export function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set");
  client ??= createSupabaseClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
