import { normalizePages } from "./normalize.ts";
import { stripFurniture } from "./pageFurniture.ts";
import type { DocumentPage } from "../models.ts";

export { normalizeLine, normalizePages } from "./normalize.ts";
export { findFurniture, stripFurniture } from "./pageFurniture.ts";

export function cleanPages(pages: DocumentPage[]): DocumentPage[] {
  return normalizePages(stripFurniture(pages));
}
