import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Turtle',
  description: 'A voice-first companion for caregivers. Turtle is software, not a person.',
};

// Atkinson Hyperlegible — designed for maximum legibility (low-vision, dyslexia-friendly).
// The right call for a caregiver who may be tired, stressed, or older.
const fontHref =
  'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&display=swap';

export const viewport: Viewport = {
  themeColor: '#0f1115',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={fontHref} />
      </head>
      <body>{children}</body>
    </html>
  );
}
