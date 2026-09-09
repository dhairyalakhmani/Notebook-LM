import { useEffect, useRef, useState } from "react";
import { useNotebookContext } from "../../app/context.ts";
import { Thread } from "./Thread.tsx";
import { useAsk } from "./useAsk.ts";
import { formatMs } from "../../shared/lib/format.ts";
import { messages } from "../../shared/messages.ts";
import { Button, IconButton } from "../../shared/ui/primitives.tsx";
import { StateCard } from "../../shared/ui/StateCard.tsx";
import styles from "./chat.module.css";
import type { ThreadItem } from "./threadItems.ts";

export function ChatView() {
  const { notebook, data, scope } = useNotebookContext();
  const { ask, retry, dismiss, local, quota, timings } = useAsk(notebook);
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  const items: ThreadItem[] = [...data.turns, ...local];

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [items.length]);

  const noSources = data.sources.length === 0;
  const blocked = noSources || scope.none;

  const submit = () => {
    const question = draft.trim();
    if (question === "" || blocked) return;
    setDraft("");
    void ask(question, scope.all ? undefined : scope.ids);
  };

  return (
    <div className={styles.chat}>
      <div className={styles.chatScroll} data-scroll>
        {items.length === 0 ? (
          <StateCard message={noSources ? messages.sourcesEmpty : messages.threadEmpty} />
        ) : (
          <Thread items={items} onRetry={retry} onDismiss={dismiss} />
        )}
        <div ref={bottom} />
      </div>

      <div className={styles.composer}>
        {blocked ? (
          <p className={styles.blocked}>
            {noSources ? messages.blockedNoSources.body : messages.blockedScopeEmpty.body}
            {scope.none && !noSources ? (
              <Button variant="quiet" onClick={scope.selectAll}>
                {messages.blockedScopeEmpty.action}
              </Button>
            ) : null}
          </p>
        ) : null}

        <div className={styles.composerRow}>
          <textarea
            className={styles.input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={
              blocked ? "Add a source to ask a question" : "Ask something about your sources"
            }
            rows={2}
            disabled={blocked}
            aria-label="Your question"
            data-composer=""
          />
          <IconButton
            icon="send"
            label="Send"
            variant="primary"
            disabled={blocked || draft.trim() === ""}
            onClick={submit}
          />
        </div>

        <div className={styles.composerFoot}>
          {timings ? (
            <span title="the last answer">
              {formatMs(timings.totalMs)} — rewrite {formatMs(timings.rewriteMs)}, retrieve{" "}
              {formatMs(timings.retrieveMs)}, answer {formatMs(timings.answerMs)}
            </span>
          ) : null}
          <span>
            {scope.all
              ? `searching all ${data.sources.length}`
              : `searching ${scope.ids.length} of ${data.sources.length}`}
          </span>
          {quota?.tokensRemaining !== null && quota?.tokensRemaining !== undefined ? (
            <span className={styles.quota}>
              {quota.tokensRemaining.toLocaleString()}
              {quota.tokensLimit ? ` / ${quota.tokensLimit.toLocaleString()}` : ""} tokens left
              {quota.resetTokensMs !== null
                ? ` · resets in ${Math.ceil(quota.resetTokensMs / 1000)}s`
                : ""}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
