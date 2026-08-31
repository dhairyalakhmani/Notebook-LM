import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api.js";
import * as config from "../config.ts";
import { DocumentLoader } from "./base.ts";
import type { DocumentPage, TextLine } from "../models.ts";

const BOLD_NAME = /bold|black|heavy|semibold|demi/i;

/** Where standard (non-embedded) fonts live, so resolving fonts doesn't warn. */
const STANDARD_FONTS = new URL("../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).href;

export interface Piece {
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
async function piecesOnPage(
  page: PDFPageProxy,
): Promise<{ pieces: Piece[]; pageWidth: number }> {
  await page.getOperatorList();
  const content = await page.getTextContent();
  // The viewport already carries the page's /Rotate, so composing each run's
  // transform with it gives upright, top-down coordinates for a landscape or
  // sideways-scanned page as readily as for an ordinary one. Doing the y-flip by
  // hand instead only ever worked at rotation 0.
  const viewport = page.getViewport({ scale: 1 });
  const pageWidth = viewport.width;

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
    const tx = Util.transform(viewport.transform, item.transform) as number[];
    const left = tx[4] ?? 0;
    const top = tx[5] ?? 0;
    const fontSize = item.height || Math.hypot(tx[2] ?? 0, tx[3] ?? 0) || 0;
    pieces.push({
      text: item.str,
      left,
      right: left + item.width,
      top,
      fontSize,
      isBold: isBoldFont(item.fontName),
    });
  }
  return { pieces, pageWidth };
}

/**
 * Joins the runs of one line, restoring the spacing the PDF only expressed as
 * coordinates.
 *
 * A PDF is free to place every word by position and emit no space characters at
 * all. Concatenating the runs then yields "RegionRevenueGrowth". So the gap
 * between one run's right edge and the next run's left edge is measured, and
 * scaled against font size:
 *
 *   under WORD_GAP_RATIO  -> the runs are touching, join them directly
 *   over  WORD_GAP_RATIO  -> a space was intended
 *   over  CELL_GAP_RATIO  -> a table cell boundary, which becomes CELL_SEPARATOR
 *                            so the structure layer can still recognise a table
 *
 * Runs the file *did* space explicitly are left alone, so nothing is doubled.
 */
export function joinBand(
  band: Piece[],
  fontSize: number,
): { text: string; cells: string[] } {
  const size = fontSize > 0 ? fontSize : 10;
  // Cells are accumulated alongside the text so the table signal survives
  // cleaning, which collapses runs of whitespace.
  const cells: string[] = [];
  let cell = "";
  let text = "";
  let previous: Piece | null = null;

  for (const piece of band) {
    if (previous) {
      const gap = piece.left - previous.right;
      const spaced = /\s$/.test(text) || /^\s/.test(piece.text);
      if (gap >= size * config.CELL_GAP_RATIO) {
        if (!spaced) text += config.CELL_SEPARATOR;
        cells.push(cell.trim());
        cell = "";
      } else if (!spaced && gap >= size * config.WORD_GAP_RATIO) {
        text += " ";
        cell += " ";
      }
    }
    text += piece.text;
    cell += piece.text;
    previous = piece;
  }
  cells.push(cell.trim());

  return { text, cells: cells.filter(Boolean) };
}

/**
 * Splits a page into columns, left to right.
 *
 * Banding purely by y merges the left and right columns of a two-column page
 * into one line each, which turns every paper and report into nonsense. So a
 * vertical gutter is looked for first: a band of x where no run has any extent.
 *
 * Two guards keep an indented block or a margin note from being mistaken for a
 * column: the gutter must be a real fraction of the page width, and both sides
 * must hold a meaningful share of the page's runs.
 */
export function detectColumns(pieces: Piece[], pageWidth: number): Piece[][] {
  if (pieces.length < 8) return [pieces];

  const width = pageWidth > 0 ? pageWidth : Math.max(...pieces.map((p) => p.right));
  const minGutter = width * config.MIN_GUTTER_RATIO;
  const BIN = 4;
  const bins = Math.ceil(width / BIN);
  const covered = new Uint8Array(bins + 1);

  for (const piece of pieces) {
    const from = Math.max(0, Math.floor(piece.left / BIN));
    const to = Math.min(bins, Math.ceil(piece.right / BIN));
    for (let bin = from; bin <= to; bin++) covered[bin] = 1;
  }

  // Every empty run with text on both sides of it. Collecting all of them - not
  // just the widest - is what makes three and four column layouts work.
  const maxGutter = width * config.MAX_GUTTER_RATIO;
  const boundaries: number[] = [];
  let runStart: number | null = null;
  for (let bin = 0; bin <= bins; bin++) {
    if (covered[bin] === 0) {
      runStart ??= bin;
      continue;
    }
    if (runStart !== null) {
      const gutter = (bin - runStart) * BIN;
      // Too narrow is ordinary word spacing; too wide is a table's cell gap.
      // The upper bound matters as much as the lower one: without it a
      // three-column table reads as a page layout and every row is torn apart.
      if (runStart > 0 && gutter >= minGutter && gutter <= maxGutter) {
        boundaries.push(((runStart + bin) / 2) * BIN);
      }
      runStart = null;
    }
  }
  if (boundaries.length === 0) return [pieces];

  const edges = [...boundaries, Number.POSITIVE_INFINITY];
  const columns: Piece[][] = edges.map(() => []);
  for (const piece of pieces) {
    columns[edges.findIndex((edge) => piece.right <= edge)]!.push(piece);
  }

  // A real column holds a meaningful share of its fair portion of the page. This
  // rejects a margin note or a stray footnote masquerading as a column, and
  // scales correctly however many columns were found.
  const fairShare = pieces.length / columns.length;
  if (columns.some((column) => column.length < fairShare * config.MIN_COLUMN_SHARE)) {
    return [pieces];
  }
  return columns;
}

/** Bands one column's runs into visual lines, top to bottom. */
function bandColumn(pieces: Piece[], pageNumber: number): TextLine[] {
  const sorted = [...pieces].sort((a, b) => a.top - b.top);

  const bands: Piece[][] = [];
  let bandTop = Number.NaN;
  for (const piece of sorted) {
    const last = bands.at(-1);
    // Tolerance scales with the text being measured: 3pt is generous for 9pt
    // body text and too tight for an 18pt heading whose runs sit further apart.
    const tolerance = Math.max(
      config.LINE_BAND_MIN,
      piece.fontSize * config.LINE_BAND_RATIO,
    );
    if (last && Math.abs(piece.top - bandTop) <= tolerance) {
      last.push(piece);
    } else {
      bands.push([piece]);
      bandTop = piece.top;
    }
  }

  const lines: TextLine[] = [];
  for (const band of bands) {
    band.sort((a, b) => a.left - b.left);
    // Judge size and weight from the real words only — the spaces between them
    // often carry a different font and would skew both.
    const words = band.filter((p) => p.text.trim());
    if (words.length === 0) continue;
    // the longest run decides the line's font size; a stray superscript should not
    const dominant = words.reduce((a, b) => (b.text.length > a.text.length ? b : a));

    const joined = joinBand(band, dominant.fontSize);
    const text = joined.text.trim();
    if (!text) continue;

    lines.push({
      text,
      pageNumber,
      // Two or more cells means the run gaps really did look like a table row.
      ...(joined.cells.length >= 2 ? { cells: joined.cells } : {}),
      fontSize: Math.round(dominant.fontSize * 10) / 10,
      isBold: words.every((p) => p.isBold),
      // Geometry is what lets the structure layer find paragraph breaks, columns
      // and indented lists. Dropping it here is why a flat line list cannot be
      // turned back into a document.
      top: Math.round(band[0]!.top * 10) / 10,
      left: Math.round(Math.min(...band.map((p) => p.left)) * 10) / 10,
      right: Math.round(Math.max(...band.map((p) => p.right)) * 10) / 10,
    });
  }
  return lines;
}

/**
 * Group pieces into visual lines: split into columns, then band each column by
 * y and read it left to right. Columns are emitted in reading order, so a
 * two-column page comes out as the left column followed by the right.
 */
export function linesFromPieces(
  pieces: Piece[],
  pageNumber: number,
  pageWidth = 0,
): TextLine[] {
  if (pieces.length === 0) return [];
  return detectColumns(pieces, pageWidth).flatMap((column) =>
    bandColumn(column, pageNumber),
  );
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
        const { pieces, pageWidth } = await piecesOnPage(page);
        const lines = linesFromPieces(pieces, pageNumber, pageWidth);
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
