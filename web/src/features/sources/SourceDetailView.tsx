import { Link, useParams } from "react-router";
import { useOutline } from "./api.ts";
import { useNotebookContext } from "../../app/context.ts";
import { useViewerParams } from "../viewer/useViewerParams.ts";
import { clampDepth, formatBytes, formatDate, formatMs, plural } from "../../shared/lib/format.ts";
import { messages } from "../../shared/messages.ts";
import { Button, SkeletonList } from "../../shared/ui/primitives.tsx";
import { QueryState } from "../../shared/ui/QueryState.tsx";
import { StateCard } from "../../shared/ui/StateCard.tsx";
import styles from "./sources.module.css";

export function SourceDetailView() {
  const { documentId } = useParams();
  const { notebook, data } = useNotebookContext();
  const { setParams } = useViewerParams();

  const source = data.sources.find((candidate) => candidate.id === documentId);
  const outline = useOutline(documentId ?? null);

  if (!source) {
    return (
      <div className={styles.detail} data-scroll>
        <StateCard message={messages.sourceRemoved} tone="warn">
          <Link to={`/n/${encodeURIComponent(notebook)}`}>
            <Button variant="primary">Back to the conversation</Button>
          </Link>
        </StateCard>
      </div>
    );
  }

  const stats = source.stats;

  return (
    <div className={styles.detail} data-scroll>
      <header className={styles.detailHead}>
        <h1 className={styles.detailTitle}>{source.title}</h1>
        <p className={styles.detailMeta}>
          {source.filename}
          <br />
          {source.kind.toUpperCase()} · {plural(source.pages, "page")} · {formatBytes(source.bytes)}{" "}
          · added {formatDate(source.addedAt)}
        </p>
      </header>

      <section className={styles.statsBlock} aria-label="What ingesting this produced">
        {stats === null ? (
          <p className={styles.detailMeta}>
            No ingest measurements were recorded for this source. Re-add it to collect them.
          </p>
        ) : (
          <>
            <dl className={styles.stats}>
              <Stat label="blocks" value={stats.blocks} />
              <Stat label="units" value={stats.units} />
              <Stat label="sections" value={stats.sections} />
              <Stat label="passages" value={stats.passages} />
            </dl>
            <ul className={styles.stages}>
              {stats.stages.map((stage) => (
                <li key={stage.stage}>
                  <span>{stage.stage}</span>
                  <span className={styles.stageTime}>{formatMs(stage.ms)}</span>
                </li>
              ))}
            </ul>
            <p className={styles.detailMeta}>
              embedded with {stats.embedModel} · structure score {stats.structureScore.toFixed(2)} ·
              segmented by {stats.segmenters.join(" + ")}
              {stats.tokenSplitChunks > 0 ? (
                <>
                  {" · "}
                  <strong className={styles.warnText}>
                    {plural(stats.tokenSplitChunks, "chunk")} had to be cut on a token count
                  </strong>
                </>
              ) : null}
            </p>
          </>
        )}
      </section>

      <section aria-label="Sections">
        <h2 className={styles.sectionHeading}>Sections</h2>
        <QueryState
          query={outline}
          isEmpty={(sections) => sections.length === 0}
          loading={<SkeletonList rows={5} />}
          empty={<StateCard message={messages.outlineEmpty} centred={false} />}
          error={(failure, retry) => (
            <StateCard message={messages.sourcesFailed} tone="danger" said={failure.message}>
              <Button variant="primary" onClick={retry}>
                Try again
              </Button>
            </StateCard>
          )}
        >
          {(sections) => (
            <ol className={styles.outline}>
              {sections.map((section, index) => (
                <li
                  key={`${section.number ?? ""}-${section.title}-${index}`}
                  style={{ paddingLeft: `calc(${clampDepth(section.depth) - 1} * var(--s3))` }}
                >
                  <button
                    type="button"
                    className={styles.outlineRow}
                    disabled={section.page === null}
                    onClick={() => setParams({ doc: source.id, page: section.page, cite: null })}
                  >
                    {section.number ? (
                      <span className={styles.outlineNumber}>{section.number}</span>
                    ) : null}
                    <span className={styles.outlineTitle}>{section.title}</span>
                    {section.page !== null ? (
                      <span className={styles.outlinePage}>p. {section.page}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </QueryState>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.stat}>
      <dt>{label}</dt>
      <dd>{value.toLocaleString()}</dd>
    </div>
  );
}
