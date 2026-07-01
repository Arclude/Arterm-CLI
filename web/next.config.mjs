/**
 * Static export: `next build` emits a self-contained `out/` that `arterm hq --web`
 * serves. No SSR/server runtime in production — the app is a client-side dashboard
 * that talks to the aggregator over WebSocket.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
