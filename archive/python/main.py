import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path
from src.cleaning import clean_pages
from src.loaders import load_document
from src.models import Document, document_id_for_file
from src.notebook.ingest import ingest_file
from src.notebook.store import NotebookStore

def cmd_add(args: argparse.Namespace) -> int:
    ingest_file(args.notebook, args.path)
    return 0

def cmd_sources(args: argparse.Namespace) -> int:
    documents = NotebookStore().list_documents(args.notebook)
    if not documents:
        print(f"notebook '{args.notebook}' is empty")
        return 0
    print(f"{args.notebook}: {len(documents)} source(s)")
    for document in documents:
        print(f"  {document.document_id}  {document.filename:40s} "
              f"{document.page_count:4d}p  {document.added_at}")
    return 0

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog = "notebook")
    commands = parser.add_subparsers(dest = "command", required = True)

    add = commands.add_parser("add", help = "add a source to a notebook")
    add.add_argument("notebook")
    add.add_argument("path")
    add.set_defaults(func = cmd_add)

    sources = commands.add_parser("sources", help = "list a notebook's sources")
    sources.add_argument("notebook")
    sources.set_defaults(func = cmd_sources)

    return parser

if __name__ == "__main__":
    arguments = build_parser().parse_args()
    sys.exit(arguments.func(arguments))