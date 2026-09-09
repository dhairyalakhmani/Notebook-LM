import { useOutletContext } from "react-router";
import type { NotebookDto } from "../types.ts";
import type { Scope } from "../features/sources/useScope.ts";

export interface NotebookContext {
  notebook: string;
  data: NotebookDto;
  scope: Scope;
}

export function useNotebookContext(): NotebookContext {
  return useOutletContext<NotebookContext>();
}
