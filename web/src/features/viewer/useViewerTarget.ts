import { useEffect, useMemo } from "react";
import { useViewerParams } from "./useViewerParams.ts";
import type { CitationDto, SourceDto, TurnDto } from "../../types.ts";

export interface ViewerTarget {
  source: SourceDto | null;
  page: number;
  phrases: readonly string[];
  citation: CitationDto | null;
  missing: boolean;
}

function findCitation(
  turns: readonly TurnDto[],
  cite: string | null,
): { citation: CitationDto } | null {
  if (!cite) return null;
  const [turnId, rawMarker] = cite.split(".");
  const marker = Number(rawMarker);
  const turn = turns.find((candidate) => candidate.id === turnId);
  if (!turn || turn.kind !== "answer") return null;
  const citation = turn.citations.find((candidate) => candidate.marker === marker);
  return citation ? { citation } : null;
}

export function useViewerTarget(
  sources: readonly SourceDto[],
  turns: readonly TurnDto[],
): ViewerTarget {
  const { params, setParams } = useViewerParams();

  const found = useMemo(() => findCitation(turns, params.cite), [turns, params.cite]);
  const citation = found?.citation ?? null;

  const target = useMemo<ViewerTarget>(() => {
    const sole = sources.length === 1 ? sources[0]! : null;
    const documentId = citation?.sourceId ?? params.doc ?? sole?.id ?? null;
    const source = sources.find((candidate) => candidate.id === documentId) ?? null;

    const wanted = params.page ?? citation?.page ?? 1;
    const page = source ? Math.min(Math.max(1, wanted), Math.max(1, source.pages)) : 1;

    const phrases =
      citation && citation.sourceId === source?.id && citation.quote ? [citation.quote] : [];

    return {
      source,
      page,
      phrases,
      citation,
      missing: documentId !== null && source === null,
    };
  }, [sources, citation, params.doc, params.page]);

  useEffect(() => {
    if (!citation?.sourceId) return;
    if (params.doc === citation.sourceId) return;
    setParams({ doc: citation.sourceId, page: citation.page }, { replace: true });
  }, [citation, params.doc, setParams]);

  return target;
}
