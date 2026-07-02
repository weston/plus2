import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { ThemeSwitcher } from '@/components/ThemeSwitcher';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Plus2 - Competitive Rubik\'s Cube Racing',
  description: 'Race against players worldwide in real-time Rubik\'s cube solving competitions',
};

// Apply the saved theme before paint to avoid a flash of the default theme.
const themeScript = `(function(){try{var t=localStorage.getItem('plus2-theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="premium" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={inter.className}>
        {children}
        <ThemeSwitcher />
      </body>
    </html>
  );
}
