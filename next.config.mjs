/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    externalDir: true,
    serverActions: {
      bodySizeLimit: '2mb'
    }
  }
};

export default nextConfig;
