import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { qk } from "../../app/queryKeys.ts";
import { asApiError, request } from "../../shared/lib/http.ts";
import type {
  AskRequestDto,
  AskResponseDto,
  AskTimingsDto,
  NotebookDto,
  QuotaDto,
} from "../../types.ts";
import type { ThreadItem } from "./threadItems.ts";

export function useAsk(notebook: string) {
  const client = useQueryClient();
  const [local, setLocal] = useState<ThreadItem[]>([]);
  const [quota, setQuota] = useState<QuotaDto | null>(null);
  const [timings, setTimings] = useState<AskTimingsDto | null>(null);

  const clearLocal = useCallback((localId: string) => {
    setLocal((current) =>
      current.filter((item) => !("localId" in item) || item.localId !== localId),
    );
  }, []);

  const mutation = useMutation({
    mutationFn: (variables: { question: string; sourceIds?: readonly string[] }) => {
      const body: AskRequestDto = {
        question: variables.question,
        ...(variables.sourceIds && variables.sourceIds.length > 0
          ? { sourceIds: variables.sourceIds }
          : {}),
      };
      return request<AskResponseDto>(`/api/notebooks/${encodeURIComponent(notebook)}/ask`, {
        method: "POST",
        body,
      });
    },
  });

  const ask = useCallback(
    async (question: string, sourceIds?: readonly string[]) => {
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setLocal((current) => [
        ...current,
        { kind: "pending", localId, question, sentAt: Date.now() },
      ]);

      try {
        const response = await mutation.mutateAsync({
          question,
          ...(sourceIds ? { sourceIds } : {}),
        });
        setQuota(response.quota);
        setTimings(response.timings);

        client.setQueryData<NotebookDto>(qk.notebook(notebook), (current) =>
          current === undefined
            ? current
            : {
                ...current,
                turns: [...current.turns, response.turn],
                totalTurns: current.totalTurns + 1,
              },
        );
        // The summary list shows a turn count and a last-message time.
        void client.invalidateQueries({ queryKey: qk.notebooks() });
        clearLocal(localId);
        return response;
      } catch (error) {
        const failure = asApiError(error);
        setLocal((current) =>
          current.map((item) =>
            "localId" in item && item.localId === localId
              ? failure.kind === "quota"
                ? {
                    kind: "quota-wait" as const,
                    localId,
                    question,
                    retryAt: Date.now() + failure.retryAfterMs,
                  }
                : { kind: "failed" as const, localId, question, error: failure }
              : item,
          ),
        );
        return null;
      }
    },
    [client, clearLocal, mutation, notebook],
  );

  const retry = useCallback(
    (localId: string, question: string, sourceIds?: readonly string[]) => {
      clearLocal(localId);
      void ask(question, sourceIds);
    },
    [ask, clearLocal],
  );

  return {
    ask,
    retry,
    dismiss: clearLocal,
    local,
    quota,
    timings,
    isAsking: mutation.isPending,
  };
}
