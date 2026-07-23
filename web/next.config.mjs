/** @type {import('next').NextConfig} */

// Where the browser-facing /api and /auth calls are proxied to, server-side.
// Env-driven (never hardcode a host): defaults to the local gateway.
const gatewayInternal = process.env.GATEWAY_INTERNAL_URL ?? "http://localhost:8080";

// Dev-only: hosts the SPA may be served from besides localhost (e.g. a devtunnel
// domain), so Next 15.5 doesn't block their HMR/_next requests. Comma-separated,
// from env — tunnel-specific values live in .env.local, not in this committed file.
const devOrigins = (process.env.ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle so the runtime image can be slim.
  output: "standalone",
  ...(devOrigins.length ? { allowedDevOrigins: devOrigins } : {}),
  // Same-origin proxy: the browser only ever talks to the web origin, and Next
  // forwards API/auth calls to the gateway server-side. This removes cross-origin
  // CORS, the SameSite cookie split, and the second tunnel entirely — only the web
  // port needs to be exposed. Set NEXT_PUBLIC_GATEWAY_URL="" so the client uses
  // relative URLs that hit these rewrites.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${gatewayInternal}/api/:path*` },
      { source: "/auth/:path*", destination: `${gatewayInternal}/auth/:path*` },
    ];
  },
};

export default nextConfig;
