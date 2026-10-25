import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "node18",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  splitting: false,
});
