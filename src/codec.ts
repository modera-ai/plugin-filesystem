import iconv from "iconv-lite";
export type TextEncoding = "utf8" | "utf16le" | "utf16be" | "gb18030";
export const encodingSchema = {
  enum: ["utf8", "utf16le", "utf16be", "gb18030"],
  description:
    "BOM auto-detected; otherwise UTF-8. Specify gb18030 for legacy Chinese files. Edits preserve encoding/BOM.",
};
export function detectEncoding(
  bytes: Buffer,
  requested?: TextEncoding,
): TextEncoding {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf16be";
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return "utf8";
  if (requested && !encodingSchema.enum.includes(requested))
    throw new Error("Unsupported encoding");
  return requested ?? "utf8";
}
export function encodeText(text: string, encoding: TextEncoding): Buffer {
  const bytes = iconv.encode(text, encoding);
  if (iconv.decode(bytes, encoding, { stripBOM: false }) !== text)
    throw new Error("Text cannot be encoded losslessly");
  return bytes;
}
export function decodeText(bytes: Buffer, requested?: TextEncoding) {
  const encoding = detectEncoding(bytes, requested);
  const text = iconv.decode(bytes, encoding, { stripBOM: false });
  if (text.includes("\0")) throw new Error("Binary file is not supported");
  if (!encodeText(text, encoding).equals(bytes))
    throw new Error(
      "Invalid text encoding; specify the correct encoding explicitly",
    );
  return { text, encoding };
}
