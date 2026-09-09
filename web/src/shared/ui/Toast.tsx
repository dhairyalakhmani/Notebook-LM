import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "./Icon.tsx";
import styles from "./ui.module.css";
import type { ReactNode } from "react";

export type ToastTone = "danger" | "success";

interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}

const ToastContext = createContext<((text: string, tone?: ToastTone) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((text: string, tone: ToastTone = "danger") => {
    const id = Date.now() + Math.random();
    setToasts((current) => {
      // The same failure repeated (a refetch loop) should not stack up.
      if (current.some((toast) => toast.text === text)) return current;
      return [...current, { id, text, tone }].slice(-3);
    });
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 6000);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.length > 0 ? (
        // `alert` so it is announced without stealing focus mid-typing.
        <div className={styles.toasts} role="alert" aria-live="assertive">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={cx(styles.toast, toast.tone === "success" && styles.toastSuccess)}
            >
              <Icon name={toast.tone === "success" ? "check" : "warn"} />
              <span>{toast.text}</span>
              <button
                type="button"
                className={styles.toastDismiss}
                aria-label="Dismiss"
                onClick={() => setToasts((current) => current.filter((t) => t.id !== toast.id))}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): (text: string, tone?: ToastTone) => void {
  return useContext(ToastContext) ?? (() => {});
}
