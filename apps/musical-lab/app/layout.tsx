import type { ReactNode } from "react";
import Script from "next/script";
import "./globals.css";
import "./shell.css";
import "./huse.css";

export const metadata = { title: "Nugget" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="yellow" suppressHydrationWarning>
      <head>
        {/* Unbounded (headings, buttons), Atkinson Hyperlegible (body), Silkscreen (labels). Without a network the page
            falls back to the system fonts and works the same. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700;800&family=Atkinson+Hyperlegible:wght@400;700&family=Silkscreen:wght@400;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        {children}
        {/* applies the saved theme and colours before the first paint (public/theme-init.js) */}
        <Script src="/theme-init.js" strategy="beforeInteractive" />
      </body>
    </html>
  );
}
