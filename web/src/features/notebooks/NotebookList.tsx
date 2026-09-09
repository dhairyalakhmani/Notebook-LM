import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useCreateNotebook, useDeleteNotebook, useNotebooks } from "./api.ts";
import { cx } from "../../shared/lib/cx.ts";
import { plural } from "../../shared/lib/format.ts";
import { messages } from "../../shared/messages.ts";
import { Button, IconButton, SkeletonList } from "../../shared/ui/primitives.tsx";
import { Icon } from "../../shared/ui/Icon.tsx";
import { useToast } from "../../shared/ui/Toast.tsx";
import styles from "../../app/layout.module.css";

export function NotebookList({ current }: { current: string }) {
  const notebooks = useNotebooks();
  const create = useCreateNotebook();
  const remove = useDeleteNotebook();
  const navigate = useNavigate();
  const toast = useToast();
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (naming) nameField.current?.focus();
  }, [naming]);

  const submit = () => {
    const name = draft.trim();
    if (name === "") {
      setNaming(false);
      return;
    }
    create.mutate(name, {
      onSuccess: (created) => {
        setNaming(false);
        setDraft("");
        void navigate(`/n/${encodeURIComponent(created.name)}`);
      },
      onError: () => setNaming(true),
    });
  };

  const onDelete = (name: string) => {
    setConfirming(null);
    remove.mutate(name, {
      onSuccess: (result) => {
        toast(
          `Deleted ${name} — ${plural(result.sourcesReleased, "source")} released, ` +
            `${plural(result.messagesRemoved, "message")} deleted.`,
          "success",
        );
        // Only leave if the notebook you were reading is the one that went.
        if (name === current) void navigate("/");
      },
    });
  };

  return (
    <section className={cx(styles.railSection, styles.railNotebooks)} aria-label="Notebooks">
      <div className={styles.paneHead}>
        <span>Notebooks</span>
        <span className={styles.barSpacer} />
        <IconButton
          icon="plus"
          label="New notebook"
          onClick={() => {
            setNaming(true);
            setDraft("");
          }}
        />
      </div>

      {naming ? (
        <div className={styles.newNotebook}>
          <Icon name="book" size={12} />
          <input
            ref={nameField}
            className={styles.newNotebookInput}
            value={draft}
            placeholder="Name it, then press Enter"
            aria-label="New notebook name"
            maxLength={64}
            disabled={create.isPending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setNaming(false);
                setDraft("");
              }
            }}
            onBlur={() => {
              if (draft.trim() === "" && !create.isPending) setNaming(false);
            }}
          />
        </div>
      ) : null}

      <div className={styles.railScroll} data-scroll>
        {notebooks.isPending ? <SkeletonList rows={2} /> : null}

        {notebooks.isError ? (
          <p className={styles.railNote}>{messages.notebooksFailed.title}</p>
        ) : null}

        {notebooks.data?.map((notebook) => (
          <div
            key={notebook.name}
            className={cx(
              styles.notebookRow,
              notebook.name === current && styles.notebookRowCurrent,
            )}
          >
            <Link
              to={`/n/${encodeURIComponent(notebook.name)}`}
              className={styles.notebookMain}
              {...(notebook.name === current ? { "aria-current": "page" as const } : {})}
            >
              <Icon name="book" size={12} />
              <span className={styles.notebookName}>{notebook.name}</span>
              <span className={styles.notebookCount}>
                {notebook.sources === 0 ? "empty" : plural(notebook.sources, "source")}
              </span>
            </Link>

            {confirming === notebook.name ? (
              <div className={styles.confirm}>
                <Button variant="danger" onClick={() => onDelete(notebook.name)}>
                  {messages.notebookDelete.action}
                </Button>
                <Button variant="quiet" onClick={() => setConfirming(null)}>
                  Keep
                </Button>
              </div>
            ) : (
              <IconButton
                icon="trash"
                label={`Delete ${notebook.name}`}
                title={messages.notebookDelete.body}
                onClick={() => setConfirming(notebook.name)}
              />
            )}
          </div>
        ))}

        {notebooks.data?.length === 0 && !naming ? (
          <p className={styles.railNote}>{messages.notebooksEmpty.body}</p>
        ) : null}
      </div>
    </section>
  );
}
