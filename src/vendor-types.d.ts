declare module "pdfjs-dist/build/pdf.mjs" {
  export { getDocument } from "pdfjs-dist";
}
declare module "word-extractor" {
  export default class WordExtractor {
    extract(bytes: Buffer): Promise<{ getBody(): string }>;
  }
}
declare module "pdfjs-dist/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
