from datetime import datetime, timezone
from pathlib import Path
from src.chunking.parent_child import build_parent_child
from src.cleaning import clean_pages
from src.embedding import get_embedder
from src.index.vector_store import VectorStore
from src.loaders import load_document
from src.models import Document, document_id_for_file
from src.notebook.store import NotebookStore

def ingest_file(
    notebook: str,
    file_path: str,
    store: NotebookStore | None = None,
    vector_store: VectorStore | None = None,
    embedder = None,
) -> Document | None:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"no such file: {path}")
    store = store or NotebookStore()
    document_id = document_id_for_file(path)
    if store.has_document(notebook, document_id):
        print(f"already added: {path.name} (id {document_id}) - nothing to do")
        return None
    print(f"loading {path.name} ...")
    pages = clean_pages(load_document(str(path)))
    print(f"  {len(pages)} page(s) after cleaning")
    parents, children = build_parent_child(pages, document_id)
    print(f"  {len(parents)} parent chunk(s), {len(children)} child chunk(s)")
    if not children:
        print("  ! nothing to index - the document produced no text")
        return None
    document = Document(
        document_id = document_id,
        title = path.stem,
        filename = path.name,
        source_type = path.suffix.lstrip(".").lower(),
        page_count = len(pages),
        added_at = datetime.now(timezone.utc).isoformat(timespec = "seconds"),
    )
    store.add_document(notebook, document)
    store.add_chunks(parents + children)

    print("  embedding children (the first run downloads the model) ...")
    embedder = embedder or get_embedder()
    vectors = embedder.embed_documents([c.text for c in children])

    (vector_store or VectorStore()).add(notebook, children, vectors)
    print(f"added {document.filename} -> {notebook} (id {document_id})")
    return document