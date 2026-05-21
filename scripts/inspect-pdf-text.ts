import { readFile } from "node:fs/promises";
import { PdfTextExtractor } from "../src/server/documents/PdfTextExtractor";

const pdfPath = process.argv[2] ?? process.env.PDF_PATH;

function linesAround(lines: string[], pattern: RegExp, radius = 2) {
  const index = lines.findIndex((line) => pattern.test(line));
  if (index < 0) return [];
  return lines.slice(Math.max(0, index - radius), Math.min(lines.length, index + radius + 1));
}

async function main() {
  if (!pdfPath) throw new Error("请传入 PDF 路径。");
  const buffer = await readFile(pdfPath);
  const text = await new PdfTextExtractor().extractPdf(buffer);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  console.log(
    JSON.stringify(
      {
        chars: text.length,
        lines: lines.length,
        firstLines: lines.slice(0, 30),
        aroundName: linesAround(lines, /姓名|Name|姓\s*名/i, 4),
        aroundPhone: linesAround(lines, /1[3-9]\d{9}|电话|手机|Phone/i, 4),
        aroundProject: linesAround(lines, /项目|经历|经验|Project|Experience/i, 4)
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
