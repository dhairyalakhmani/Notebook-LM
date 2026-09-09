import { cx } from "../lib/cx.ts";
import { Icon } from "./Icon.tsx";
import styles from "./ui.module.css";
import type { ReactNode } from "react";
import type { IconName } from "./Icon.tsx";
import type { Message } from "../messages.ts";

export type Tone = "neutral" | "refusal" | "warn" | "danger";

const TONE_ICON: Record<Tone, IconName | null> = {
  neutral: null,
  refusal: "quote",
  warn: "warn",
  danger: "warn",
};

export function StateCard({
  message,
  tone = "neutral",
  said,
  centred = true,
  children,
}: {
  message: Message;
  tone?: Tone;
  said?: string | null;
  centred?: boolean;
  children?: ReactNode;
}) {
  const icon = TONE_ICON[tone];
  return (
    <div
      className={cx(
        styles.card,
        centred && styles.cardCentred,
        tone === "refusal" && styles.toneRefusal,
        tone === "warn" && styles.toneWarn,
        tone === "danger" && styles.toneDanger,
      )}
    >
      <div className={styles.cardTitle}>
        {icon ? <Icon name={icon} /> : null} {message.title}
      </div>
      {message.body ? <div className={styles.cardBody}>{message.body}</div> : null}
      {said ? <blockquote className={styles.cardSaid}>{said}</blockquote> : null}
      {children ? <div className={styles.cardActions}>{children}</div> : null}
    </div>
  );
}
