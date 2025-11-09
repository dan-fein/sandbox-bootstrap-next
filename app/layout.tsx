import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Vercel Sandbox Router',
  description: 'Next.js app served via orchestrated Vercel Sandboxes',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
