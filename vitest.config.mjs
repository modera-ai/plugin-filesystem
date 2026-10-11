import { fileURLToPath } from "node:url";
export default {
  resolve: {
    alias: {
      "@modera-host": fileURLToPath(
        new URL("../../modera/modera-app/core/packages", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "../../plugins/plugin-filesystem/tests/**/*.test.ts",
      "core/tests/prepared-tools.test.ts",
      "core/tests/tool-images.test.ts",
      "core/tests/plugin-standalone.test.ts",
      "core/tests/plugin-localization-diff.test.ts",
      "core/tests/coding-tool-combination.test.ts",
      "core/tests/tool-registry.test.ts",
    ],
    fileParallelism: false,
  },
};
