import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: false,
  serverExternalPackages: ['better-sqlite3', 'sqlite-vec', 'sqlite-vec-linux-x64'],
  turbopack: {},
};

export default nextConfig;
