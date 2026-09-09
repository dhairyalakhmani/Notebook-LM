import { useEffect, useRef, useState } from "react";
import { findAnyPhrase } from "./highlight.ts";
import { cx } from "../../shared/lib/cx.ts";
import styles from "./PdfPage.module.css";
import type { PDFDocumentProxy } from "pdfjs-dist";

export type ZoomMode =
  { kind: "fit-width" } | { kind: "fit-page" } | { kind: "manual"; scale: number };

export interface PdfPageProps {
  doc: PDFDocumentProxy;
  page: number;
  zoom: ZoomMode;
  phrases: readonly string[];
  available: { width: number; height: number };
}

export function PdfPage({ doc, page, zoom, phrases, available }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paperRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const token = useRef(0);
  const [error, setError] = useState<string | null>(null);

  const zoomKind = zoom.kind;
  const zoomScale = zoom.kind === "manual" ? zoom.scale : 1;

  const phraseKey = phrases.join("\u0000");

  useEffect(() => {
    if (available.width === 0) return; // not measured yet
    const mine = ++token.current;
    let cancelled = false;

    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const pdfPage = await doc.getPage(page);
        if (cancelled || mine !== token.current) return;

        const base = pdfPage.getViewport({ scale: 1 });
        const padding = 26;
        const fitWidth = (available.width - padding) / base.width;
        const fitPage = Math.min(fitWidth, (available.height - padding) / base.height);
        const scale =
          zoomKind === "fit-width"
            ? fitWidth
            : zoomKind === "fit-page"
              ? fitPage
              : fitWidth * zoomScale;

        const viewport = pdfPage.getViewport({ scale: Math.max(0.1, scale) });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);

        const canvas = canvasRef.current;
        const paper = paperRef.current;
        const layer = layerRef.current;
        if (!canvas || !paper || !layer) return;

        paper.style.width = `${viewport.width}px`;
        paper.style.height = `${viewport.height}px`;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        await pdfPage.render({
          canvas,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        }).promise;
        if (cancelled || mine !== token.current) return;

        const text = await pdfPage.getTextContent();
        if (cancelled || mine !== token.current) return;

        const wanted = phraseKey === "" ? [] : phraseKey.split("\u0000");
        const marked = findAnyPhrase(text.items as { str?: string }[], wanted);
        layer.replaceChildren();
        text.items.forEach((raw, index) => {
          const item = raw as { str?: string; transform?: number[]; fontName?: string };
          if (!item.str || item.str.trim() === "" || !item.transform) return;
          const tx = pdfjs.Util.transform(viewport.transform, item.transform);
          const size = Math.abs(tx[3] ?? 10) || 10;
          const span = document.createElement("span");
          span.textContent = item.str;
          span.style.left = `${tx[4]}px`;
          span.style.top = `${(tx[5] ?? 0) - size}px`;
          span.style.fontSize = `${size}px`;
          span.style.fontFamily = item.fontName ?? "sans-serif";
          if (marked.has(index)) {
            span.className = cx(styles.hit);
            span.dataset["hit"] = "";
          }
          layer.appendChild(span);
        });

        const first = layer.querySelector<HTMLElement>("[data-hit]");
        const scroller = paper.parentElement;
        if (first && scroller) {
          const target = paper.offsetTop + first.offsetTop - scroller.clientHeight / 2;
          scroller.scrollTop = Math.max(0, target);
        }
        setError(null);
      } catch (caught) {
        if (cancelled || mine !== token.current) return;
        setError(caught instanceof Error ? caught.message : "This page could not be drawn.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, page, zoomKind, zoomScale, phraseKey, available.width, available.height]);

  if (error) return <p className={styles.loading}>{error}</p>;

  return (
    <div className={styles.paper} ref={paperRef}>
      <canvas className={styles.canvas} ref={canvasRef} aria-hidden="true" />
      <div className={styles.textLayer} ref={layerRef} />
    </div>
  );
}
