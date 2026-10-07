import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    // Add new ngrok URLs here when the tunnel restarts
    "a0f6-2402-3a80-43e0-7604-49c9-eea9-f233-5d76.ngrok-free.app",
    "a65a-2402-3a80-43e0-7604-49c9-eea9-f233-5d76.ngrok-free.app",
    // Wildcard alternative: "*.ngrok-free.app" — use if URL keeps changing
  ],
};

export default nextConfig;
