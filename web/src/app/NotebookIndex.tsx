import { Navigate } from "react-router";
import { useCreateNotebook, useNotebooks } from "../features/notebooks/api.ts";
import { messages } from "../shared/messages.ts";
import { Button, SkeletonList } from "../shared/ui/primitives.tsx";
import { QueryState } from "../shared/ui/QueryState.tsx";
import { StateCard } from "../shared/ui/StateCard.tsx";

export function NotebookIndex() {
  const notebooks = useNotebooks();
  const create = useCreateNotebook();

  return (
    <QueryState
      query={notebooks}
      isEmpty={(list) => list.length === 0}
      loading={<SkeletonList rows={3} />}
      empty={
        <StateCard message={messages.notebooksEmpty}>
          <Button
            variant="primary"
            icon="plus"
            disabled={create.isPending}
            onClick={() => create.mutate("my notebook")}
          >
            {create.isPending ? "Creating…" : messages.notebooksEmpty.action}
          </Button>
        </StateCard>
      }
      error={(failure, retry) => (
        <StateCard message={messages.notebooksFailed} tone="danger" said={failure.message}>
          <Button variant="primary" onClick={retry}>
            {messages.notebooksFailed.action}
          </Button>
        </StateCard>
      )}
    >
      {(list) => <Navigate to={`/n/${encodeURIComponent(list[0]!.name)}`} replace />}
    </QueryState>
  );
}
