import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: process.env.BUILD_STATIC === 'true' ? 'export' : undefined,
  images: { unoptimized: true },
  async rewrites() {
    if (process.env.BUILD_STATIC === 'true') return [];
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3000/api/:path*',
      },
      {
        source: '/socket.io/:path*',
        destination: 'http://localhost:3000/socket.io/:path*',
      },
    ];
  },
};

export default nextConfig;
