import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useDeleteSource } from "./api.ts";
import { UploadPanel } from "./UploadPanel.tsx";
import { useViewerParams } from "../viewer/useViewerParams.ts";
import { cx } from "../../shared/lib/cx.ts";
import { formatBytes, plural } from "../../shared/lib/format.ts";
import { messages } from "../../shared/messages.ts";
import { Button, IconButton } from "../../shared/ui/primitives.tsx";
import { Icon } from "../../shared/ui/Icon.tsx";
import styles from "../../app/layout.module.css";
import type { Scope } from "./useScope.ts";
import type { SourceDto } from "../../types.ts";

export function SourceRail({
  notebook,
  sources,
  scope,
}: {
  notebook: string;
  sources: readonly SourceDto[];
  scope: Scope;
}) {
  const { documentId } = useParams();
  const navigate = useNavigate();
  const { params, setParams } = useViewerParams();
  const remove = useDeleteSource(notebook);
  const [confirming, setConfirming] = useState<string | null>(null);

  const onDelete = (id: string) => {
    setConfirming(null);
    if (params.doc === id) setParams({ doc: null, page: null, cite: null }, { replace: true });
    if (documentId === id) void navigate(`/n/${encodeURIComponent(notebook)}`, { replace: true });
    remove.mutate(id);
  };

  return (
    <section className={cx(styles.railSection, styles.railSources)} aria-label="Sources">
      <div className={styles.paneHead}>
        <span>Sources</span>
      </div>

      <UploadPanel notebook={notebook} />

      {sources.length === 0 ? (
        <p className={styles.railNote}>{messages.sourcesEmpty.body}</p>
      ) : null}

      {sources.length > 0 ? (
        <div className={styles.scopeBar}>
          <input
            type="checkbox"
            className={styles.scopeBox}
            checked={scope.all}
            ref={(node) => {
              if (node) node.indeterminate = !scope.all && !scope.none;
            }}
            onChange={() => (scope.all ? scope.selectNone() : scope.selectAll())}
            aria-label={scope.all ? "Unselect every source" : "Select every source"}
          />
          <span>
            {scope.none
              ? "no sources searched"
              : `${scope.ids.length} of ${sources.length} searched`}
          </span>
        </div>
      ) : null}

      <div className={styles.railScroll} data-scroll>
        {sources.map((source) => {
          const current = source.id === documentId;
          return (
            <div
              key={source.id}
              className={cx(styles.sourceRow, current && styles.sourceRowCurrent)}
            >
              <input
                type="checkbox"
                className={styles.scopeBox}
                checked={scope.has(source.id)}
                onChange={() => scope.toggle(source.id)}
                aria-label={`Search ${source.title}`}
              />
              <Link
                to={`/n/${encodeURIComponent(notebook)}/source/${source.id}`}
                className={styles.sourceMain}
                {...(current ? { "aria-current": "page" as const } : {})}
              >
                <div className={styles.sourceTitle}>{source.title}</div>
                <div className={styles.sourceMeta}>
                  {source.kind.toUpperCase()} · {plural(source.pages, "page")} ·{" "}
                  {formatBytes(source.bytes)}
                  {source.fileUrl === null ? (
                    <>
                      {" · "}
                      <span className={styles.sourceUnavailable}>
                        <Icon name="warn" size={12} /> not on disk
                      </span>
                    </>
                  ) : null}
                </div>
              </Link>

              {confirming === source.id ? (
                <div className={styles.confirm}>
                  <Button variant="danger" onClick={() => onDelete(source.id)}>
                    Remove
                  </Button>
                  <Button variant="quiet" onClick={() => setConfirming(null)}>
                    Keep
                  </Button>
                </div>
              ) : (
                <IconButton
                  icon="trash"
                  label={`Remove ${source.title}`}
                  onClick={() => setConfirming(source.id)}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
