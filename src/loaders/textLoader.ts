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
    // A blank line is the paragraph break in a text file - the one structural
    // signal the format has. Record it rather than dropping it.
    let blankBefore = false;
    for (const line of raw.split(/\r?\n/)) {
      const stripped = line.trim();
      if (!stripped) {
        blankBefore = true;
        continue;
      }
      const heading = MARKDOWN_HEADING.exec(stripped);
      lines.push(
        heading
          ? {
              text: heading[2]!,
              pageNumber: 1,
              headingLevel: heading[1]!.length,
              breakBefore: true,
            }
          : { text: stripped, pageNumber: 1, breakBefore: blankBefore },
      );
      blankBefore = false;
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
