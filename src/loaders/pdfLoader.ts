import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api.js";
import { DocumentLoader } from "./base.ts";
import type { DocumentPage, TextLine } from "../models.ts";

const Y_TOLERANCE = 3.0; // items within 3pt vertically belong to the same line
const BOLD_NAME = /bold|black|heavy|semibold|demi/i;

/** Where standard (non-embedded) fonts live, so resolving fonts doesn't warn. */
const STANDARD_FONTS = new URL("../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).href;

interface Piece {
  text: string;
  left: number;
  right: number;
  top: number;      // already flipped: 0 = top of the page
  fontSize: number;
  isBold: boolean;
}

/**
 * pdf.js gives text bottom-up (y grows upward) and hands out generated font ids
 * like "g_d0_f1". getOperatorList() resolves those ids to the real PostScript
 * names ("...-BoldMT"), which is the only way to know a run is bold.
 */
async function piecesOnPage(page: PDFPageProxy): Promise<Piece[]> {
  await page.getOperatorList();
  const content = await page.getTextContent();
  const pageHeight = page.getViewport({ scale: 1 }).viewBox[3] ?? 0;

  const boldByFont = new Map<string, boolean>();
  const isBoldFont = (fontId: string): boolean => {
    const cached = boldByFont.get(fontId);
    if (cached !== undefined) return cached;
    let bold = false;
    try {
      const font = page.commonObjs.get(fontId) as { name?: string } | undefined;
      bold = BOLD_NAME.test(font?.name ?? "");
    } catch {
      bold = false;
    }
    boldByFont.set(fontId, bold);
    return bold;
  };

  const pieces: Piece[] = [];
  for (const item of content.items as TextItem[]) {
    // Keep whitespace-only runs: a lone " " item is often the real space between
    // "customer_id" and "(PK)". Only the zero-width end-of-line markers go.
    if (item.str === "" || item.width === 0) continue;
    const [scaleX, , , scaleY, x, y] = item.transform as number[];
    const fontSize = item.height || scaleY || scaleX || 0;
    pieces.push({
      text: item.str,
      left: x ?? 0,
      right: (x ?? 0) + item.width,
      top: pageHeight - (y ?? 0), // flip to top-down so sorting reads naturally
      fontSize,
      isBold: isBoldFont(item.fontName),
    });
  }
  return pieces;
}

/** Group pieces into visual lines: band by y, then read left to right. */
export function linesFromPieces(pieces: Piece[], pageNumber: number): TextLine[] {
  const sorted = [...pieces].sort((a, b) => a.top - b.top);

  const bands: Piece[][] = [];
  let bandTop = Number.NaN;
  for (const piece of sorted) {
    const last = bands.at(-1);
    if (last && Math.abs(piece.top - bandTop) <= Y_TOLERANCE) {
      last.push(piece);
    } else {
      bands.push([piece]);
      bandTop = piece.top;
    }
  }

  const lines: TextLine[] = [];
  for (const band of bands) {
    band.sort((a, b) => a.left - b.left);
    const text = band.map((p) => p.text).join("").trim();
    if (!text) continue;
    // Judge size and weight from the real words only — the spaces between them
    // often carry a different font and would skew both.
    const words = band.filter((p) => p.text.trim());
    // the longest run decides the line's font size; a stray superscript should not
    const dominant = words.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    lines.push({
      text,
      pageNumber,
      fontSize: Math.round(dominant.fontSize * 10) / 10,
      isBold: words.every((p) => p.isBold),
    });
  }
  return lines;
}

export class PDFDocumentLoader extends DocumentLoader {
  readonly extensions = [".pdf"] as const;

  async load(filePath: string): Promise<DocumentPage[]> {
    await this.validate(filePath);
    const task = getDocument({
      url: pathToFileURL(filePath),
      standardFontDataUrl: STANDARD_FONTS,
      useSystemFonts: true,
      verbosity: 0,
    });

    const source = basename(filePath);
    const pages: DocumentPage[] = [];
    try {
      const pdf = await task.promise;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const lines = linesFromPieces(await piecesOnPage(page), pageNumber);
        page.cleanup();
        pages.push({
          text: lines.map((line) => line.text).join("\n"),
          pageNumber,
          source,
          lines,
        });
      }
    } finally {
      await task.destroy(); // releases the worker; without it the process hangs
    }
    return pages;
  }
}
