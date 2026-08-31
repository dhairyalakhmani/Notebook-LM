import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { DocumentLoader } from "./base.ts";
import { htmlToLines } from "./html.ts";
import type { DocumentPage } from "../models.ts";

/**
 * `.html` files. Easier than PDF, because the format says what everything is:
 * `h1`-`h6` map straight onto headingLevel, so no font-size guessing is needed
 * and the heading hierarchy comes out exact.
 *
 * An HTML file has no pages, so it is one page.
 */
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
