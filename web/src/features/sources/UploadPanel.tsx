import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "../../app/queryKeys.ts";
import { cancelUpload, dismissUpload, startUpload, useUploads } from "./uploadStore.ts";
import { formatBytes, plural } from "../../shared/lib/format.ts";
import { Button, IconButton, ProgressBar } from "../../shared/ui/primitives.tsx";
import { Icon } from "../../shared/ui/Icon.tsx";
import styles from "./sources.module.css";
import type { Upload } from "./uploadStore.ts";

const STAGE_LABEL: Record<string, string> = {
  extract: "Reading the file",
  quality: "Checking the extraction",
  clean: "Cleaning the text",
  chunk: "Cutting into passages",
  embed: "Embedding",
  store: "Indexing",
};

export function UploadPanel({ notebook }: { notebook: string }) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const uploads = useUploads(notebook);
  const [dragging, setDragging] = useState(false);

  const begin = (files: FileList | null) => {
    if (!files) return;
    for (const file of files) {
      void startUpload({
        notebook,
        file,
        client,
        onSettled: (name) => {
          void client.invalidateQueries({ queryKey: qk.notebook(name) });
          void client.invalidateQueries({ queryKey: qk.notebooks() });
        },
      });
    }
  };

  return (
    <div
      className={dragging ? `${styles.uploadZone} ${styles.uploadZoneActive}` : styles.uploadZone}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        begin(event.dataTransfer.files);
      }}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept=".pdf,.docx,.html,.htm,.xhtml,.md,.markdown,.txt"
        className={styles.fileInput}
        onChange={(event) => {
          begin(event.target.files);
          event.target.value = "";
        }}
      />
      <Button icon="upload" onClick={() => input.current?.click()}>
        Add a source
      </Button>
      <span className={styles.uploadHint}>or drop a file here</span>

      {uploads.map((upload) => (
        <UploadRow key={upload.id} upload={upload} />
      ))}
    </div>
  );
}

function UploadRow({ upload }: { upload: Upload }) {
  const { state } = upload;

  return (
    <div className={styles.uploadRow}>
      <div className={styles.uploadHead}>
        <Icon name="file" size={12} />
        <span className={styles.uploadName}>{upload.filename}</span>
        <span className={styles.uploadSize}>{formatBytes(upload.bytes)}</span>
        {state.status === "running" || state.status === "hashing" ? (
          <IconButton icon="close" label="Cancel" onClick={() => void cancelUpload(upload.id)} />
        ) : (
          <IconButton icon="close" label="Dismiss" onClick={() => dismissUpload(upload.id)} />
        )}
      </div>
      <UploadBody upload={upload} />
    </div>
  );
}

function UploadBody({ upload }: { upload: Upload }) {
  const { state } = upload;

  switch (state.status) {
    case "hashing":
      return <p className={styles.uploadNote}>Sending…</p>;

    case "running": {
      const label = state.stage ? (STAGE_LABEL[state.stage] ?? state.stage) : "Starting";
      const value =
        state.done !== null && state.total !== null && state.total > 0
          ? state.done / state.total
          : null;
      return (
        <>
          <ProgressBar value={value} label={label} />
          <p className={styles.uploadNote}>
            {state.queued !== null
              ? `Waiting — ${state.queued} ahead in the queue`
              : value !== null
                ? `${label} — ${state.done} of ${state.total}`
                : label}
          </p>
          {state.note ? <p className={styles.uploadLog}>{state.note}</p> : null}
        </>
      );
    }

    case "succeeded":
      return (
        <p className={styles.uploadOk}>
          <Icon name="check" size={12} /> {plural(state.source.pages, "page")} →{" "}
          {state.source.stats
            ? `${plural(state.source.stats.sections, "section")}, ${plural(
                state.source.stats.passages,
                "passage",
              )}`
            : "indexed"}
        </p>
      );

    case "duplicate":
      return (
        <p className={styles.uploadNote}>
          <Icon name="info" size={12} /> Already in this notebook — nothing to do.
        </p>
      );

    case "needs-ocr":
      return (
        <p className={styles.uploadWarn}>
          <Icon name="warn" size={12} /> This file has no usable text layer, so there is nothing to
          search. {state.reasons.join("; ")}
        </p>
      );

    case "no-text":
      return (
        <p className={styles.uploadWarn}>
          <Icon name="warn" size={12} /> No text came out of this file, so it was not added.
        </p>
      );

    case "cancelled":
      return <p className={styles.uploadNote}>Cancelled.</p>;

    case "failed":
      return (
        <p className={styles.uploadWarn}>
          <Icon name="warn" size={12} /> {state.error.message}
        </p>
      );
  }
}
