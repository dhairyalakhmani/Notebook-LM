import { useCallback, useMemo, useState } from "react";
import { readStored, writeStored } from "../../shared/lib/useLocalStorage.ts";
import type { SourceDto } from "../../types.ts";

export interface Scope {
  ids: string[];
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  selectAll: () => void;
  selectNone: () => void;
  all: boolean;
  none: boolean;
}

export function useScope(notebook: string, sources: readonly SourceDto[]): Scope {
  const key = `scope.${notebook}`;
  const [stored, setStored] = useState<string[] | null>(() =>
    readStored<string[] | null>(key, null),
  );

  const live = useMemo(() => new Set(sources.map((source) => source.id)), [sources]);

  const ids = useMemo(() => {
    if (stored === null) return sources.map((source) => source.id);
    return stored.filter((id) => live.has(id));
  }, [stored, live, sources]);

  const set = useCallback(
    (next: string[]) => {
      setStored(next);
      writeStored(key, next);
    },
    [key],
  );

  const selected = useMemo(() => new Set(ids), [ids]);

  return {
    ids,
    has: (id) => selected.has(id),
    toggle: (id) => set(selected.has(id) ? ids.filter((value) => value !== id) : [...ids, id]),
    selectAll: () => set(sources.map((source) => source.id)),
    selectNone: () => set([]),
    all: ids.length === sources.length && sources.length > 0,
    none: ids.length === 0,
  };
}
