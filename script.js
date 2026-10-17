/* OfflineMindAI - chat interaction (no external libraries, works offline) */
(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    sidebar: $("sidebar"), scrim: $("scrim"), menuBtn: $("menuBtn"), newChat: $("newChat"),
    history: $("history"), statusDot: $("statusDot"), statusText: $("statusText"),
    modelSelect: $("modelSelect"), chat: $("chat"), welcome: $("welcome"), messages: $("messages"),
    input: $("input"), sendBtn: $("sendBtn"), attachBtn: $("attachBtn"), fileInput: $("fileInput"),
    docRow: $("docRow"), docName: $("docName"), docRemove: $("docRemove"),
    summarizeBtn: $("summarizeBtn"), examBtn: $("examBtn"),
    examModal: $("examModal"), examCount: $("examCount"), examType: $("examType"),
    examDifficulty: $("examDifficulty"), examCancel: $("examCancel"), examGo: $("examGo"),
    sumModal: $("sumModal"), sumStyle: $("sumStyle"), sumCancel: $("sumCancel"), sumGo: $("sumGo"),
    toast: $("toast"),
  };

  const STORE = "offlinemindai.v1";
  let state = { chats: [], currentId: null, model: "" };
  let controller = null; // AbortController while generating
  let busy = false;

  /* ---------- storage ---------- */
  function load() {
    try { state = Object.assign(state, JSON.parse(localStorage.getItem(STORE) || "{}")); } catch (e) { /* ignore */ }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }
  const current = () => state.chats.find((c) => c.id === state.currentId);
  function newChat() {
    if (busy) return;
    const empty = state.chats.find((c) => c.messages.length === 0 && !c.doc);
    if (empty) { state.currentId = empty.id; }
    else {
      const c = { id: "c" + Date.now(), title: "New chat", messages: [], doc: null };
      state.chats.unshift(c);
      state.currentId = c.id;
    }
    save(); renderAll(); el.input.focus();
  }

  /* ---------- helpers ---------- */
  function toast(msg) {
    el.toast.textContent = msg; el.toast.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (el.toast.hidden = true), 3500);
  }
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  function scrollDown(force) {
    const c = el.chat;
    if (force || c.scrollHeight - c.scrollTop - c.clientHeight < 160) c.scrollTop = c.scrollHeight;
  }
  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    a.download = name; a.click(); URL.revokeObjectURL(a.href);
  }

  /* ---------- markdown renderer ---------- */
  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }
  function markdown(src) {
    const blocks = [];
    src = src.replace(/```(\w*)\n([\s\S]*?)(```|$)/g, (m, lang, code) => {
      blocks.push({ lang, code: code.replace(/\n$/, "") });
      return "\n\u0000" + (blocks.length - 1) + "\u0000\n";
    });
    const lines = src.split("\n");
    let html = "", i = 0;
    const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l || "");
    const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    while (i < lines.length) {
      const l = lines[i];
      let m;
      if (!l.trim()) { i++; continue; }
      if ((m = l.match(/^\u0000(\d+)\u0000$/))) {
        const b = blocks[+m[1]];
        html += `<div class="code-block"><div class="code-head"><span>${esc(b.lang || "code")}</span><button class="copy-code">Copy code</button></div><pre><code>${esc(b.code)}</code></pre></div>`;
        i++; continue;
      }
      if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; i++; continue; }
      if (/^\s*([-*_])\1{2,}\s*$/.test(l)) { html += "<hr>"; i++; continue; }
      if (l.includes("|") && isTableSep(lines[i + 1])) {
        const head = cells(l); i += 2;
        let rows = "";
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          rows += "<tr>" + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>"; i++;
        }
        html += `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
        continue;
      }
      if (/^\s*[-*+]\s+/.test(l)) {
        let items = "";
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items += `<li>${inline(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`; i++; }
        html += `<ul>${items}</ul>`; continue;
      }
      if (/^\s*\d+[.)]\s+/.test(l)) {
        const start = parseInt(l.match(/^\s*(\d+)/)[1], 10);
        let items = "";
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items += `<li>${inline(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`; i++; }
        html += `<ol start="${start}">${items}</ol>`; continue;
      }
      if (/^>\s?/.test(l)) {
        let q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, "")); i++; }
        html += `<blockquote>${inline(q.join(" "))}</blockquote>`; continue;
      }
      let p = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*[-*+]\s|\s*\d+[.)]\s|>|\u0000)/.test(lines[i])) { p.push(lines[i]); i++; }
      html += `<p>${inline(p.join("<br>").replace(/<br>/g, "\n")).replace(/\n/g, "<br>")}</p>`;
      if (!p.length) i++;
    }
    return html;
  }

  /* ---------- rendering ---------- */
  function renderHistory() {
    el.history.innerHTML = "";
    state.chats.forEach((c) => {
      const d = document.createElement("div");
      d.className = "hist-item" + (c.id === state.currentId ? " active" : "");
      d.innerHTML = `<span>${esc(c.title)}</span><button class="hist-del" title="Delete chat">✕</button>`;
      d.addEventListener("click", () => { if (!busy) { state.currentId = c.id; save(); renderAll(); closeSidebar(); } });
      d.querySelector(".hist-del").addEventListener("click", (e) => {
        e.stopPropagation(); if (busy) return;
        if (c.doc) fetch("/api/docs/" + c.doc.id, { method: "DELETE" }).catch(() => {});
        state.chats = state.chats.filter((x) => x.id !== c.id);
        if (state.currentId === c.id) state.currentId = state.chats[0] ? state.chats[0].id : null;
        if (!state.chats.length) return newChat();
        save(); renderAll();
      });
      el.history.appendChild(d);
    });
  }
  function messageNode(role, text) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + role;
    if (role === "user") {
      const b = document.createElement("div"); b.className = "bubble"; b.textContent = text; wrap.appendChild(b);
    } else {
      wrap.innerHTML = `<div class="avatar">O</div><div class="body"><div class="content"></div></div>`;
      wrap.querySelector(".body").style.cssText = "flex:1;min-width:0";
      if (text) setAssistant(wrap, text, true);
    }
    return wrap;
  }
  function setAssistant(node, text, final) {
    const content = node.querySelector(".content");
    content.innerHTML = markdown(text);
    const old = node.querySelector(".msg-tools"); if (old) old.remove();
    if (final && text) {
      const tools = document.createElement("div"); tools.className = "msg-tools";
      tools.innerHTML = `<button class="tool-btn" data-a="copy">Copy</button><button class="tool-btn" data-a="dl">Download .md</button>`;
      tools.addEventListener("click", (e) => {
        const a = e.target.dataset.a;
        if (a === "copy") navigator.clipboard.writeText(text).then(() => toast("Copied"));
        if (a === "dl") download("offlinemindai-" + Date.now() + ".md", text);
      });
      node.querySelector(".body").appendChild(tools);
    }
  }
  function renderDoc() {
    const c = current();
    el.docRow.hidden = !(c && c.doc);
    el.docName.textContent = c && c.doc ? c.doc.name : "";
  }
  function renderMessages() {
    const c = current();
    el.messages.innerHTML = "";
    el.welcome.style.display = c && c.messages.length ? "none" : "";
    if (c) c.messages.forEach((m) => el.messages.appendChild(messageNode(m.role, m.content)));
    scrollDown(true);
  }
  function renderAll() { renderHistory(); renderMessages(); renderDoc(); updateSend(); }

  function updateSend() {
    el.sendBtn.classList.toggle("stop", busy);
    el.sendBtn.disabled = !busy && !el.input.value.trim();
    el.sendBtn.setAttribute("aria-label", busy ? "Stop generating" : "Send");
  }

  /* ---------- streaming ---------- */
  async function stream(url, body, node, onDone) {
    busy = true; updateSend();
    controller = new AbortController();
    const content = node.querySelector(".content");
    content.innerHTML = '<span class="status-line">Thinking</span>';
    let full = "", raf = 0, failed = false;
    const paint = () => { raf = 0; setAssistant(node, full, false); scrollDown(); };
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error("Server error " + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const ln = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!ln) continue;
          const msg = JSON.parse(ln);
          if (msg.status && !full) content.innerHTML = `<span class="status-line">${esc(msg.status)}</span>`;
          if (msg.token) { full += msg.token; if (!raf) raf = requestAnimationFrame(paint); }
          if (msg.error) { failed = true; full += (full ? "\n\n" : "") + "⚠️ " + msg.error; }
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") { failed = true; full += (full ? "\n\n" : "") + "⚠️ " + e.message; }
    } finally {
      cancelAnimationFrame(raf);
      busy = false; controller = null;
      if (!full) full = "_(stopped)_";
      setAssistant(node, full, true);
      onDone(full, failed);
      updateSend(); scrollDown();
    }
  }

  function addTurn(userText, run) {
    const c = current();
    el.welcome.style.display = "none";
    if (userText) {
      c.messages.push({ role: "user", content: userText });
      el.messages.appendChild(messageNode("user", userText));
      if (c.title === "New chat") { c.title = userText.slice(0, 40); renderHistory(); }
    }
    const node = messageNode("assistant", "");
    el.messages.appendChild(node);
    scrollDown(true);
    run(node, c);
  }

  function finish(c) {
    return (text, failed) => {
      c.messages.push({ role: "assistant", content: text });
      save();
    };
  }

  /* ---------- actions ---------- */
  function send() {
    if (busy) { controller && controller.abort(); return; }
    const text = el.input.value.trim();
    if (!text) return;
    el.input.value = ""; autosize();
    addTurn(text, (node, c) => {
      stream("/api/chat", {
        model: state.model, doc_id: c.doc ? c.doc.id : null,
        messages: c.messages.map((m) => ({ role: m.role, content: m.content })),
      }, node, finish(c));
    });
  }
  function summarize() {
    const c = current(); if (!c || !c.doc || busy) return;
    el.sumModal.hidden = true;
    addTurn(`Summarize "${c.doc.name}" (${el.sumStyle.value})`, (node) => {
      stream("/api/summarize", { model: state.model, doc_id: c.doc.id, style: el.sumStyle.value }, node, finish(c));
    });
  }
  function exam() {
    const c = current(); if (!c || !c.doc || busy) return;
    el.examModal.hidden = true;
    const count = Math.max(1, Math.min(40, parseInt(el.examCount.value, 10) || 10));
    addTurn(`Generate a ${el.examDifficulty.value} exam with ${count} questions (${el.examType.options[el.examType.selectedIndex].text}) from "${c.doc.name}"`, (node) => {
      stream("/api/exam", {
        model: state.model, doc_id: c.doc.id, count,
        qtype: el.examType.value, difficulty: el.examDifficulty.value,
      }, node, finish(c));
    });
  }
  async function upload(file) {
    if (!file) return;
    if (!current()) newChat();
    toast("Reading " + file.name + "…");
    const fd = new FormData(); fd.append("file", file);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      const c = current();
      if (c.doc) fetch("/api/docs/" + c.doc.id, { method: "DELETE" }).catch(() => {});
      c.doc = { id: data.id, name: data.name };
      if (c.title === "New chat") c.title = data.name.slice(0, 40);
      save(); renderHistory(); renderDoc();
      toast(`${data.name} loaded (${data.words.toLocaleString()} words)`);
    } catch (e) { toast(e.message); }
    el.fileInput.value = "";
  }
  function removeDoc() {
    const c = current(); if (!c || !c.doc) return;
    fetch("/api/docs/" + c.doc.id, { method: "DELETE" }).catch(() => {});
    c.doc = null; save(); renderDoc();
  }

  /* ---------- status + models ---------- */
  async function loadModels() {
    try {
      const r = await (await fetch("/api/models")).json();
      el.modelSelect.innerHTML = "";
      if (!r.ok || !r.models.length) {
        el.statusDot.className = "dot off";
        el.statusText.textContent = r.ok ? "No models installed" : "Ollama not running";
        const o = new Option(r.default, r.default); el.modelSelect.add(o);
        state.model = state.model || r.default;
        return;
      }
      r.models.forEach((m) => el.modelSelect.add(new Option(m, m)));
      if (!r.models.includes(state.model)) {
        state.model = r.models.find((m) => m.startsWith(r.default)) || r.models[0];
      }
      el.modelSelect.value = state.model;
      el.statusDot.className = "dot on";
      el.statusText.textContent = "Ollama connected · offline";
      save();
    } catch (e) {
      el.statusDot.className = "dot off"; el.statusText.textContent = "Server unreachable";
    }
  }

  /* ---------- ui wiring ---------- */
  function autosize() { el.input.style.height = "auto"; el.input.style.height = Math.min(el.input.scrollHeight, 200) + "px"; updateSend(); }
  function openSidebar() { el.sidebar.classList.add("open"); el.scrim.classList.add("show"); }
  function closeSidebar() { el.sidebar.classList.remove("open"); el.scrim.classList.remove("show"); }

  el.input.addEventListener("input", autosize);
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) send(); }
  });
  el.sendBtn.addEventListener("click", send);
  el.newChat.addEventListener("click", () => { newChat(); closeSidebar(); });
  el.menuBtn.addEventListener("click", openSidebar);
  el.scrim.addEventListener("click", closeSidebar);
  el.modelSelect.addEventListener("change", () => { state.model = el.modelSelect.value; save(); });
  el.attachBtn.addEventListener("click", () => el.fileInput.click());
  el.fileInput.addEventListener("change", () => upload(el.fileInput.files[0]));
  el.docRemove.addEventListener("click", removeDoc);
  el.summarizeBtn.addEventListener("click", () => (el.sumModal.hidden = false));
  el.examBtn.addEventListener("click", () => (el.examModal.hidden = false));
  el.sumCancel.addEventListener("click", () => (el.sumModal.hidden = true));
  el.examCancel.addEventListener("click", () => (el.examModal.hidden = true));
  el.sumGo.addEventListener("click", summarize);
  el.examGo.addEventListener("click", exam);
  [el.sumModal, el.examModal].forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.hidden = true; }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { el.sumModal.hidden = true; el.examModal.hidden = true; closeSidebar(); } });

  // copy-code buttons (event delegation)
  el.messages.addEventListener("click", (e) => {
    if (!e.target.classList.contains("copy-code")) return;
    const code = e.target.closest(".code-block").querySelector("code").textContent;
    navigator.clipboard.writeText(code).then(() => { e.target.textContent = "Copied!"; setTimeout(() => (e.target.textContent = "Copy code"), 1500); });
  });

  // drag & drop a file anywhere
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });

  /* ---------- init ---------- */
  load();
  if (!state.chats.length || !current()) {
    if (!state.chats.length) { state.chats.push({ id: "c" + Date.now(), title: "New chat", messages: [], doc: null }); }
    state.currentId = state.chats[0].id;
  }
  renderAll();
  loadModels();
  setInterval(loadModels, 30000);
})();