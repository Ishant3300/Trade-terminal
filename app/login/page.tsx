"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/app/actions";
import "@/components/terminal/terminal.css";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await login(username, password);
    if (!res.ok) {
      setBusy(false);
      setError(res.error);
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
        <form className="tt-card" style={{ width: 280 }} onSubmit={submit}>
          <div className="tt-card-h">Login</div>
          <div className="tt-card-b" style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12 }}>
            <label className="tt-field">
              <span className="tt-label">User ID</span>
              <input className="tt-input" autoComplete="username" autoFocus required spellCheck={false}
                value={username} onChange={(e) => setUsername(e.target.value)} />
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
