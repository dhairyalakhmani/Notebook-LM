import * as cheerio from "cheerio";
import * as config from "../config.ts";
import type { AnyNode, Element, Text } from "domhandler";
import type { TextLine } from "../models.ts";

/**
 * HTML -> TextLine[], shared by the HTML and DOCX loaders.
 *
 * DOCX goes through here because mammoth converts Word's real heading styles
 * into `<h1>`-`<h6>`, which is exactly the signal this walker reads. One
 * converter therefore serves both formats, and any later format that can be
 * rendered to simple HTML.
 *
 * The important difference from the PDF path: these formats *state* their
 * structure, so nothing is inferred. `headingLevel` comes from the tag,
 * `breakBefore` from block elements, list markers from `<li>`, and cell
 * separators from `<td>`. That is why the same downstream pipeline produces an
 * exact hierarchy for a .docx and a reconstructed one for a .pdf.
 *
 * Cheerio is used to parse; the walk itself is over plain domhandler nodes,
 * which keeps it simple to read and fully typed.
 */

/** Removed outright: none of it is document content. */
const DROP = "script, style, noscript, nav, header, footer, aside, form, svg, iframe";

const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** Elements that always start a line of their own. */
const BLOCKS = new Set([
  "p", "div", "section", "article", "blockquote", "pre", "li", "tr",
  "dt", "dd", "figcaption", "caption", "address", "main", "td", "th",
  ...Object.keys(HEADINGS),
]);

const NESTED_LISTS = new Set(["ul", "ol"]);

function isElement(node: AnyNode): node is Element {
  return node.type === "tag";
}

function textOf(node: AnyNode): string {
  if (node.type === "text") return (node as Text).data;
  if (isElement(node)) return node.children.map(textOf).join("");
  return "";
}

/** Text of an element, skipping whole child subtrees by tag name. */
function textExcluding(element: Element, exclude: Set<string>): string {
  return element.children
    .map((child) =>
      isElement(child) && exclude.has(child.tagName.toLowerCase()) ? "" : textOf(child),
    )
    .join("");
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface HtmlToLinesOptions {
  pageNumber?: number;
}

export function htmlToLines(html: string, options: HtmlToLinesOptions = {}): TextLine[] {
  const $ = cheerio.load(html);
  $(DROP).remove();

  const pageNumber = options.pageNumber ?? 1;
  const lines: TextLine[] = [];

  /** `cells` marks the line as a table row. It is carried as data because
   *  cleaning collapses whitespace and would erase a spacing-based signal. */
  const push = (
    text: string,
    headingLevel: number | null,
    cells?: string[],
  ): void => {
    const clean = cells ? text.trim() : squash(text);
    if (!clean) return;
    lines.push({
      text: clean,
      pageNumber,
      breakBefore: true,
      ...(headingLevel != null ? { headingLevel } : {}),
      ...(cells && cells.length >= 2 ? { cells } : {}),
    });
  };

  const walk = (nodes: AnyNode[]): void => {
    for (const node of nodes) {
      if (!isElement(node)) continue;
      const tag = node.tagName.toLowerCase();

      if (tag in HEADINGS) {
        push(textOf(node), HEADINGS[tag]!);
        continue;
      }

      // A row becomes one line with cell separators, so the structure layer
      // recognises a table the same way it does for a PDF.
      if (tag === "tr") {
        const cells = node.children
          .filter((child): child is Element => isElement(child))
          .filter((child) => ["td", "th"].includes(child.tagName.toLowerCase()))
          .map((cell) => squash(textOf(cell)))
          .filter(Boolean);
        push(cells.join(config.CELL_SEPARATOR), null, cells);
        continue;
      }

      // A leading dash makes LIST_MARKER match downstream, so consecutive items
      // group into one list block instead of becoming separate paragraphs.
      if (tag === "li") {
        const own = squash(textExcluding(node, NESTED_LISTS));
        if (own) push(`- ${own}`, null);
        walk(node.children.filter((c) => isElement(c) && NESTED_LISTS.has(c.tagName)));
        continue;
      }

      // A block whose children are all inline is one line. Otherwise recurse, so
      // nested structure is not flattened into a single paragraph.
      const hasBlockChild = node.children.some(
        (child) => isElement(child) && BLOCKS.has(child.tagName.toLowerCase()),
      );
      if (BLOCKS.has(tag) && !hasBlockChild) {
        push(textOf(node), null);
        continue;
      }
      walk(node.children);
    }
  };

  const root = $.root()[0];
  walk(root ? root.children : []);
  return lines;
}

/** The document's stated title, if any. */
export function htmlTitle(html: string): string | null {
  return cheerio.load(html)("title").first().text().trim() || null;
}
