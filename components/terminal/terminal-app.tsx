"use client";

import { useEffect, useState } from "react";
import { TERMINAL_IP, TERMINAL_USER } from "@/lib/terminal/seed";
import { AccountMaster } from "./account-master";
import { BrokerageMaster } from "./brokerage-master";
import { Reports } from "./reports";
import { useTerminalStore } from "./store";
import { TradeBook } from "./trade-book";
import { TradeEntry } from "./trade-entry";
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

export default function TerminalApp() {
  const [tab, setTab] = useState<TabId>("entry");
  const { data, dispatch, calcs } = useTerminalStore();

  return (
    <div className="tt">
      <nav className="tt-nav">
        <div className="tt-brand">
          <span className="tt-brand-mark">TT</span> Trade Terminal <span style={{ fontWeight: 400, color: "#8d96a5", fontSize: 11 }}>Jobbing BO</span>
        </div>
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`tt-menu${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        <div className="tt-nav-right">
          <Clock />
          <span title="Terminal IP"><i className="tt-dot" /> IP: {TERMINAL_IP}</span>
          <button type="button" className="tt-menu" style={{ border: 0, fontSize: 11 }}
            onClick={() => confirm("Delete ALL accounts, brokerage slabs and trades? This cannot be undone.") && dispatch({ type: "reset" })}>
            Clear All Data
          </button>
          <span><span className="tt-avatar">{TERMINAL_USER[0]}</span> {TERMINAL_USER}</span>
        </div>
      </nav>

      {tab === "entry" && <TradeEntry data={data} dispatch={dispatch} calcs={calcs} />}
      {tab === "book" && <TradeBook data={data} calcs={calcs} />}
      {tab === "brokerage" && <BrokerageMaster data={data} dispatch={dispatch} />}
      {tab === "account" && <AccountMaster data={data} dispatch={dispatch} />}
      {tab === "reports" && <Reports data={data} calcs={calcs} />}
    </div>
  );
}
