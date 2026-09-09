import { asApiError } from "../lib/http.ts";
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ApiError } from "../lib/http.ts";

export function QueryState<T>({
  query,
  isEmpty,
  loading,
  empty,
  error,
  children,
}: {
  query: UseQueryResult<T>;
  isEmpty?: (data: T) => boolean;
  loading: ReactNode;
  empty: ReactNode;
  error: (error: ApiError, retry: () => void) => ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.data !== undefined) {
    const data = query.data;
    if (isEmpty?.(data)) return <>{empty}</>;
    return <>{children(data)}</>;
  }

  if (query.isError) {
    return <>{error(asApiError(query.error), () => void query.refetch())}</>;
  }

  return <>{loading}</>;
}
