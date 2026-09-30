"use client";

import dynamic from "next/dynamic";

// Client-only: the terminal is clock driven and loads its data in the browser.
const TerminalApp = dynamic(() => import("./terminal-app"), {
  ssr: false,
  loading: () => <div style={{ padding: 12, font: "11px Segoe UI, Tahoma, Arial" }}>Loading terminal…</div>,
});

export function TerminalLoader({ user, ip }: { user: string; ip: string }) {
  return <TerminalApp user={user} ip={ip} />;
}
