import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "../../app/queryKeys.ts";
import { request } from "../../shared/lib/http.ts";
import type { DeleteNotebookDto, NotebookDto, NotebookSummaryDto } from "../../types.ts";

export function useNotebooks() {
  return useQuery({
    queryKey: qk.notebooks(),
    queryFn: () => request<{ notebooks: NotebookSummaryDto[] }>("/api/notebooks"),
    select: (data) => data.notebooks,
  });
}

export function useNotebook(name: string | undefined) {
  return useQuery({
    queryKey: qk.notebook(name ?? ""),
    queryFn: () => request<NotebookDto>(`/api/notebooks/${encodeURIComponent(name!)}`),
    enabled: Boolean(name),
  });
}

export function useCreateNotebook() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      request<NotebookSummaryDto>("/api/notebooks", { method: "POST", body: { name } }),
    onSuccess: () => {
      // A new notebook changes the list and nothing else, so one invalidation.
      void client.invalidateQueries({ queryKey: qk.notebooks() });
    },
  });
}

export function useDeleteNotebook() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (name: string) =>
      request<DeleteNotebookDto>(`/api/notebooks/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),

    onMutate: (name) => {
      const previous = client.getQueryData<{ notebooks: NotebookSummaryDto[] }>(qk.notebooks());
      client.setQueryData<{ notebooks: NotebookSummaryDto[] }>(qk.notebooks(), (current) =>
        current === undefined
          ? current
          : { notebooks: current.notebooks.filter((notebook) => notebook.name !== name) },
      );
      return { previous };
    },

    onError: (_error, _name, context) => {
      // Put it back. The toast, wired to the mutation cache, says why.
      if (context?.previous) client.setQueryData(qk.notebooks(), context.previous);
    },

    onSettled: (_data, _error, name) => {
      void client.invalidateQueries({ queryKey: qk.notebooks() });
      client.removeQueries({ queryKey: qk.notebook(name) });
    },
  });
}
