import { useEffect } from "react";

export interface Shortcut {
  key: string;
  meta?: boolean;
  shift?: boolean;
  run: () => void;
  describe: string;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useKeymap(shortcuts: readonly Shortcut[], enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey;

      for (const shortcut of shortcuts) {
        if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) continue;
        if (Boolean(shortcut.meta) !== meta) continue;
        if (Boolean(shortcut.shift) !== event.shiftKey) continue;

        // A modified shortcut (Cmd+K) is safe while typing; a bare one is not.
        if (!shortcut.meta && isTyping(event.target)) continue;

        event.preventDefault();
        shortcut.run();
        return;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [shortcuts, enabled]);
}

export function shortcutLabel(shortcut: Shortcut): string {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const parts: string[] = [];
  if (shortcut.meta) parts.push(isMac ? "⌘" : "Ctrl");
  if (shortcut.shift) parts.push("Shift");
  parts.push(shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  return parts.join(isMac ? "" : "+");
}
