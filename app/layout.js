import { Geist, Geist_Mono, Playfair_Display } from 'next/font/google';
import './globals.css';

const sans = Geist({ subsets: ['latin'], variable: '--font-sans' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });
const serif = Playfair_Display({ subsets: ['latin'], variable: '--font-serif' });

export const metadata = {
  title: 'Nikah Connect — AI Matchmaker',
  description: 'AI-powered rishta matchmaking dashboard by www.nikahconnect.pro',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${serif.variable}`}>
      <body className="min-h-screen font-[family-name:var(--font-sans)] antialiased">{children}</body>
    </html>
  );
}
