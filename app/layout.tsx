import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Harness Interview — Debug Recorded AI Coding Agent Sessions',
  description:
    'Inspect recorded SWE-agent failure sessions, pinpoint the exact step where the agent went off-track, diagnose the root cause, and select the systemic harness guardrail that prevents it.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-[#0a0a0a] text-[#ededed] font-sans antialiased flex flex-col selection:bg-blue-500/30 selection:text-white">
        {children}
      </body>
    </html>
  );
}
