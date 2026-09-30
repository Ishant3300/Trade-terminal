"use client";

import dynamic from "next/dynamic";

// Client-only: state lives in localStorage and the UI is clock driven.
const TerminalApp = dynamic(() => import("./terminal-app"), {
  ssr: false,
  loading: () => <div style={{ padding: 12, font: "11px Segoe UI, Tahoma, Arial" }}>Loading terminal…</div>,
});

export function TerminalLoader() {
  return <TerminalApp />;
}
