"use client";

import { useState, type ReactNode, type Ref } from "react";
import { fmt2 } from "@/lib/terminal/engine";

export function Field({ label, required, children, width }: { label: string; required?: boolean; children: ReactNode; width?: number }) {
  return (
    <label className="tt-field" style={width ? { width } : undefined}>
      <span className="tt-label">
        {label}
        {required && <span className="tt-req">*</span>}
      </span>
      {children}
    </label>
  );
}

export function PnL({ value }: { value: number }) {
  const cls = value > 0.004 ? "pos" : value < -0.004 ? "neg" : "";
  return <span className={cls}>{fmt2(value)}</span>;
}

export interface SuggestOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Keyboard autosuggest. ArrowUp/Down to move, Enter picks the highlighted item
 * (the Enter still bubbles so the entry form can advance focus), Escape closes.
 */
export function Suggest({
  value,
  onChange,
  options,
  inputRef,
  placeholder,
  width,
  invalid,
  allowSign,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SuggestOption[];
  inputRef?: Ref<HTMLInputElement>;
  placeholder?: string;
  width?: number;
  invalid?: boolean;
  /** Let "+" / "-" type into the box instead of acting as Buy/Sell shortcuts. */
  allowSign?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const q = value.trim().toUpperCase();
  // Rank: exact symbol ("NIFTY" → "NIFTY 27OCT2026"), then prefix, then anywhere.
  const rank = (o: SuggestOption) => {
    const v = o.value.toUpperCase();
    return v === q || v.startsWith(q + " ") ? 0 : v.startsWith(q) ? 1 : 2;
  };
  const matches = options
    .filter((o) => !q || o.value.toUpperCase().includes(q) || o.label.toUpperCase().includes(q))
    .map((o, i) => ({ o, i, r: q ? rank(o) : 0 }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, 40)
    .map((m) => m.o);
  const exact = matches.length === 1 && matches[0].value.toUpperCase() === q;
  const showList = open && matches.length > 0 && !exact;
  const active = Math.min(hl, matches.length - 1);

  const pick = (o: SuggestOption) => {
    onChange(o.value);
    setOpen(false);
  };

  return (
    <div className="tt-suggest" style={width ? { width } : undefined}>
      <input
        ref={inputRef}
        className={`tt-input${invalid ? " err" : ""}`}
        style={{ width: "100%" }}
        value={value}
        placeholder={placeholder}
        data-allow-sign={allowSign ? "1" : undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value.toUpperCase());
          setOpen(true);
          setHl(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!showList) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHl((active + 1) % matches.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHl((active - 1 + matches.length) % matches.length);
          } else if (e.key === "Enter") {
            pick(matches[active]);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {showList && (
        <div className="tt-suggest-list">
          {matches.map((o, i) => (
            <div
              key={o.value}
              className={`tt-suggest-item${i === active ? " hl" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
              onMouseEnter={() => setHl(i)}
            >
              <span>{o.label}</span>
              {o.hint && <small>{o.hint}</small>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
