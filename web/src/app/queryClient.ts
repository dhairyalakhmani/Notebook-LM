import { QueryClient } from "@tanstack/react-query";
import { asApiError, isRetryable } from "../shared/lib/http.ts";
import { messageForError } from "../shared/messages.ts";

export function createQueryClient(reportError: (text: string) => void): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: (attempt, error) => isRetryable(error) && attempt < 2,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });

  const report = (error: unknown) => {
    const failure = asApiError(error);
    // An aborted request is a normal consequence of navigating away.
    if (failure.kind === "aborted") return;
    reportError(failure.message || messageForError(failure.kind).title);
  };

  client.getQueryCache().config.onError = report;
  client.getMutationCache().config.onError = report;

  return client;
}
