from src.cleaning.normalize import normalize_pages
from src.cleaning.page_furniture import strip_furniture
from src.models import DocumentPage

def clean_pages(pages: list[DocumentPage]) -> list[DocumentPage]:
    return normalize_pages(strip_furniture(pages))