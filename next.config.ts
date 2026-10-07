import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // instrumentation.ts is auto-enabled in Next.js 15+ — no flag needed
  allowedDevOrigins: [
    "a0f6-2402-3a80-43e0-7604-49c9-eea9-f233-5d76.ngrok-free.app",
    "a65a-2402-3a80-43e0-7604-49c9-eea9-f233-5d76.ngrok-free.app",
  ],
};

export default nextConfig;
