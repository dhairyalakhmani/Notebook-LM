import { useCallback, useState } from "react";

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`nb.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(`nb.${key}`, JSON.stringify(value));
  } catch {
    // Nothing to do and nothing worth telling the user about.
  }
}

export function useStored<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => readStored(key, fallback));
  const store = useCallback(
    (next: T) => {
      setValue(next);
      writeStored(key, next);
    },
    [key],
  );
  return [value, store];
}
