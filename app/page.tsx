import type { Metadata } from "next";
import { TerminalLoader } from "@/components/terminal/terminal-loader";

export const metadata: Metadata = {
  title: "Trade Terminal",
};

export default function TerminalPage() {
  return <TerminalLoader />;
}
