import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

// Self-hosted by next/font at build time — no render-blocking request to
// fonts.googleapis.com, and no flash of a fallback face.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ReachInbox — Email Scheduler',
  description: 'Schedule, pace and rate-limit outbound email campaigns.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#3D9B4A',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-white font-sans text-ink antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
