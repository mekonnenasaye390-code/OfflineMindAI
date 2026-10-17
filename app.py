def models():
    if os.environ.get("GEMINI_API_KEY", "").strip():
        return jsonify({"ok": True, "models": ["gemini-2.5-flash"], "default": "gemini-2.5-flash"})
    try:
        r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=4)
        names = [m["name"] for m in r.json().get("models", [])]
        return jsonify({"ok": True, "models": names, "default": DEFAULT_MODEL})
    except Exception:  # noqa: BLE001
        return jsonify({"ok": False, "models": [], "default": DEFAULT_MODEL})


@app.post("/api/upload")
def upload():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "No file received."}), 400
    ext = Path(f.filename).suffix.lower()
    if ext not in ALLOWED_EXT:
        return jsonify({"error": f"Unsupported file type {ext or '(none)'}. Use PDF, DOCX, TXT or MD."}), 400
    try:
        text = clean_text(extract_text(f.read(), ext))
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"Could not read the file: {e}"}), 400
    if len(text) < 20:
        return jsonify({"error": "No readable text found (scanned PDFs need OCR first)."}), 400
    doc_id = uuid.uuid4().hex[:12]
    DOCS[doc_id] = {"name": f.filename, "text": text}
    while len(DOCS) > MAX_DOCS:
        DOCS.popitem(last=False)
    return jsonify({"id": doc_id, "name": f.filename, "chars": len(text), "words": len(text.split())})


@app.delete("/api/docs/<doc_id>")
def delete_doc(doc_id):
    DOCS.pop(doc_id, None)
    return jsonify({"ok": True})


@app.post("/api/chat")
def chat():
    body = request.get_json(force=True)
    model = body.get("model") or DEFAULT_MODEL
    history = [m for m in body.get("messages", []) if m.get("role") in ("user", "assistant")]
    doc_id = body.get("doc_id")

    def gen():
        system = (
            "You are OfflineMindAI, a helpful, accurate assistant running locally on the user's computer. "
            "Answer clearly and use Markdown for formatting. Be honest when you are unsure."
        )
        if doc_id:
            doc = get_doc(doc_id)
            last_user = next((m["content"] for m in reversed(history) if m["role"] == "user"), "")
            ctx = relevant_context(doc["text"], last_user, CONTEXT_CHARS)
            system += (
                f"\n\nThe user uploaded a document named \"{doc['name']}\". Answer using it when relevant "
                f"and say so if the answer is not in it.\n\n--- DOCUMENT ---\n{ctx}\n--- END ---"
            )
        yield from ollama_stream([{"role": "system", "content": system}] + history[-20:], model)

    return stream_response(gen)


@app.post("/api/summarize")
def summarize():
    body = request.get_json(force=True)
    model = body.get("model") or DEFAULT_MODEL
    style = body.get("style", "medium")
    instructions = {
        "short": "Write a concise summary of 4-6 sentences.",
        "medium": "Write a clear summary: a short overview paragraph, then 5-8 key points as bullets.",
        "detailed": "Write a detailed structured summary with headings for each major section, key facts, "
                    "definitions and conclusions.",
    }.get(style, "Write a clear summary with key points.")

    def gen():
        doc = get_doc(body.get("doc_id"))
        text = doc["text"]
        if len(text) <= CONTEXT_CHARS:
            material = text
        else:
            chunks = chunk_text(text, CHUNK_CHARS)
            if len(chunks) > MAX_CHUNKS:
                step = len(chunks) / MAX_CHUNKS
                chunks = [chunks[int(i * step)] for i in range(MAX_CHUNKS)]
            notes = []
            for i, c in enumerate(chunks, 1):
                yield {"status": f"Reading part {i} of {len(chunks)}…"}
                notes.append(ollama_complete([
                    {"role": "system", "content": "You write compact, factual study notes."},
                    {"role": "user", "content": f"Write concise bullet notes of the key information in this text:\n\n{c}"},
                ], model))
            material = "\n\n".join(notes)[:CONTEXT_CHARS * 2]
        yield {"status": "Writing summary…"}
        yield from ollama_stream([
            {"role": "system", "content": "You are an expert summarizer. Use Markdown. Only use facts from the text."},
            {"role": "user", "content": f"{instructions}\n\nDocument: \"{doc['name']}\"\n\n{material}"},
        ], model, 0.3)

    return stream_response(gen)


@app.post("/api/exam")
def exam():
    body = request.get_json(force=True)
    model = body.get("model") or DEFAULT_MODEL
    count = max(1, min(int(body.get("count", 10)), 40))
    qtype = body.get("qtype", "mcq")
    difficulty = body.get("difficulty", "medium")
    type_rules = {
        "mcq": "multiple-choice questions, each with 4 options labelled A) B) C) D) and exactly one correct answer",
        "truefalse": "True/False questions",
        "short": "short-answer questions (1-3 sentence answers)",
        "mixed": "a mix of multiple-choice (A-D), True/False, and short-answer questions",
    }.get(qtype, "multiple-choice questions")

    def gen():
        doc = get_doc(body.get("doc_id"))
        yield {"status": "Reading the document…"}
        material = spread_sample(chunk_text(doc["text"], 2000), CONTEXT_CHARS)
        yield {"status": "Writing your exam…"}
        prompt = (
            f"Create a {difficulty}-difficulty exam of exactly {count} {type_rules}, based ONLY on the document below.\n\n"
            "Format in Markdown:\n"
            f"# Exam: {doc['name']}\n"
            "Then number the questions 1..N. Do not reveal answers next to the questions.\n"
            "After all questions, add a section '## Answer Key' listing the correct answer for every question "
            "with a one-line explanation.\n\n"
            f"--- DOCUMENT ---\n{material}\n--- END ---"
        )
        yield from ollama_stream([
            {"role": "system", "content": "You are an experienced teacher who writes fair, clear exams."},
            {"role": "user", "content": prompt},
        ], model, 0.5)

    return stream_response(gen)


if __name__ == "__main__":
    print("OfflineMindAI running at http://127.0.0.1:5000  (Ollama:", OLLAMA_URL, ")")
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), threaded=True, debug=False)
