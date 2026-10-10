import iconv from "iconv-lite";
import { analyse } from "chardet";
export type TextEncoding =
  | "utf8"
  | "utf16le"
  | "utf16be"
  | "gb18030"
  | "big5"
  | "shift_jis"
  | "euc-kr"
  | "windows-1252";
export const encodingSchema = {
  enum: [
    "utf8",
    "utf16le",
    "utf16be",
    "gb18030",
    "big5",
    "shift_jis",
    "euc-kr",
    "windows-1252",
  ],
  description:
    "BOM/legacy encoding detected; specify encoding when ambiguous. Edits preserve encoding/BOM.",
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
  if (requested) return requested;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf8";
  } catch {
    /* Detect legacy text conservatively. */
  }
  const aliases: Record<string, TextEncoding> = {
    "UTF-8": "utf8",
    GB18030: "gb18030",
    Big5: "big5",
    Shift_JIS: "shift_jis",
    "EUC-KR": "euc-kr",
    "windows-1252": "windows-1252",
  };
  for (const match of analyse(bytes)) {
    if (match.confidence >= 50 && aliases[match.name])
      return aliases[match.name]!;
  }
  return "utf8";
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

/** Trim only a partial trailing character; invalid bytes in the body still fail. */
export function decodePrefix(
  bytes: Buffer,
  encoding: TextEncoding,
  final: boolean,
) {
  let failure: unknown;
  for (let trim = 0; trim < (final ? 1 : 4) && trim <= bytes.length; trim++) {
    try {
      return {
        ...decodeText(bytes.subarray(0, bytes.length - trim), encoding),
        consumed: bytes.length - trim,
      };
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure instanceof Error && failure.message.includes("Binary"))
    throw failure;
  throw new Error("Invalid text encoding or cursor boundary");
}
