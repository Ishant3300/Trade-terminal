import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trade Terminal",
  description: "Jobbing back-office trading terminal",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
