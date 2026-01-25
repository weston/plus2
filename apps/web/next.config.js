/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@plus2/shared'],
  // Required for cubing.js web components
  experimental: {
    esmExternals: 'loose',
  },
};

module.exports = nextConfig;
