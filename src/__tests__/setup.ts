/**
 * Vitest global setup.
 * Env vars are pre-injected via vitest.config.ts `test.env` so Zod validation
 * passes before any module is imported.
 *
 * This file handles per-test resets only.
 */
import { beforeEach } from "vitest";
import { resetFakeStore } from "@/providers/fake";
import { resetProvider } from "@/providers";

beforeEach(() => {
  resetFakeStore();
  resetProvider();
});
