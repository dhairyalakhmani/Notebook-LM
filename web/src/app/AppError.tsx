import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { messages } from "../shared/messages.ts";
import { Button } from "../shared/ui/primitives.tsx";
import { StateCard } from "../shared/ui/StateCard.tsx";

export function AppError() {
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : null;

  return (
    <StateCard message={messages.unexpected} tone="danger" said={detail}>
      <Button variant="primary" onClick={() => window.location.reload()}>
        {messages.unexpected.action}
      </Button>
      <Link to="/">
        <Button variant="quiet">Back to your notebooks</Button>
      </Link>
    </StateCard>
  );
}

export function NotFound() {
  return (
    <StateCard message={messages.routeMissing}>
      <Link to="/">
        <Button variant="primary">{messages.routeMissing.action}</Button>
      </Link>
    </StateCard>
  );
}
