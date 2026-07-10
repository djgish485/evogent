import type { Metadata, Viewport } from 'next';
import { AppUpdatedBanner } from './app-updated-banner';
import './globals.css';

// Serve the app shell dynamically (no static prerender, no s-maxage cache). The WebView home
// screen must always load the current build: with the default static "/" (Cache-Control
// s-maxage=31536000, x-nextjs-cache HIT) a WebView holding an old build keeps serving it and
// the "App updated — tap to reload" banner's location.reload() cannot pull the new bundle.
export const dynamic = 'force-dynamic';

export const viewport: Viewport = {
  themeColor: '#000000',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
};

export const metadata: Metadata = {
  title: 'Evogent',
  description: 'Personal media curation feed powered by an always-on agent session.',
  applicationName: 'Evogent',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Evogent',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: {
    telephone: false,
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        <AppUpdatedBanner />
        {children}
      </body>
    </html>
  );
}
