import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { DocumentLoader } from "./base.ts";
import { htmlToLines } from "./html.ts";
import type { DocumentPage } from "../models.ts";

export class HTMLDocumentLoader extends DocumentLoader {
  readonly extensions = [".html", ".htm", ".xhtml"] as const;

  async load(filePath: string): Promise<DocumentPage[]> {
    await this.validate(filePath);
    const lines = htmlToLines(await readFile(filePath, "utf8"));
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
