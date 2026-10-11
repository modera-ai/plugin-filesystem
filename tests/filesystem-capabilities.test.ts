import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { Jimp } from "jimp";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import * as CFB from "cfb";
import iconv from "iconv-lite";
import { readWorkspace } from "../src/read";
import { WorkspaceWriter } from "../src/write";
import { workspaceMentions } from "../src/composer";
import { decodeText } from "../src/codec";
import { replaceText } from "../src/edit-text";
const resourcePath = resolve(
  process.env.MODERA_PLUGINS_DIR ?? "../../plugins",
  "plugin-filesystem",
);
async function fixture(run: (root: string, context: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "filesystem-capabilities-"));
  try {
    await run(root, {
      workspacePath: root,
      sessionId: "s",
      runId: "r",
      signal: new AbortController().signal,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
it("reads and edits Windows multiline files without rewriting unrelated mixed newlines", () =>
  fixture(async (root, context) => {
    await writeFile(join(root, "source.txt"), "first\r\nsecond\r\nlast\n");
    const writer = new WorkspaceWriter();
    const plan = await writer.prepare(
      "edit",
      {
        path: "source.txt",
        searchContent: "first\nsecond",
        replaceContent: "new\nsecond",
      },
      context,
    );
    await writer.execute("edit", plan.input, context);
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe(
      "new\r\nsecond\r\nlast\n",
    );
  }));
it("safely truncates multibyte file mentions and supports BOM encoded mentions", () =>
  fixture(async (root, context) => {
    await writeFile(join(root, "large.txt"), "a".repeat(100000) + "你");
    const result = await workspaceMentions.resolve!(
      { resourceId: "large.txt", locale: "en" },
      context,
    );
    expect(result.text).toBe("a".repeat(100000));
    expect(result.truncated).toBe(true);
    await writeFile(
      join(root, "utf16.txt"),
      iconv.encode("\uFEFF中文", "utf16le"),
    );
    expect(
      (
        await workspaceMentions.resolve!(
          { resourceId: "utf16.txt", locale: "en" },
          context,
        )
      ).text,
    ).toBe("中文");
  }));
it("accepts legacy encodings and preserves lossless explicit decoding", () => {
  for (const encoding of [
    "big5",
    "shift_jis",
    "euc-kr",
    "windows-1252",
  ] as const) {
    const text =
      encoding === "big5"
        ? "繁體中文"
        : encoding === "shift_jis"
          ? "日本語"
          : encoding === "euc-kr"
            ? "한국어"
            : "café";
    expect(decodeText(iconv.encode(text, encoding), encoding).text).toBe(text);
  }
});
it(
  "returns host-compatible image data and paged DOCX/PPTX and spreadsheet text",
  () =>
    fixture(async (root, context) => {
      const image = new Jimp({ width: 12, height: 8, color: 0xff0000ff });
      await writeFile(
        join(root, "picture.png"),
        await image.getBuffer("image/png"),
      );
      const visual: any = await readWorkspace(
        { path: "picture.png" },
        context,
        resourcePath,
      );
      expect(visual.type).toBe("image");
      expect(visual.width).toBe(12);
      expect(visual.height).toBe(8);
      expect(visual.images[0].mimeType).toBe("image/png");
      expect(
        Buffer.from(visual.images[0].data, "base64").subarray(1, 4).toString(),
      ).toBe("PNG");
      const doc = new JSZip();
      doc.file(
        "[Content_Types].xml",
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      );
      doc.file(
        "word/document.xml",
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello document</w:t></w:r></w:p></w:body></w:document>',
      );
      await writeFile(
        join(root, "word.docx"),
        await doc.generateAsync({ type: "nodebuffer" }),
      );
      const first: any = await readWorkspace(
        { path: "word.docx", maxLines: 1 },
        context,
        resourcePath,
      );
      expect(first.content).toContain("Hello document");
      expect(first.hasMore).toBe(true);
      const next: any = await readWorkspace(
        {
          path: "word.docx",
          startLine: first.nextLine,
          version: first.version,
        },
        context,
        resourcePath,
      );
      expect(next.content).not.toContain("Hello document");
      doc.file(
        "word/document.xml",
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${"长段落🙂".repeat(4000)}</w:t></w:r></w:p></w:body></w:document>`,
      );
      await writeFile(
        join(root, "long.docx"),
        await doc.generateAsync({ type: "nodebuffer" }),
      );
      const paragraph: any = await readWorkspace(
        { path: "long.docx", maxLines: 2 },
        context,
        resourcePath,
      );
      expect(paragraph.hasMore).toBe(true);
      expect(paragraph.content.length).toBeLessThan(12000);
      expect(paragraph.content).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/,
      );
      await writeFile(join(root, "word.docx"), "changed");
      await expect(
        readWorkspace(
          { path: "word.docx", version: first.version },
          context,
          resourcePath,
        ),
      ).rejects.toThrow("changed");
      const ppt = new JSZip();
      ppt.file(
        "ppt/slides/slide1.xml",
        '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Hello slide</a:t></p:sld>',
      );
      await writeFile(
        join(root, "slides.pptx"),
        await ppt.generateAsync({ type: "nodebuffer" }),
      );
      expect(
        (
          (await readWorkspace(
            { path: "slides.pptx" },
            context,
            resourcePath,
          )) as any
        ).content,
      ).toContain("Hello slide");
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([
          ["Name", "Value"],
          ["Sample", 42],
        ]),
        "Main",
      );
      for (const bookType of ["xlsx", "xls", "xlsb", "xlsm", "ods"] as const) {
        await writeFile(
          join(root, `table.${bookType}`),
          XLSX.write(book, { type: "buffer", bookType }),
        );
        expect(
          (
            (await readWorkspace(
              { path: `table.${bookType}` },
              context,
              resourcePath,
            )) as any
          ).content,
        ).toContain("Sample,42");
      }
    }),
  30_000,
);
it("extracts PDF text without fetching external resources and aborts media jobs", () =>
  fixture(async (root, context) => {
    const body = "BT /F1 12 Tf 50 100 Td (Hello PDF) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((object, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
      .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    await writeFile(join(root, "document.pdf"), pdf);
    expect(
      (
        (await readWorkspace(
          { path: "document.pdf" },
          context,
          resourcePath,
        )) as any
      ).content,
    ).toContain("Hello PDF");
    const abort = new AbortController();
    abort.abort();
    await expect(
      readWorkspace(
        { path: "document.pdf" },
        { ...context, signal: abort.signal },
        resourcePath,
      ),
    ).rejects.toThrow();
  }));

it("decodes JPEG/GIF/BMP/WebP into bounded host images", () =>
  fixture(async (root, context) => {
    const image = new Jimp({ width: 12, height: 8, color: 0xff0000ff });
    for (const [extension, mime] of [
      ["jpg", "image/jpeg"],
      ["gif", "image/gif"],
      ["bmp", "image/bmp"],
    ]) {
      await writeFile(
        join(root, `picture.${extension}`),
        await image.getBuffer(mime as any),
      );
      expect(
        (
          (await readWorkspace(
            { path: `picture.${extension}` },
            context,
            resourcePath,
          )) as any
        ).images[0].data.length,
      ).toBeLessThan(1_000_000);
    }
    await writeFile(
      join(root, "picture.webp"),
      Buffer.from(
        "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AA/v89WAAAAA==",
        "base64",
      ),
    );
    expect(
      (
        (await readWorkspace(
          { path: "picture.webp" },
          context,
          resourcePath,
        )) as any
      ).images[0].mimeType,
    ).toBe("image/png");
  }));

it("extracts legacy PPT text atoms and rejects invalid legacy containers", () =>
  fixture(async (root, context) => {
    const data = Buffer.from("Legacy presentation text", "utf16le");
    const header = Buffer.alloc(8);
    header.writeUInt16LE(4000, 2);
    header.writeUInt32LE(data.length, 4);
    const container = CFB.utils.cfb_new();
    CFB.utils.cfb_add(
      container,
      "PowerPoint Document",
      Buffer.concat([header, data]),
    );
    await writeFile(
      join(root, "legacy.ppt"),
      CFB.write(container, { type: "buffer" }),
    );
    expect(
      (
        (await readWorkspace(
          { path: "legacy.ppt" },
          context,
          resourcePath,
        )) as any
      ).content,
    ).toContain("Legacy presentation text");
    await writeFile(join(root, "invalid.doc"), "not an Office file");
    await expect(
      readWorkspace({ path: "invalid.doc" }, context, resourcePath),
    ).rejects.toThrow("Invalid legacy");
  }));

it("keeps fuzzy matching opt-in and never ignores indentation", async () => {
  expect(() =>
    replaceText(
      "  const answer = 42;",
      "  const answex = 42;",
      "  const answer = 43;",
    ),
  ).toThrow("not found");
  expect(
    replaceText(
      "  const answer = 42;",
      "  const answex = 42;",
      "  const answer = 43;",
      undefined,
      true,
    ),
  ).toMatchObject({ after: "  const answer = 43;", matchType: "fuzzy" });
  expect(() =>
    replaceText(
      "  const answer = 42;",
      "const answex = 42;",
      "const answer = 43;",
      undefined,
      true,
    ),
  ).toThrow("not found");
});

it("previews formatting before writing and reports formatting in the applied result", () =>
  fixture(async (root, context) => {
    await writeFile(join(root, "code.ts"), "const answer=42;\r\n");
    const writer = new WorkspaceWriter(undefined, async () => ({
      autoFormat: true,
    }));
    const plan = await writer.prepare(
      "edit",
      { path: "code.ts", searchContent: "42", replaceContent: "43" },
      context,
    );
    expect(plan.preview).toMatchObject({
      after: "const answer = 43;\r\n",
      formatted: true,
    });
    expect(await readFile(join(root, "code.ts"), "utf8")).toBe(
      "const answer=42;\r\n",
    );
    expect(await writer.execute("edit", plan.input, context)).toMatchObject({
      formatted: true,
    });
  }));
