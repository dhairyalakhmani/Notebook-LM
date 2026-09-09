import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "../../app/queryKeys.ts";
import { request } from "../../shared/lib/http.ts";
import type { DeleteSourceDto, NotebookDto, OutlineSectionDto } from "../../types.ts";

export function useOutline(documentId: string | null) {
  return useQuery({
    queryKey: qk.outline(documentId ?? ""),
    queryFn: () =>
      request<{ sections: OutlineSectionDto[] }>(`/api/sources/${documentId!}/outline`),
    select: (data) => data.sections,
    enabled: Boolean(documentId),
    // An outline is derived from chunks, which only change on re-ingest.
    staleTime: 10 * 60_000,
  });
}

export function sourceFileUrl(fileUrl: string | null): string | null {
  return fileUrl;
}

export function useDeleteSource(notebook: string) {
  const client = useQueryClient();
  const key = qk.notebook(notebook);

  return useMutation({
    mutationFn: (documentId: string) =>
      request<DeleteSourceDto>(
        `/api/notebooks/${encodeURIComponent(notebook)}/sources/${documentId}`,
        { method: "DELETE" },
      ),

    onMutate: (documentId) => {
      const previous = client.getQueryData<NotebookDto>(key);
      client.setQueryData<NotebookDto>(key, (current) =>
        current === undefined
          ? current
          : { ...current, sources: current.sources.filter((s) => s.id !== documentId) },
      );
      return { previous };
    },

    onError: (_error, _documentId, context) => {
      // Put it back. The toast, wired to the mutation cache, says why.
      if (context?.previous) client.setQueryData(key, context.previous);
    },

    onSettled: (_data, _error, documentId) => {
      void client.invalidateQueries({ queryKey: key });
      void client.invalidateQueries({ queryKey: qk.notebooks() });
      client.removeQueries({ queryKey: qk.outline(documentId) });
    },
  });
}
