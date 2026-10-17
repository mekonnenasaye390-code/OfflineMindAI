
import io
import json
import os
import re
import uuid
from collections import OrderedDict
from pathlib import Path

import requests
from docx import Document
from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context
from pypdf import PdfReader

BASE_DIR = Path(__file__).parent.resolve()
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
DEFAULT_MODEL = os.environ.get("OFFLINEMIND_MODEL", "llama3.2")
NUM_CTX = int(os.environ.get("OFFLINEMIND_NUM_CTX", "8192"))

CONTEXT_CHARS = 12000       # max document text sent in one prompt
CHUNK_CHARS = 8000          # chunk size for map-reduce summaries
MAX_CHUNKS = 30
MAX_DOCS = 20
ALLOWED_EXT = {".pdf", ".docx", ".txt", ".md", ".csv", ".json", ".py", ".js", ".html", ".log"}

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 40 * 1024 * 1024  # 40 MB
DOCS = OrderedDict()  # doc_id -> {"name": str, "text": str}


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def extract_text(data: bytes, ext: str) -> str:
    if ext == ".pdf":
        reader = PdfReader(io.BytesIO(data))
        return "\n\n".join((p.extract_text() or "") for p in reader.pages)
    if ext == ".docx":
        doc = Document(io.BytesIO(data))
        parts = [p.text for p in doc.paragraphs]
        for table in doc.tables:
            for row in table.rows:
                parts.append(" | ".join(c.text for c in row.cells))
        return "\n".join(parts)
    return data.decode("utf-8", errors="ignore")


def clean_text(text: str) -> str:
    text = text.replace("\x00", "")
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def chunk_text(text: str, size: int):
    chunks, current = [], ""
    for para in text.split("\n"):
        if len(current) + len(para) + 1 > size and current:
            chunks.append(current)
            current = ""
        while len(para) > size:
            chunks.append(para[:size])
            para = para[size:]
        current += para + "\n"
    if current.strip():
        chunks.append(current)
    return chunks


def spread_sample(chunks, limit_chars):
    """Pick evenly spaced chunks so the whole document is represented."""
    total = sum(len(c) for c in chunks)
    if total <= limit_chars:
        return "\n".join(chunks)
    n = max(1, limit_chars // max(1, len(chunks[0])))
    step = len(chunks) / n
    return "\n".join(chunks[int(i * step)] for i in range(n))


def relevant_context(text: str, query: str, limit_chars: int) -> str:
    """Simple offline retrieval: keyword-overlap ranking of chunks."""
    if len(text) <= limit_chars:
        return text
    chunks = chunk_text(text, 1500)
    words = {w for w in re.findall(r"[a-zA-Z0-9]{3,}", query.lower())}
    scored = []
    for i, c in enumerate(chunks):
        cw = re.findall(r"[a-zA-Z0-9]{3,}", c.lower())
        score = sum(1 for w in cw if w in words)
        scored.append((score, i))
    scored.sort(reverse=True)
    picked, used = [], 0
    for score, i in scored:
        if used + len(chunks[i]) > limit_chars:
            continue
        picked.append(i)
        used += len(chunks[i])
