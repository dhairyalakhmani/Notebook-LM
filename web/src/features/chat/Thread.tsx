import { Link, useLocation } from "react-router";
import { assertNever, itemId, questionOf } from "./threadItems.ts";
import { citationSearch, useViewerParams } from "../viewer/useViewerParams.ts";
import { cx } from "../../shared/lib/cx.ts";
import { formatTime, parseMarkers, plural } from "../../shared/lib/format.ts";
import { useCountdown } from "../../shared/lib/useCountdown.ts";
import { messageForError, messages } from "../../shared/messages.ts";
import { Button } from "../../shared/ui/primitives.tsx";
import { StateCard } from "../../shared/ui/StateCard.tsx";
import { Icon } from "../../shared/ui/Icon.tsx";
import styles from "./chat.module.css";
import type { ThreadItem } from "./threadItems.ts";
import type { CitationDto, PassageDto, TurnDto } from "../../types.ts";

export function Thread({
  items,
  onRetry,
  onDismiss,
}: {
  items: readonly ThreadItem[];
  onRetry: (localId: string, question: string) => void;
  onDismiss: (localId: string) => void;
}) {
  return (
    <ol className={styles.thread}>
      {items.map((item) => (
        <li key={itemId(item)} className={styles.turn}>
          <Question item={item} />
          <div className={styles.answer} aria-live="polite" aria-busy={item.kind === "pending"}>
            <Outcome item={item} onRetry={onRetry} onDismiss={onDismiss} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function Question({ item }: { item: ThreadItem }) {
  const searchedFor =
    "question" in item && typeof item.question === "object" ? item.question.searchedFor : null;
  return (
    <div className={styles.question}>
      <p className={styles.questionText}>{questionOf(item)}</p>
      {searchedFor ? (
        <p className={styles.searchedFor}>
          <Icon name="search" size={12} /> searched for “{searchedFor}”
        </p>
      ) : null}
    </div>
  );
}

function Outcome({
  item,
  onRetry,
  onDismiss,
}: {
  item: ThreadItem;
  onRetry: (localId: string, question: string) => void;
  onDismiss: (localId: string) => void;
}) {
  switch (item.kind) {
    case "pending":
      return <Pending />;

    case "quota-wait":
      return (
        <QuotaWait retryAt={item.retryAt} onRetry={() => onRetry(item.localId, item.question)} />
      );

    case "failed":
      return (
        <StateCard
          message={messages.askFailed}
          tone="danger"
          centred={false}
          said={messageForError(item.error.kind).title + ": " + item.error.message}
        >
          <Button variant="primary" onClick={() => onRetry(item.localId, item.question)}>
            {messages.askFailed.action}
          </Button>
          <Button variant="quiet" onClick={() => onDismiss(item.localId)}>
            Dismiss
          </Button>
        </StateCard>
      );

    case "answer":
      return <Answered turn={item} />;

    case "ungrounded":
      return (
        <>
          <StateCard message={messages.ungrounded} tone="warn" centred={false} />
          <AnswerBody text={item.text} citations={[]} turnId={item.id} />
          <Scores passages={item.passages} />
        </>
      );

    case "refusal":
      return (
        <>
          <StateCard
            message={
              item.reason === "below-relevance-floor"
                ? messages.refusedByFloor
                : messages.refusedByModel
            }
            tone="refusal"
            centred={false}
            said={item.refusalText}
          />
          <Scores passages={item.passages} />
        </>
      );

    case "no-passages":
      return <StateCard message={messages.noPassages} tone="refusal" centred={false} />;

    default:
      return assertNever(item);
  }
}

function Pending() {
  return (
    <div className={styles.pending}>
      <span className={styles.spinner} aria-hidden="true" />
      <span>{messages.thinking.title}…</span>
    </div>
  );
}

function QuotaWait({ retryAt, onRetry }: { retryAt: number; onRetry: () => void }) {
  const seconds = useCountdown(retryAt);
  return (
    <StateCard message={messages.quotaWait} tone="warn" centred={false}>
      <span className={styles.countdown}>
        {seconds === null || seconds <= 0 ? "ready" : `${seconds}s`}
      </span>
      <Button variant="primary" onClick={onRetry} disabled={seconds !== null && seconds > 0}>
        Send now
      </Button>
    </StateCard>
  );
}

function Answered({ turn }: { turn: TurnDto & { kind: "answer" } }) {
  return (
    <>
      <AnswerBody text={turn.text} citations={turn.citations} turnId={turn.id} />
      <CitedSources citations={turn.citations} turnId={turn.id} />
      <Scores passages={turn.passages} />
      <p className={styles.answeredAt}>{formatTime(turn.answeredAt)}</p>
    </>
  );
}

function AnswerBody({
  text,
  citations,
  turnId,
}: {
  text: string;
  citations: readonly CitationDto[];
  turnId: string;
}) {
  const byMarker = new Map(citations.map((citation) => [citation.marker, citation]));
  return (
    <p className={styles.prose}>
      {parseMarkers(text).map((part, index) =>
        part.kind === "text" ? (
          <span key={index}>{part.text}</span>
        ) : (
          <CitationChip
            key={index}
            marker={part.marker}
            citation={byMarker.get(part.marker)}
            turnId={turnId}
          />
        ),
      )}
    </p>
  );
}

function CitationChip({
  marker,
  citation,
  turnId,
}: {
  marker: number;
  citation: CitationDto | undefined;
  turnId: string;
}) {
  const location = useLocation();
  const { params } = useViewerParams();

  if (!citation) return <span className={styles.citationDead}>[{marker}]</span>;

  const cite = `${turnId}.${marker}`;
  const current = params.cite === cite;
  const search = citationSearch(new URLSearchParams(location.search), citation, cite);

  return (
    <Link
      to={{ search }}
      className={cx(styles.citation, current && styles.citationCurrent)}
      {...(current ? { "aria-current": "true" as const } : {})}
      aria-label={`Citation ${marker}: open ${citation.filename}, ${citation.pageLabel}`}
    >
      {marker}
    </Link>
  );
}

function CitedSources({
  citations,
  turnId,
}: {
  citations: readonly CitationDto[];
  turnId: string;
}) {
  return (
    <ul className={styles.sources} aria-label="Sources for this answer">
      {citations.map((citation) => (
        <li key={citation.marker} className={styles.sourceLine}>
          <CitationChip marker={citation.marker} citation={citation} turnId={turnId} />
          <span className={styles.sourceWhere}>
            {citation.filename} · {citation.pageLabel}
            {citation.section.length > 0 ? ` · ${citation.section.at(-1)}` : ""}
          </span>
          {citation.quote ? (
            <span className={styles.sourceQuote}>“{citation.quote}”</span>
          ) : (
            <span className={styles.sourceNoQuote}>no single sentence matched closely enough</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Scores({ passages }: { passages: readonly PassageDto[] }) {
  if (passages.length === 0) return null;
  return (
    <details className={styles.scores}>
      <summary>
        retrieval · {plural(passages.length, "passage")} ·{" "}
        {passages.filter((passage) => passage.cited).length} cited
      </summary>
      <table className={styles.scoreTable}>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">pages</th>
            <th scope="col">cosine</th>
            <th scope="col">bm25</th>
            <th scope="col">dense</th>
            <th scope="col">sparse</th>
            <th scope="col">hits</th>
          </tr>
        </thead>
        <tbody>
          {passages.map((passage) => (
            <tr key={passage.marker} className={cx(passage.cited && styles.scoreRowCited)}>
              <td>{passage.marker}</td>
              <td>{passage.pageLabel}</td>
              <td>{passage.cosine === null ? "—" : passage.cosine.toFixed(3)}</td>
              <td>{passage.bm25 === null ? "—" : passage.bm25.toFixed(1)}</td>
              <td>{passage.denseRank === null ? "—" : `#${passage.denseRank}`}</td>
              <td>{passage.sparseRank === null ? "—" : `#${passage.sparseRank}`}</td>
              <td>{passage.matchCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.scoreNote}>
        A dash under cosine means only the keyword search found that passage — which is what a
        hybrid search is for.
      </p>
    </details>
  );
}
