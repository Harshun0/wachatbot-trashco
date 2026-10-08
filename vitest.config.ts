import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: true,
    // env is injected into process.env BEFORE any module is loaded — fixes Zod env validation
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      REDIS_URL: "redis://localhost:6379",
      WA_PROVIDER: "fake",
      WA_PHONE_NUMBER_ID: "919900000000",
      WA_WABA_ID: "fake_waba_id",
      WA_ACCESS_TOKEN: "fake_access_token",
      WA_APP_SECRET: "fake_secret_32chars_xxxxxxxxxxxxx",
      WA_VERIFY_TOKEN: "fake_verify_token",
      INTERNAL_API_KEY: "dev_internal_key_for_tests_xxxxxxxx",
      WA_GRAPH_VERSION: "v25.0",
      LLM_PROVIDER: "gemini",
      // No GEMINI_API_KEY in tests — LLM will return null and bot falls back
      NODE_ENV: "test",
    },
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
