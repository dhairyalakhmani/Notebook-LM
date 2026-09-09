import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import type { ZoomMode } from "./PdfPage.tsx";

export interface ViewerParams {
  doc: string | null;
  page: number | null;
  cite: string | null;
  zoom: ZoomMode;
}

const DOCUMENT_ID = /^[0-9a-f]{12}$/;
const CITE = /^t\d+\.\d+$/;

function parsePage(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(1, Math.trunc(value));
}

function parseZoom(raw: string | null): ZoomMode {
  if (raw === "fit-page") return { kind: "fit-page" };
  if (raw && raw !== "fit-width") {
    const scale = Number(raw);
    if (Number.isFinite(scale) && scale > 0) {
      return { kind: "manual", scale: Math.min(6, Math.max(0.25, scale)) };
    }
  }
  return { kind: "fit-width" };
}

export function serialiseZoom(zoom: ZoomMode): string | null {
  if (zoom.kind === "fit-width") return null; // the default needs no param
  if (zoom.kind === "fit-page") return "fit-page";
  return String(Number(zoom.scale.toFixed(3)));
}

export function useViewerParams(): {
  params: ViewerParams;
  setParams: (patch: Partial<ViewerParams>, options?: { replace?: boolean }) => void;
} {
  const [search, setSearch] = useSearchParams();

  const params = useMemo<ViewerParams>(() => {
    const doc = search.get("doc");
    const cite = search.get("cite");
    return {
      doc: doc && DOCUMENT_ID.test(doc) ? doc : null,
      page: parsePage(search.get("page")),
      cite: cite && CITE.test(cite) ? cite : null,
      zoom: parseZoom(search.get("zoom")),
    };
  }, [search]);

  const setParams = useCallback(
    (patch: Partial<ViewerParams>, options: { replace?: boolean } = {}) => {
      setSearch(
        (current) => {
          const next = new URLSearchParams(current);
          const write = (key: string, value: string | null) => {
            if (value === null) next.delete(key);
            else next.set(key, value);
          };
          if ("doc" in patch) write("doc", patch.doc ?? null);
          if ("page" in patch) write("page", patch.page === null ? null : String(patch.page));
          if ("cite" in patch) write("cite", patch.cite ?? null);
          if ("zoom" in patch) write("zoom", patch.zoom ? serialiseZoom(patch.zoom) : null);
          return next;
        },
        { replace: options.replace ?? false },
      );
    },
    [setSearch],
  );

  return { params, setParams };
}

export function citationSearch(
  current: URLSearchParams,
  citation: { sourceId: string | null; page: number | null },
  cite: string,
): string {
  const next = new URLSearchParams(current);
  if (citation.sourceId) next.set("doc", citation.sourceId);
  if (citation.page !== null) next.set("page", String(citation.page));
  next.set("cite", cite);
  return `?${next.toString()}`;
}
