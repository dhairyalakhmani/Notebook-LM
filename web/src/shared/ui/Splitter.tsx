/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
import { useCallback, useEffect, useRef } from "react";
import styles from "./ui.module.css";

export function Splitter({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) {
  const dragging = useRef<{ startX: number; startValue: number } | null>(null);

  const clamp = useCallback(
    (next: number) => Math.min(max, Math.max(min, Math.round(next))),
    [min, max],
  );

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragging.current;
      if (!drag) return;
      onChange(clamp(drag.startValue + (event.clientX - drag.startX)));
    };
    const stop = () => {
      if (!dragging.current) return;
      dragging.current = null;
      document.body.classList.remove("dragging");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [clamp, onChange]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={styles.splitter}
      onPointerDown={(event) => {
        dragging.current = { startX: event.clientX, startValue: value };
        document.body.classList.add("dragging");
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 8;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onChange(clamp(value - step));
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onChange(clamp(value + step));
        }
      }}
    />
  );
}
