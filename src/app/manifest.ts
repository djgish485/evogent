import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Evogent',
    short_name: 'Evogent',
    description: 'Personal media curation feed powered by an always-on agent session.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone'],
    orientation: 'portrait',
    background_color: '#08090b',
    theme_color: '#000000',
    categories: ['productivity', 'news'],
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
