/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle so the runtime image can be slim.
  output: "standalone",
};

export default nextConfig;
