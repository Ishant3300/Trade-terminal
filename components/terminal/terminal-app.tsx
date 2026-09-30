"use client";

import { useEffect, useState } from "react";
import { AccountMaster } from "./account-master";
import { BrokerageMaster } from "./brokerage-master";
import { Reports } from "./reports";
import { useTerminalStore } from "./store";
import { TradeBook } from "./trade-book";
import { TradeEntry } from "./trade-entry";
import { logout } from "@/app/actions";
import "./terminal.css";

const TABS = [
  { id: "entry", label: "Trade Entry" },
  { id: "book", label: "Trade Book" },
  { id: "brokerage", label: "Brokerage Master" },
  { id: "account", label: "Account Master" },
  { id: "reports", label: "Reports" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const d = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const t = now.toLocaleTimeString("en-GB", { hour12: false });
  return <span>{d} &nbsp;<b style={{ color: "#fff", fontFamily: "Consolas, monospace" }}>{t}</b></span>;
}

export default function TerminalApp({ user, ip }: { user: string; ip: string }) {
  const [tab, setTab] = useState<TabId>("entry");
  const { data, error, actions, calcs } = useTerminalStore();

  return (
    <div className="tt">
      <nav className="tt-nav">
        <div className="tt-brand">
          <span className="tt-brand-mark">TT</span> Trade Terminal <span style={{ fontWeight: 400, color: "#8d96a5", fontSize: 12 }}>Jobbing BO</span>
        </div>
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`tt-menu${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        <div className="tt-nav-right">
          <Clock />
          <span title="Your IP address"><i className="tt-dot" /> IP: {ip || "—"}</span>
          <span><span className="tt-avatar">{(user[0] ?? "?").toUpperCase()}</span> {user}</span>
          <form action={logout} style={{ padding: 0, border: 0 }}>
            <button type="submit" className="tt-menu" style={{ height: "100%", fontSize: 12 }}>Log out</button>
          </form>
        </div>
      </nav>

      {error && (
        <div className="tt-status" style={{ background: "#fde8e7" }}>
          <span className="bad">Database error: {error}</span>
          <button type="button" className="tt-btn tt-btn-xs" style={{ marginLeft: "auto", alignSelf: "center" }} onClick={() => location.reload()}>Reload</button>
        </div>
      )}
      {!data ? (
        !error && <div className="tt-page tt-muted" style={{ fontSize: 13 }}>Loading data…</div>
      ) : (
        <>
          {tab === "entry" && <TradeEntry data={data} actions={actions} calcs={calcs} />}
          {tab === "book" && <TradeBook data={data} calcs={calcs} />}
          {tab === "brokerage" && <BrokerageMaster data={data} actions={actions} />}
          {tab === "account" && <AccountMaster data={data} actions={actions} />}
          {tab === "reports" && <Reports data={data} calcs={calcs} />}
        </>
      )}
    </div>
  );
}
