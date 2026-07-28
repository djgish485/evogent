/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  serverExternalPackages: ['better-sqlite3', 'sqlite-vec', 'sqlite-vec-linux-x64'],
  turbopack: {},
};

module.exports = nextConfig;
