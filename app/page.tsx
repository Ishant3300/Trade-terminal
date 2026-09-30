import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { signOut } from "@/app/actions";
import { TerminalLoader } from "@/components/terminal/terminal-loader";
import { requestIp } from "@/lib/request-ip";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Trade Terminal",
};

export default async function TerminalPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("display_name, active").eq("id", user.id).maybeSingle();
  if (!profile?.active) {
    return (
      <main style={{ padding: 24, font: "13px Segoe UI, Tahoma, Arial", color: "#1c2430" }}>
        <p><b>{user.email}</b> is signed in but not activated for Trade Terminal.</p>
        <p style={{ color: "#6b7686" }}>Ask the administrator to activate your login.</p>
        <form action={signOut}><button type="submit" style={{ marginTop: 8 }}>Log out</button></form>
      </main>
    );
  }

  return <TerminalLoader user={profile.display_name} ip={await requestIp()} />;
}
