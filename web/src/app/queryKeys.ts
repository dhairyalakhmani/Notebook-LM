export const qk = {
  notebooks: () => ["notebooks"] as const,
  notebook: (name: string) => ["notebook", name] as const,
  outline: (documentId: string) => ["source", documentId, "outline"] as const,
};
