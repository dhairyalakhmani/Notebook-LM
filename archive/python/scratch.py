from src.embedding import get_embedder

embedder = get_embedder()
sentences = [
    "Failed charges are retried three times over 72 hours.",
    "A declined payment is attempted again for three days.",
    "The office cafeteria serves lunch until 2pm.",
]
vectors = embedder.embed_documents(sentences)


def cosine(a, b):
    return sum(x * y for x, y in zip(a, b))     # normalised -> dot product is cosine


print("related   ", round(cosine(vectors[0], vectors[1]), 3))
print("unrelated ", round(cosine(vectors[0], vectors[2]), 3))
print("unrelated ", round(cosine(vectors[1], vectors[2]), 3))