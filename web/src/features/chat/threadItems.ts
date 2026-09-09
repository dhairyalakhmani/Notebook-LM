import type { ApiError } from "../../shared/lib/http.ts";
import type { TurnDto } from "../../types.ts";

export type ThreadItem =
  | { kind: "pending"; localId: string; question: string; sentAt: number }
  | {
      kind: "quota-wait";
      localId: string;
      question: string;
      retryAt: number;
    }
  | { kind: "failed"; localId: string; question: string; error: ApiError }
  | TurnDto;

export function itemId(item: ThreadItem): string {
  return "localId" in item ? item.localId : item.id;
}

export function isPending(item: ThreadItem): boolean {
  return item.kind === "pending" || item.kind === "quota-wait";
}

export function questionOf(item: ThreadItem): string {
  switch (item.kind) {
    case "pending":
    case "quota-wait":
    case "failed":
      return item.question;
    case "answer":
    case "ungrounded":
    case "refusal":
    case "no-passages":
      return item.question.text;
  }
}

export function assertNever(value: never): never {
  throw new Error(`unhandled thread item: ${JSON.stringify(value)}`);
}
