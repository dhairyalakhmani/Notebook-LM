import { basename } from "node:path";
import { convertToHtml } from "mammoth";
import { DocumentLoader } from "./base.ts";
import { htmlToLines } from "./html.ts";
import type { DocumentPage } from "../models.ts";

/**
 * Word documents.
 *
 * Word has *real* heading styles, so unlike a PDF there is nothing to infer:
 * mammoth maps "Heading 1".."Heading 6" onto `<h1>`..`<h6>`, and the shared
 * HTML walker turns those into explicit `headingLevel` values. That makes the
 * heading hierarchy exact rather than reconstructed - the pipeline's
 * `levelsAreMeaningful` check sees genuine levels and trusts them.
 *
 * Going via HTML rather than mammoth's `extractRawText` is deliberate: raw text
 * throws away the styles, which are the whole reason this format is easy.
 */
export class DocxDocumentLoader extends DocumentLoader {
  readonly extensions = [".docx"] as const;

  async load(filePath: string): Promise<DocumentPage[]> {
    await this.validate(filePath);
    // mammoth reports unsupported styles on `messages`; they are informational
    // and never a reason to fail an ingest.
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
