import * as cheerio from "cheerio";
import * as config from "../config.ts";
import type { AnyNode, Element } from "domhandler";
import type { TextLine } from "../models.ts";

const DROP = "script, style, noscript, nav, header, footer, aside, form, svg, iframe";

const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

const BLOCKS = new Set([
  "p",
  "div",
  "section",
  "article",
  "blockquote",
  "pre",
  "li",
  "tr",
  "dt",
  "dd",
  "figcaption",
  "caption",
  "address",
  "main",
  "td",
  "th",
  ...Object.keys(HEADINGS),
]);

const NESTED_LISTS = new Set(["ul", "ol"]);

function isElement(node: AnyNode): node is Element {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
  return node.type === "tag";
}

function textOf(node: AnyNode): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
  if (node.type === "text") return node.data;
  if (isElement(node)) return node.children.map(textOf).join("");
  return "";
}

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

  const push = (text: string, headingLevel: number | null, cells?: string[]): void => {
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

      if (tag === "tr") {
        const cells = node.children
          .filter((child): child is Element => isElement(child))
          .filter((child) => ["td", "th"].includes(child.tagName.toLowerCase()))
          .map((cell) => squash(textOf(cell)))
          .filter(Boolean);
        push(cells.join(config.CELL_SEPARATOR), null, cells);
        continue;
      }

      if (tag === "li") {
        const own = squash(textExcluding(node, NESTED_LISTS));
        if (own) push(`- ${own}`, null);
        walk(node.children.filter((c) => isElement(c) && NESTED_LISTS.has(c.tagName)));
        continue;
      }

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

export function htmlTitle(html: string): string | null {
  return cheerio.load(html)("title").first().text().trim() || null;
}
