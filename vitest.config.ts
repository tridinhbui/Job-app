import { defineConfig } from "vitest/config";

// Unit tests cover the deterministic (non-AI, non-binding) logic and run in plain Node.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
