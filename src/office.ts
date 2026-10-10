import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import * as CFB from "cfb";

const TEXT_LIMIT = 1_000_000;
// Supply the fake worker directly: no unbundled worker URLs, document scripts or network fetches.
const xml = new XMLParser({ ignoreAttributes: false, processEntities: false });
async function archive(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  let total = 0,
    count = 0;
  for (const entry of Object.values(zip.files)) {
    total += (entry as any)._data?.uncompressedSize ?? 0;
    if (++count > 10000 || total > 50 * 1024 * 1024)
      throw new Error("Office archive exceeds extraction budget");
  }
  return zip;
}
function textNodes(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(textNodes);
  return Object.entries(node).flatMap(([key, value]) =>
    key === "a:t"
      ? [
          String(
            typeof value === "object" && value
              ? ((value as any)["#text"] ?? "")
              : value,
          ),
        ]
      : textNodes(value),
  );
}
export async function extractDocument(bytes: Buffer, extension: string) {
  let text = "";
  const warnings: string[] = [];
  if (extension === "pdf") {
    const { getDocument } = await import("pdfjs-dist/build/pdf.mjs");
    const { WorkerMessageHandler } =
      await import("pdfjs-dist/build/pdf.worker.mjs");
    (globalThis as any).pdfjsWorker = { WorkerMessageHandler };
    const task = getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useWorkerFetch: false,
      disableFontFace: true,
      verbosity: 0,
    });
    try {
      const document = await task.promise;
      if (document.numPages > 500)
        throw new Error("PDF exceeds 500 page budget");
      for (
        let i = 1;
        i <= document.numPages && text.length <= TEXT_LIMIT;
        i++
      ) {
        const page = await document.getPage(i);
        const content = await page.getTextContent();
        text +=
          `[Page ${i}]\n` +
          content.items
            .map((item: any) =>
              item.str ? item.str + (item.hasEOL ? "\n" : " ") : "",
            )
            .join("") +
          "\n";
        page.cleanup();
      }
      if (!text.replace(/\[Page \d+\]/g, "").trim())
        throw new Error("PDF has no extractable text; OCR is required");
    } finally {
      await task.destroy();
    }
  } else if (extension === "docx") {
    const zip = await archive(bytes);
    if (!zip.file("word/document.xml")) throw new Error("DOCX body is missing");
    const result = await mammoth.extractRawText({ buffer: bytes });
    text = result.value;
    warnings.push(
      ...result.messages
        .slice(0, 20)
        .map((message) => message.message.slice(0, 500)),
    );
  } else if (extension === "pptx") {
    const zip = await archive(bytes);
    const slides = Object.keys(zip.files)
      .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
      .sort(
        (a, b) =>
          Number(a.match(/slide(\d+)/)![1]) - Number(b.match(/slide(\d+)/)![1]),
      );
    for (let i = 0; i < slides.length && text.length <= TEXT_LIMIT; i++)
      text += `[Slide ${i + 1}]\n${textNodes(xml.parse(await zip.file(slides[i]!)!.async("string"))).join("\n")}\n`;
    if (!slides.length) throw new Error("PPTX slides are missing");
  } else if (["xlsx", "xls", "xlsb", "xlsm", "ods"].includes(extension)) {
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) await archive(bytes);
    const workbook = XLSX.read(bytes, {
      type: "buffer",
      cellFormula: false,
      cellHTML: false,
      sheetRows: 10000,
    });
    for (const name of workbook.SheetNames) {
      text += `[Sheet ${name}]\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name]!)}\n`;
      if (text.length > TEXT_LIMIT) break;
    }
    warnings.push(
      "Rows are limited to 10000 per sheet; formulas/macros are not executed",
    );
  } else if (extension === "doc") {
    try {
      text = (await new WordExtractor().extract(bytes)).getBody();
    } catch {
      text = recoverLegacyText(bytes);
      warnings.push(
        "Legacy DOC binary text recovery is incomplete; convert to DOCX/PDF for reliable extraction",
      );
    }
    if (!text.trim())
      throw new Error(
        "Legacy DOC has no recoverable text; convert to DOCX/PDF",
      );
  } else {
    // Same last-resort class as Snow's legacy binary fallback; never pretend this restores the document.
    const file = CFB.read(bytes, { type: "buffer" });
    const stream = CFB.find(file, "PowerPoint Document");
    const data = Buffer.from(stream?.content ?? []);
    for (let at = 0; at + 8 <= data.length && text.length <= TEXT_LIMIT;) {
      const version = data.readUInt16LE(at) & 15,
        type = data.readUInt16LE(at + 2),
        length = data.readUInt32LE(at + 4);
      if (at + 8 + length > data.length) break;
      if (type === 4000)
        text +=
          data.subarray(at + 8, at + 8 + length).toString("utf16le") + "\n";
      if (type === 4008)
        text +=
          data.subarray(at + 8, at + 8 + length).toString("latin1") + "\n";
      at += version === 15 ? 8 : 8 + length;
    }
    if (!text.trim()) text = recoverLegacyText(bytes);
    if (!text.trim())
      throw new Error(
        "Legacy DOC/PPT has no recoverable text; convert to DOCX/PPTX/PDF",
      );
    warnings.push(
      "Legacy binary text recovery is incomplete; convert to DOCX/PPTX/PDF for reliable extraction",
    );
  }
  return {
    text: text.slice(0, TEXT_LIMIT),
    format: extension,
    truncated: text.length > TEXT_LIMIT,
    warnings,
  };
}

function recoverLegacyText(bytes: Buffer) {
  if (
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  )
    throw new Error("Invalid legacy Office container");
  const chunks: string[] = [];
  for (let offset = 0; offset < 2; offset++) {
    const decoded = bytes.subarray(offset).toString("utf16le");
    chunks.push(
      ...(decoded.match(/[\p{L}\p{N}\p{P}\p{Zs}]{8,}/gu) ?? []).filter(
        (value) => /[\p{L}]/u.test(value),
      ),
    );
  }
  return chunks.join("\n").slice(0, TEXT_LIMIT);
}
