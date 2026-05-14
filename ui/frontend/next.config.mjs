/** @type {import('next').NextConfig} */
const nextConfig = {
  // Default dev proxy timeout is 30s (next/dist/server/lib/router-utils/proxy-request.js).
  // FLF / Comfy runs exceed that; without this, the proxy errors and responds with plain
  // "Internal Server Error" (500) while uvicorn may still be working. Browser defaults to
  // same-origin `/api` (see src/lib/api.ts), so this proxy timeout applies to normal flows.
  experimental: {
    proxyTimeout: 1_800_000,
  },
  async rewrites() {
    const apiDest = process.env.API_PROXY_DESTINATION || "http://127.0.0.1:8000";
    return [
      {
        source: "/api/:path*",
        destination: `${apiDest}/:path*`,
      },
    ];
  },
};

export default nextConfig;
