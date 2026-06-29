/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Enables instrumentation.ts so the cron scheduler boots with the server.
    instrumentationHook: true,
    // Keep native + heavy node deps external to the server bundle (Next 14 key name).
    serverComponentsExternalPackages: [
      "better-sqlite3",
      "node-cron",
      "googleapis",
      "openai",
    ],
  },
};

export default nextConfig;
