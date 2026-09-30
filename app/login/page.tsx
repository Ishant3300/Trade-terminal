"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import "@/components/terminal/terminal.css";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await createClient().auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setBusy(false);
      setError(error.message === "Invalid login credentials" ? "Wrong email or password" : error.message);
      return;
    }
    router.replace("/");
    router.refresh();
  };

  return (
    <div className="tt">
      <nav className="tt-nav">
        <div className="tt-brand">
          <span className="tt-brand-mark">TT</span> Trade Terminal <span style={{ fontWeight: 400, color: "#8d96a5", fontSize: 11 }}>Jobbing BO</span>
        </div>
      </nav>
      <div style={{ display: "flex", justifyContent: "center", paddingTop: 80 }}>
        <form className="tt-card" style={{ width: 300 }} onSubmit={submit}>
          <div className="tt-card-h">Login</div>
          <div className="tt-card-b" style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12 }}>
            <label className="tt-field">
              <span className="tt-label">Email</span>
              <input className="tt-input" type="email" autoComplete="username" autoFocus required
                value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="tt-field">
              <span className="tt-label">Password</span>
              <input className="tt-input" type="password" autoComplete="current-password" required
                value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button type="submit" className="tt-btn tt-btn-blue" disabled={busy} style={{ marginTop: 4 }}>
              {busy ? "Signing in…" : "Login"}
            </button>
          </div>
          {error && <div className="tt-status"><span className="bad">{error}</span></div>}
        </form>
      </div>
    </div>
  );
}
