import { existsSync } from "node:fs";
import { join } from "node:path";
import * as config from "../config.ts";
import { getEmbedder } from "../embedding/index.ts";
import { LLMClient } from "../llm/client.ts";
import { NotebookStore } from "../notebook/store.ts";
import { Retriever } from "../retrieval/retriever.ts";
import { VectorStore } from "../search/vectorStore.ts";
import type { CompletionModel } from "../llm/client.ts";

let store: NotebookStore | null = null;
let vectorStore: VectorStore | null = null;
let model: CompletionModel | null = null;

export function notebookStore(): NotebookStore {
  store ??= new NotebookStore();
  return store;
}

export function vectors(): VectorStore {
  vectorStore ??= new VectorStore();
  return vectorStore;
}

export function completionModel(): CompletionModel {
  model ??= new LLMClient(config.GROQ_MODEL);
  return model;
}

const cache = new Map<string, { retriever: Retriever; epoch: number }>();
const epochs = new Map<string, number>();

function epochOf(notebook: string): number {
  return epochs.get(notebook) ?? 0;
}

export function invalidateNotebook(notebook: string): void {
  epochs.set(notebook, epochOf(notebook) + 1);
  cache.delete(notebook);
}

export async function retrieverFor(notebook: string): Promise<Retriever> {
  const epoch = epochOf(notebook);
  const cached = cache.get(notebook);
  if (cached && cached.epoch === epoch) return cached.retriever;

  const retriever = await Retriever.create(notebook, {
    store: notebookStore(),
    vectorStore: vectors(),
    embedder: await getEmbedder(),
  });
  cache.set(notebook, { retriever, epoch });
  return retriever;
}

export function sourceFile(documentId: string): string | null {
  const relative = notebookStore().documentPath(documentId);
  if (!relative) return null;
  const absolute = join(config.STORAGE_DIR, relative);
  return existsSync(absolute) ? absolute : null;
}

export function closeServices(): void {
  cache.clear();
  epochs.clear();
  store?.close();
  vectorStore?.close();
  store = null;
  vectorStore = null;
  model = null;
}
