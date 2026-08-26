import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { DocumentLoader } from "./base.ts";
import type { DocumentPage, TextLine } from "../models.ts";

const MARKDOWN_HEADING = /^(#{1,6})\s+(.*\S)\s*$/;

export class TextDocumentLoader extends DocumentLoader {
  readonly extensions = [".txt", ".md", ".markdown"] as const;

  async load(filePath: string): Promise<DocumentPage[]> {
    await this.validate(filePath);
    const raw = await readFile(filePath, "utf8");

    const lines: TextLine[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const stripped = line.trim();
      if (!stripped) continue;
      const heading = MARKDOWN_HEADING.exec(stripped);
      if (heading) {
        lines.push({
          text: heading[2]!,
          pageNumber: 1,
          headingLevel: heading[1]!.length,
        });
      } else {
        lines.push({ text: stripped, pageNumber: 1 });
      }
    }

    // A text file has no pages, so it is one page.
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
