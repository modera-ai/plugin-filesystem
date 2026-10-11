import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = resolve(root, "../../modera/modera-app");
const runner = join(host, "node_modules/vitest/vitest.mjs");
if (!existsSync(runner))
  throw new Error(
    "Filesystem tests require the prepared Modera workspace; run npm run setup in modera first.",
  );
const args = process.argv.slice(2);
const integration = args[0] === "--integration";
if (integration) args.shift();
const files = integration
  ? [
      "core/tests/prepared-tools.test.ts",
      "core/tests/plugin-localization-diff.test.ts",
      "core/tests/coding-tool-combination.test.ts",
      "core/tests/tool-registry.test.ts",
      "core/tests/plugin-standalone.test.ts",
      "core/tests/tool-images.test.ts",
    ]
  : [relative(host, join(root, "tests"))];
execFileSync(process.execPath, [join(root, "tools/build.mjs")], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
execFileSync(
  process.execPath,
  [
    runner,
    "run",
    "--config",
    join(root, "vitest.config.mjs"),
    ...files,
    ...args,
  ],
  { cwd: host, stdio: "inherit", windowsHide: true },
);
