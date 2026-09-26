import type { Metadata } from "next";
import { Sora, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const display = Sora({ subsets: ["latin"], weight: ["600", "700", "800"], variable: "--font-display" });
const body = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-body" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["500", "700"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "SafariBet",
  description: "Sportsbook & Casino",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body className="bg-ink text-text font-body antialiased">{children}</body>
    </html>
  );
}
