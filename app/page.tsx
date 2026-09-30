import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { TerminalLoader } from "@/components/terminal/terminal-loader";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { requestIp } from "@/lib/request-ip";

export const metadata: Metadata = {
  title: "Trade Terminal",
};

export default async function TerminalPage() {
  const user = verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return <TerminalLoader user={user} ip={await requestIp()} />;
}
