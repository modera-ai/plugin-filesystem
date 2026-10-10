import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Jimp } from "jimp";
import { imageSize } from "image-size";
import webpDecode, { init as initWebp } from "@jsquash/webp/decode.js";

parentPort!.once(
  "message",
  async ({ bytes, extension }: { bytes: Uint8Array; extension: string }) => {
    try {
      if (["png", "jpg", "jpeg", "gif", "bmp", "webp"].includes(extension)) {
        const size = imageSize(bytes);
        if (
          !size.width ||
          !size.height ||
          size.width * size.height > 40_000_000
        )
          throw new Error("Image exceeds 40 megapixel budget");
        let image;
        if (extension === "webp") {
          // The decoder's browser-shaped return value needs only this data container in a Node worker.
          (globalThis as any).ImageData ??= class {
            constructor(
              public data: Uint8ClampedArray,
              public width: number,
              public height: number,
            ) {}
          };
          const wasm = await readFile(
            join(workerData.resourcePath, "dist/webp_dec.wasm"),
          );
          await initWebp(await WebAssembly.compile(wasm));
          const decoded = await webpDecode(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          );
          image = Jimp.fromBitmap({
            width: decoded.width,
            height: decoded.height,
            data: Buffer.from(decoded.data),
          });
        } else image = await Jimp.read(Buffer.from(bytes));
        const originalWidth = image.width,
          originalHeight = image.height;
        if (image.width * image.height > 40_000_000)
          throw new Error("Image exceeds 40 megapixel budget");
        image.scaleToFit({ w: 1600, h: 1600 });
        let encoded = await image.getBuffer("image/png");
        let mimeType: "image/png" | "image/jpeg" = "image/png";
        if (encoded.length > 700_000) {
          mimeType = "image/jpeg";
          for (const size of [1600, 1200, 800, 400]) {
            image.scaleToFit({ w: size, h: size });
            encoded = await image.getBuffer("image/jpeg", { quality: 75 });
            if (encoded.length <= 700_000) break;
          }
        }
        if (encoded.length > 700_000)
          throw new Error("Image exceeds tool output budget");
        parentPort!.postMessage({
          value: {
            type: "image",
            originalWidth,
            originalHeight,
            width: image.width,
            height: image.height,
            images: [{ mimeType, data: encoded.toString("base64") }],
            ...(extension === "gif"
              ? { warning: "Only the first animation frame is returned" }
              : {}),
          },
        });
      } else {
        const { extractDocument } = await import("./office");
        parentPort!.postMessage({
          value: await extractDocument(Buffer.from(bytes), extension),
        });
      }
    } catch (error) {
      parentPort!.postMessage({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
