import { createRequire } from "node:module";

export interface DocumentTextExtractor {
  extractPdf(buffer: Buffer): Promise<string>;
}

const require = createRequire(import.meta.url);

export class PdfTextExtractor implements DocumentTextExtractor {
  async extractPdf(buffer: Buffer): Promise<string> {
    // pdf-parse 的 index.js 在 ESM/tsx 动态导入下可能误触发 debug 分支，直接加载库入口更稳定。
    const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (input: Buffer) => Promise<{ text: string }>;
    const result = await pdfParse(buffer);
    const text = result.text.replace(/\s+\n/g, "\n").trim();
    if (!text) {
      throw new Error("PDF 没有抽取到可用文本，请确认不是纯图片扫描件");
    }
    return text;
  }
}

export class PlainTextDocumentExtractor implements DocumentTextExtractor {
  async extractPdf(buffer: Buffer): Promise<string> {
    return buffer.toString("utf-8").trim();
  }
}
