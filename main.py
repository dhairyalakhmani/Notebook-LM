from uuid import uuid4
from src.chunker import RecursiveChunker
from src.config import ChunkingConfig
from src.doc_loader import PDFDocumentLoader
from src.tokenizer import TiktokenCounter
def main():
    file_path = "data/Schema Architecture Notes.pdf"
    loader = PDFDocumentLoader(file_path)
    pages = loader.load()
    tokenizer = TiktokenCounter()
    config = ChunkingConfig(
        parent_target_tokens=2000,
        child_target_tokens=500,
        child_overlap_tokens=50,
    )
    chunker = RecursiveChunker(
        token_counter=tokenizer,
        config=config,
    )
    document_id = str(uuid4())
    chunks = chunker.chunk_pages(
        pages,
        document_id,
    )
    print("Pages:", len(pages))
    print("Chunks:", len(chunks))
    for chunk in chunks[:10]:
        print("\n--------------------")
        print("Chunk ID:", chunk.chunk_id)
        print("Parent ID:", chunk.parent_id)
        print("Page:", chunk.page_number)
        print("Section:", chunk.section)
        print(
            "Tokens:",
            tokenizer.count(chunk.text),
        )
        print(chunk.text)
if __name__ == "__main__":
    main()