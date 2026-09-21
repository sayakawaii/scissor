import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  platform: "node",
  target: "node18",
  // Keep third-party/node_modules deps external and load them at runtime;
  // this avoids bundling CommonJS packages (fast-glob, etc.) into ESM.
  skipNodeModulesBundle: true,
  banner: { js: "#!/usr/bin/env node" },
});
