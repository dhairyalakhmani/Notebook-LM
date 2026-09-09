import { basename } from "node:path";
import { convertToHtml } from "mammoth";
import { DocumentLoader } from "./base.ts";
import { htmlToLines } from "./html.ts";
import type { DocumentPage } from "../models.ts";

export class DocxDocumentLoader extends DocumentLoader {
  readonly extensions = [".docx"] as const;

  async load(filePath: string): Promise<DocumentPage[]> {
    await this.validate(filePath);
    const { value: html } = await convertToHtml({ path: filePath });
    const lines = htmlToLines(html);
    return [
      {
        text: lines.map((line) => line.text).join("\n"),
        pageNumber: 1,
        source: basename(filePath),
        lines,
      },
    ];
  }
}
