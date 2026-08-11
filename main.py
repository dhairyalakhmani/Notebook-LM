from src.document_loader import PDFDocumentLoader
def main():
    file_path = "data/Schema Architecture Notes.pdf"
    loader = PDFDocumentLoader(file_path)
    pages = loader.load()
    print("Number of pages:", len(pages))
    for page in pages:
        print(f"\n--- Page {page.page_number} ---")
        print(f"Source: {page.source}")
        print(page.text[:1000])
if __name__ == "__main__":
    main()