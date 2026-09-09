import { useEffect, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";

export type PdfState =
  | { status: "loading" }
  | { status: "ready"; doc: PDFDocumentProxy; pages: number }
  | { status: "unavailable"; reason: string };

function initialFor(url: string | null): PdfState {
  return url ? { status: "loading" } : { status: "unavailable", reason: "" };
}

export function usePdfDocument(url: string | null): PdfState {
  const [entry, setEntry] = useState<{ url: string | null; state: PdfState }>(() => ({
    url,
    state: initialFor(url),
  }));

  if (entry.url !== url) setEntry({ url, state: initialFor(url) });

  useEffect(() => {
    if (!url) return;

    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;

    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const worker = await import("pdfjs-dist/build/pdf.worker.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

        task = pdfjs.getDocument({ url });
        const doc = await task.promise;
        if (cancelled) return;
        setEntry({ url, state: { status: "ready", doc, pages: doc.numPages } });
      } catch (error) {
        if (cancelled) return;
        setEntry({
          url,
          state: {
            status: "unavailable",
            reason: error instanceof Error ? error.message : "The file could not be read.",
          },
        });
      }
    })();

    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [url]);

  return entry.url === url ? entry.state : initialFor(url);
}
