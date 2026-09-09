import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useNotebooks } from "./api.ts";
import { cx } from "../../shared/lib/cx.ts";
import { plural } from "../../shared/lib/format.ts";
import { Icon } from "../../shared/ui/Icon.tsx";
import styles from "../../app/layout.module.css";

/* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-autofocus */

export function CommandPalette({
  open,
  onClose,
  current,
}: {
  open: boolean;
  onClose: () => void;
  current: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const notebooks = useNotebooks();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = notebooks.data ?? [];
    if (needle === "") return all;
    return all.filter((notebook) => notebook.name.toLowerCase().includes(needle));
  }, [notebooks.data, query]);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      setQuery("");
      setHighlighted(0);
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  // Keep the highlight inside the list as it filters.
  const index = Math.min(highlighted, Math.max(0, matches.length - 1));

  const go = (name: string) => {
    onClose();
    void navigate(`/n/${encodeURIComponent(name)}`);
  };

  return (
    <dialog
      ref={dialog}
      className={styles.palette}
      aria-label="Go to a notebook"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      {open ? (
        <div className={styles.paletteInner}>
          <div className={styles.paletteSearch}>
            <Icon name="search" />
            <input
              autoFocus
              className={styles.paletteInput}
              value={query}
              placeholder="Go to a notebook…"
              aria-label="Notebook name"
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlighted(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setHighlighted((value) => Math.min(value + 1, matches.length - 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setHighlighted((value) => Math.max(value - 1, 0));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const chosen = matches[index];
                  if (chosen) go(chosen.name);
                }
              }}
            />
          </div>

          <ul className={styles.paletteList} data-scroll role="listbox" aria-label="Notebooks">
            {matches.map((notebook, at) => (
              <li key={notebook.name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={at === index}
                  className={cx(styles.menuItem, at === index && styles.menuItemCurrent)}
                  onMouseEnter={() => setHighlighted(at)}
                  onClick={() => go(notebook.name)}
                >
                  <Icon name="book" />
                  <span>{notebook.name}</span>
                  <span className={styles.menuCount}>
                    {plural(notebook.sources, "source")}
                    {notebook.name === current ? " · current" : ""}
                  </span>
                </button>
              </li>
            ))}
            {matches.length === 0 ? (
              <li className={styles.menuItem}>
                {notebooks.isPending ? "Loading…" : `No notebook matches “${query}”`}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </dialog>
  );
}
