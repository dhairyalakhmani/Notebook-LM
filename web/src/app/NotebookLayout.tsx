import { useMemo, useState } from "react";
import { Outlet, useNavigate, useParams } from "react-router";
import { useNotebook } from "../features/notebooks/api.ts";
import { CommandPalette } from "../features/notebooks/CommandPalette.tsx";
import { NotebookList } from "../features/notebooks/NotebookList.tsx";
import { SourceRail } from "../features/sources/SourceRail.tsx";
import { useScope } from "../features/sources/useScope.ts";
import { ViewerPane } from "../features/viewer/ViewerPane.tsx";
import { useViewerParams } from "../features/viewer/useViewerParams.ts";
import { shortcutLabel, useKeymap } from "./useKeymap.ts";
import { cx } from "../shared/lib/cx.ts";
import { useMediaQuery } from "../shared/lib/useMediaQuery.ts";
import { useStored } from "../shared/lib/useLocalStorage.ts";
import { messages } from "../shared/messages.ts";
import { Button, IconButton, SkeletonList } from "../shared/ui/primitives.tsx";
import { QueryState } from "../shared/ui/QueryState.tsx";
import { Splitter } from "../shared/ui/Splitter.tsx";
import { StateCard } from "../shared/ui/StateCard.tsx";
import styles from "./layout.module.css";
import type { Shortcut } from "./useKeymap.ts";
import type { NotebookDto } from "../types.ts";

const NARROW = "(max-width: 940px)";
const RAIL = { min: 200, max: 480, initial: 268 };
const DOC = { min: 320, max: 900, initial: 460 };

type Tab = "sources" | "centre" | "document";

export function NotebookLayout() {
  const params = useParams();
  const notebook = params.notebook ?? "";
  const query = useNotebook(notebook);

  const narrow = useMediaQuery(NARROW);
  const [railWidth, setRailWidth] = useStored("railW", RAIL.initial);
  const [docWidth, setDocWidth] = useStored("docW", DOC.initial);
  const [railOff, setRailOff] = useStored("railOff", false);
  const [docOff, setDocOff] = useStored("docOff", false);
  const [tab, setTab] = useState<Tab>("centre");
  const [palette, setPalette] = useState(false);

  const navigate = useNavigate();
  const { params: viewer, setParams: setViewer } = useViewerParams();
  const pageCount = query.data?.sources.find((source) => source.id === viewer.doc)?.pages ?? 1;

  const shortcuts = useMemo<Shortcut[]>(
    () => [
      { key: "k", meta: true, describe: "Go to a notebook", run: () => setPalette(true) },
      {
        key: "/",
        describe: "Ask a question",
        run: () => document.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus(),
      },
      { key: "[", describe: "Toggle the sources", run: () => setRailOff(!railOff) },
      { key: "]", describe: "Toggle the document", run: () => setDocOff(!docOff) },
      {
        key: "Escape",
        describe: "Back to the conversation",
        run: () => {
          if (params.documentId) void navigate(`/n/${encodeURIComponent(notebook)}`);
        },
      },
      {
        key: "ArrowRight",
        describe: "Next page",
        run: () =>
          setViewer(
            { page: Math.min(pageCount, (viewer.page ?? 1) + 1), cite: null },
            { replace: true },
          ),
      },
      {
        key: "ArrowLeft",
        describe: "Previous page",
        run: () =>
          setViewer({ page: Math.max(1, (viewer.page ?? 1) - 1), cite: null }, { replace: true }),
      },
      {
        key: "0",
        describe: "Fit the page",
        run: () => setViewer({ zoom: { kind: "fit-page" } }, { replace: true }),
      },
      {
        key: "1",
        describe: "Fit the width",
        run: () => setViewer({ zoom: { kind: "fit-width" } }, { replace: true }),
      },
    ],
    [
      railOff,
      docOff,
      setRailOff,
      setDocOff,
      navigate,
      notebook,
      params.documentId,
      pageCount,
      setViewer,
      viewer.page,
    ],
  );

  useKeymap(shortcuts);

  return (
    <>
      <div className={styles.bar} style={{ borderTop: "none" }}>
        <h1 className={styles.notebookTitle}>{notebook}</h1>
        <div className={styles.barSpacer} />
        <span className={styles.shortcuts} aria-hidden="true">
          <kbd className={styles.key}>{shortcutLabel(shortcuts[0]!)}</kbd>
          <span>notebooks</span>
          <kbd className={styles.key}>/</kbd>
          <span>ask</span>
        </span>
        {query.data ? (
          <span className={styles.meta}>
            {query.data.sources.length} source{query.data.sources.length === 1 ? "" : "s"} ·{" "}
            {query.data.totalTurns} turn{query.data.totalTurns === 1 ? "" : "s"}
          </span>
        ) : null}
        {!narrow ? (
          <>
            <IconButton
              icon="panelLeft"
              label={railOff ? "Show sources" : "Hide sources"}
              aria-pressed={!railOff}
              onClick={() => setRailOff(!railOff)}
            />
            <IconButton
              icon="panelRight"
              label={docOff ? "Show document" : "Hide document"}
              aria-pressed={!docOff}
              onClick={() => setDocOff(!docOff)}
            />
          </>
        ) : null}
      </div>

      {narrow ? (
        <div className={styles.tabs} role="tablist" aria-label="Panes">
          {(["sources", "centre", "document"] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              className={cx(styles.tab, tab === name && styles.tabCurrent)}
              onClick={() => setTab(name)}
            >
              {name === "centre" ? "Conversation" : name === "sources" ? "Notebooks" : "Document"}
            </button>
          ))}
        </div>
      ) : null}

      <CommandPalette open={palette} onClose={() => setPalette(false)} current={notebook} />

      <QueryState
        query={query}
        loading={<SkeletonList rows={4} />}
        empty={<StateCard message={messages.notebookMissing} />}
        error={(failure, retry) => (
          <StateCard
            message={
              failure.kind === "not-found" ? messages.notebookMissing : messages.sourcesFailed
            }
            tone={failure.kind === "not-found" ? "neutral" : "danger"}
          >
            <Button variant="primary" onClick={retry}>
              {messages.sourcesFailed.action}
            </Button>
          </StateCard>
        )}
      >
        {(data) => (
          <NotebookPanes
            notebook={notebook}
            data={data}
            narrow={narrow}
            tab={tab}
            railWidth={railWidth}
            docWidth={docWidth}
            railOff={railOff}
            docOff={docOff}
            onRailWidth={setRailWidth}
            onDocWidth={setDocWidth}
          />
        )}
      </QueryState>
    </>
  );
}

function NotebookPanes({
  notebook,
  data,
  narrow,
  tab,
  railWidth,
  docWidth,
  railOff,
  docOff,
  onRailWidth,
  onDocWidth,
}: {
  notebook: string;
  data: NotebookDto;
  narrow: boolean;
  tab: Tab;
  railWidth: number;
  docWidth: number;
  railOff: boolean;
  docOff: boolean;
  onRailWidth: (next: number) => void;
  onDocWidth: (next: number) => void;
}) {
  const scope = useScope(notebook, data.sources);

  const showRail = narrow ? tab === "sources" : !railOff;
  const showCentre = narrow ? tab === "centre" : true;
  const showDoc = narrow ? tab === "document" : !docOff;

  return (
    <div className={styles.panes}>
      {showRail ? (
        <aside
          className={cx(styles.pane, styles.rail)}
          style={narrow ? { flex: "1 1 auto" } : { width: railWidth }}
          aria-label="Notebooks and sources"
        >
          <div className={styles.paneBody}>
            <NotebookList current={notebook} />
            <SourceRail notebook={notebook} sources={data.sources} scope={scope} />
          </div>
        </aside>
      ) : null}

      {showRail && !narrow ? (
        <Splitter
          label="Sources pane width"
          value={railWidth}
          min={RAIL.min}
          max={RAIL.max}
          onChange={onRailWidth}
        />
      ) : null}

      {showCentre ? (
        <main className={cx(styles.pane, styles.centre)} aria-label="Conversation">
          <Outlet context={{ notebook, data, scope }} />
        </main>
      ) : null}

      {showDoc && !narrow ? (
        <Splitter
          label="Document pane width"
          value={docWidth}
          min={DOC.min}
          max={DOC.max}
          onChange={(next) => onDocWidth(DOC.max + DOC.min - next)}
        />
      ) : null}

      {showDoc ? (
        <aside
          className={cx(styles.pane, styles.viewer)}
          style={narrow ? { flex: "1 1 auto" } : { width: docWidth }}
          aria-label="Document"
        >
          <ViewerPane notebook={notebook} sources={data.sources} turns={data.turns} />
        </aside>
      ) : null}
    </div>
  );
}
