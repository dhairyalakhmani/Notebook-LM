import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { useCreateNotebook, useNotebooks } from "../features/notebooks/api.ts";
import { messages } from "../shared/messages.ts";
import { Button, SkeletonList } from "../shared/ui/primitives.tsx";
import { QueryState } from "../shared/ui/QueryState.tsx";
import { StateCard } from "../shared/ui/StateCard.tsx";
import styles from "../features/auth/auth.module.css";

/**
 * Naming the first notebook.
 *
 * This used to be a single button that created a notebook called
 * "my notebook", which is not a name anybody chose and cannot be changed
 * afterwards. It asks now.
 */
function CreateFirst() {
  const create = useCreateNotebook();
  const navigate = useNavigate();
  const [name, setName] = useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const wanted = name.trim();
    if (wanted === "" || create.isPending) return;
    create.mutate(wanted, {
      onSuccess: (created) => {
        void navigate(`/n/${encodeURIComponent(created.name)}`);
      },
    });
  };

  return (
    <StateCard message={messages.notebooksEmpty}>
      <form onSubmit={submit} className={styles.field}>
        <label htmlFor="first-notebook">Name</label>
        <input
          id="first-notebook"
          className={styles.input}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Networking, DBMS, Thesis…"
          aria-describedby="first-notebook-hint"
          maxLength={64}
          autoComplete="off"
        />
        <span id="first-notebook-hint" className={styles.hint}>
          Letters, digits, spaces, dot, dash or underscore.
        </span>
        <Button variant="primary" icon="plus" type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating…" : messages.notebooksEmpty.action}
        </Button>
      </form>
    </StateCard>
  );
}

export function NotebookIndex() {
  const notebooks = useNotebooks();

  return (
    <QueryState
      query={notebooks}
      isEmpty={(list) => list.length === 0}
      loading={<SkeletonList rows={3} />}
      empty={<CreateFirst />}
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
