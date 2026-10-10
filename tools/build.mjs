import { buildPlugin } from "@modera/plugin-build";
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
await mkdir(join(root, "dist"), { recursive: true });
await copyFile(
  require.resolve("@jsquash/webp/codec/dec/webp_dec.wasm"),
  join(root, "dist/webp_dec.wasm"),
);
const result = await buildPlugin(root);
console.log(`built ${result.manifest.id}@${result.manifest.version}`);
