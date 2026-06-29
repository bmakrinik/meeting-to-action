import "./globals.css";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata = {
  title: "Meeting to Action",
  description: "Transcribe meetings into summaries and owner-tagged action items.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <h1>Meeting to Action</h1>
          <Link href="/">Dashboard</Link>
          <Link href="/settings">Settings</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
