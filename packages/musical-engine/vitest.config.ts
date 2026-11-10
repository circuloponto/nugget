import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The suite is small and CPU-light; a single worker keeps memory use low
    // on constrained machines and CI runners.
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
  },
});
