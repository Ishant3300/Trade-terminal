import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { diagnoseFeed } from "@/lib/angel";
import "@/components/terminal/terminal.css";

export const metadata: Metadata = { title: "Feed status — Trade Terminal" };

/** Live-feed diagnostics: open /feed-status on the deployed site. */
export default async function FeedStatusPage() {
  if (!verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value)) redirect("/login");
  const checks = await diagnoseFeed();
  const allOk = checks.every((c) => c.ok);

  return (
    <div className="tt">
      <div className="tt-page" style={{ maxWidth: 760 }}>
        <div className="tt-card">
          <div className="tt-card-h">
            Angel One live feed check
            <span className={allOk ? "pos" : "neg"} style={{ marginLeft: "auto" }}>{allOk ? "ALL OK" : "PROBLEM FOUND"}</span>
          </div>
          <table className="tt-grid">
            <thead>
              <tr><th style={{ width: 130 }}>Step</th><th style={{ width: 60 }}>Result</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.step}>
                  <td>{c.step}</td>
                  <td className={c.ok ? "pos" : "neg"} style={{ fontWeight: 700 }}>{c.ok ? "OK" : "FAIL"}</td>
                  <td style={{ whiteSpace: "normal" }}>{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="tt-status"><Link href="/">← Back to terminal</Link><span style={{ marginLeft: "auto" }}>Reload this page to run the check again</span></div>
        </div>
      </div>
    </div>
  );
}
