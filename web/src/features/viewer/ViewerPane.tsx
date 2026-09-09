import { useEffect, useRef, useState } from "react";
import { PdfPage } from "./PdfPage.tsx";
import { TextPreview } from "./TextPreview.tsx";
import { usePdfDocument } from "./usePdfDocument.ts";
import { useViewerParams } from "./useViewerParams.ts";
import { useViewerTarget } from "./useViewerTarget.ts";
import { messages } from "../../shared/messages.ts";
import { Button, IconButton, VisuallyHidden } from "../../shared/ui/primitives.tsx";
import { StateCard } from "../../shared/ui/StateCard.tsx";
import styles from "./PdfPage.module.css";
import layout from "../../app/layout.module.css";
import type { SourceDto, TurnDto } from "../../types.ts";

export function ViewerPane({
  sources,
  turns,
}: {
  notebook: string;
  sources: readonly SourceDto[];
  turns: readonly TurnDto[];
}) {
  const { params, setParams } = useViewerParams();
  const target = useViewerTarget(sources, turns);
  const stage = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });

  const isPdf = target.source?.kind === "pdf";
  const pdf = usePdfDocument(isPdf ? (target.source?.fileUrl ?? null) : null);

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setAvailable((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const pages = pdf.status === "ready" ? pdf.pages : (target.source?.pages ?? 1);

  const header = (
    <div className={layout.paneHead}>
      <span>{target.source ? target.source.title.slice(0, 60) : "Document"}</span>
      {target.source ? (
        <>
          <span style={{ marginLeft: "auto" }} />
          <IconButton
            icon="chevronLeft"
            label="Previous page"
            disabled={target.page <= 1}
            onClick={() => setParams({ page: target.page - 1, cite: null }, { replace: true })}
          />
          <span className={styles.pageLabel}>
            p. {target.page}
            {pages > 1 ? ` / ${pages}` : ""}
            {target.citation ? " · cited here" : ""}
          </span>
          <IconButton
            icon="chevronRight"
            label="Next page"
            disabled={target.page >= pages}
            onClick={() => setParams({ page: target.page + 1, cite: null }, { replace: true })}
          />
          <IconButton
            icon={params.zoom.kind === "fit-page" ? "panelRight" : "search"}
            label={params.zoom.kind === "fit-page" ? "Fit width" : "Fit page"}
            onClick={() =>
              setParams(
                {
                  zoom:
                    params.zoom.kind === "fit-page" ? { kind: "fit-width" } : { kind: "fit-page" },
                },
                { replace: true },
              )
            }
          />
        </>
      ) : null}
    </div>
  );

  return (
    <>
      {header}
      <div className={styles.stage} ref={stage} tabIndex={-1} data-scroll>
        {target.phrases.length > 0 ? (
          <VisuallyHidden>Cited on this page: {target.phrases.join(" ")}</VisuallyHidden>
        ) : null}

        {renderBody()}
      </div>
    </>
  );

  function renderBody() {
    if (target.missing) {
      return (
        <StateCard message={messages.sourceRemoved} tone="warn">
          <Button variant="quiet" onClick={() => setParams({ doc: null, cite: null, page: null })}>
            Close
          </Button>
        </StateCard>
      );
    }

    if (!target.source) return <StateCard message={messages.viewerIdle} />;

    if (target.source.fileUrl === null) {
      return <StateCard message={messages.sourceUnavailable} tone="warn" />;
    }

    if (!isPdf) {
      return <TextPreview source={target.source} phrases={target.phrases} />;
    }

    if (pdf.status === "loading") return <StateCard message={messages.viewerLoading} />;

    if (pdf.status === "unavailable") {
      return (
        <StateCard message={messages.sourceUnavailable} tone="warn" said={pdf.reason || null} />
      );
    }

    return (
      <PdfPage
        key={target.source.id}
        doc={pdf.doc}
        page={target.page}
        zoom={params.zoom}
        phrases={target.phrases}
        available={available}
      />
    );
  }
}
