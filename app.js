"use strict";

/* ---------- tiny helpers ---------- */
const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const isKanji = (ch) => {
  const c = ch.codePointAt(0);
  return (c >= 0x4e00 && c <= 0x9faf) || (c >= 0x3400 && c <= 0x4dbf);
};
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------- load a helper library on demand (never blocks page load) ---------- */
const scriptCache = new Map();
function loadScript(url) {
  if (scriptCache.has(url)) return scriptCache.get(url);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("could not load " + url));
    document.head.appendChild(s);
  });
  scriptCache.set(url, p);
  return p;
}
const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
const KUROMOJI_URL = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/build/kuromoji.js";

/* ---------- caches so we never fetch the same thing twice ---------- */
const kanjiCache = new Map();
const wordCache = new Map();

/* ---------- kanji info: try kanjiapi, fall back to Jotoba ---------- */
async function getKanji(ch) {
  if (kanjiCache.has(ch)) return kanjiCache.get(ch);
  let data = null;
  try {
    const r = await fetch("https://kanjiapi.dev/v1/kanji/" + encodeURIComponent(ch));
    if (r.ok) {
      const j = await r.json();
      data = {
        char: ch,
        meanings: j.meanings || [],
        on: j.on_readings || [],
        kun: j.kun_readings || [],
        strokes: j.stroke_count || null,
      };
    }
  } catch (e) {
    /* fall through to Jotoba */
  }
  if (!data) {
    try {
      const j = await jotoba(ch);
      const k = j.kanji && j.kanji[0];
      if (k) {
        data = {
          char: ch,
          meanings: k.meanings || [],
          on: k.onyomi || [],
          kun: k.kunyomi || [],
          strokes: k.stroke_count || null,
        };
      }
    } catch (e) {
      /* give up */
    }
  }
  kanjiCache.set(ch, data);
  return data;
}

/* ---------- Jotoba word search (word meanings + example words) ---------- */
async function jotoba(query) {
  if (wordCache.has(query)) return wordCache.get(query);
  const r = await fetch("https://jotoba.de/api/search/words", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, language: "English", no_english: false }),
  });
  if (!r.ok) throw new Error("jotoba " + r.status);
  const j = await r.json();
  wordCache.set(query, j);
  return j;
}

/* example words that contain a kanji, from Jotoba */
async function getExamples(ch, exclude) {
  try {
    const j = await jotoba(ch);
    const out = [];
    for (const w of j.words || []) {
      const written = (w.reading && w.reading.kanji) || (w.reading && w.reading.kana);
      if (!written || !written.includes(ch)) continue;
      if (exclude && written === exclude) continue;
      const sense = (w.senses || [])[0];
      const gloss = sense ? (sense.glosses || []).slice(0, 3).join(", ") : "";
      out.push({
        written,
        reading: (w.reading && w.reading.kana) || "",
        meaning: gloss,
        common: !!w.common,
      });
      if (out.length >= 6) break;
    }
    // prefer common words, keep at least two
    out.sort((a, b) => (b.common ? 1 : 0) - (a.common ? 1 : 0));
    return out.slice(0, 3);
  } catch (e) {
    return [];
  }
}

/* whole-word meaning from Jotoba */
async function getWordMeaning(surface, reading) {
  try {
    const j = await jotoba(surface);
    let best = null;
    for (const w of j.words || []) {
      const written = (w.reading && w.reading.kanji) || (w.reading && w.reading.kana);
      if (written === surface) { best = w; break; }
      if (!best) best = w;
    }
    if (!best) return null;
    const glosses = [];
    for (const s of (best.senses || []).slice(0, 2)) {
      glosses.push((s.glosses || []).slice(0, 3).join(", "));
    }
    return {
      reading: reading || (best.reading && best.reading.kana) || "",
      meaning: glosses.filter(Boolean).join("; "),
    };
  } catch (e) {
    return null;
  }
}

/* ---------- stroke-order diagram URL (KanjiVG via jsDelivr) ---------- */
function strokeURL(ch) {
  const hex = ch.codePointAt(0).toString(16).padStart(5, "0");
  return "https://cdn.jsdelivr.net/gh/KanjiVG/kanjivg@master/kanji/" + hex + ".svg";
}

/* ---------- kuromoji tokenizer (lazy, optional, never blocks) ---------- */
let tokenizerPromise = null;
function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = loadScript(KUROMOJI_URL).then(
      () =>
        new Promise((resolve, reject) => {
          if (typeof kuromoji === "undefined" || !kuromoji.builder) {
            reject(new Error("grammar library not ready"));
            return;
          }
          kuromoji
            .builder({ dicPath: "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/" })
            .build((err, tok) => (err ? reject(err) : resolve(tok)));
        })
    );
  }
  return tokenizerPromise;
}
/* The grammar helper is OPTIONAL. We load it quietly in the background and, if
   it ever finishes, store it here. analyze() only uses it if it's ready, so
   nothing ever waits for the big dictionary. */
let readyTokenizer = null;
function warmUpTokenizer() {
  getTokenizer().then((t) => { readyTokenizer = t; }).catch(() => {});
}

/* ---------- passive form from a kuromoji verb token ---------- */
const GODAN_MAP = {
  "う": "わ", "く": "か", "ぐ": "が", "す": "さ", "つ": "た",
  "ぬ": "な", "ぶ": "ば", "む": "ま", "る": "ら",
};
function makePassive(token) {
  const base = token.basic_form;        // dictionary form, e.g. 書く
  const type = token.conjugated_type || "";
  if (!base || base === "*") return null;
  const last = base.slice(-1);

  if (type.startsWith("一段")) {
    // 食べる -> 食べられる
    if (last !== "る") return null;
    return base.slice(0, -1) + "られる";
  }
  if (type.startsWith("五段")) {
    const a = GODAN_MAP[last];
    if (!a) return null;
    return base.slice(0, -1) + a + "れる"; // 書く -> 書かれる
  }
  if (type.startsWith("サ変")) {
    // 勉強する -> 勉強される,  する -> される
    if (base.endsWith("する")) return base.slice(0, -2) + "される";
    return null;
  }
  if (type.startsWith("カ変")) {
    // 来る -> 来られる
    return base.replace(/来る$/, "来られる").replace(/くる$/, "こられる");
  }
  return null;
}

/* ---------- rendering ---------- */
const results = $("#results");

async function renderKanji(ch, container) {
  const card = el("div", "kanji-card");
  card.appendChild(el("div", "notice", '<span class="spin"></span>Looking up ' + esc(ch) + "…"));
  container.appendChild(card);

  const [info, examples] = await Promise.all([getKanji(ch), getExamples(ch)]);
  card.innerHTML = "";

  if (!info) {
    card.appendChild(el("div", "notice", "Couldn’t load dictionary data for " + esc(ch) + "."));
    return;
  }

  const top = el("div", "kanji-top");
  top.appendChild(el("div", "kanji-glyph", esc(ch)));

  const facts = el("div", "kanji-facts");
  facts.appendChild(el("p", "kanji-meaning", esc(info.meanings.join(", ") || "—")));

  const readings = el("ul", "readings");
  const onVals = info.on.length ? info.on.map((x) => "<span>" + esc(x) + "</span>").join("") : "—";
  const kunVals = info.kun.length ? info.kun.map((x) => "<span>" + esc(x) + "</span>").join("") : "—";
  readings.appendChild(el("li", null,
    '<span class="reading-tag">On’yomi</span><span class="reading-vals" lang="ja">' + onVals + "</span>"));
  readings.appendChild(el("li", null,
    '<span class="reading-tag">Kun’yomi</span><span class="reading-vals" lang="ja">' + kunVals + "</span>"));
  facts.appendChild(readings);
  top.appendChild(facts);

  // stroke order
  const stroke = el("div", "stroke-wrap");
  const img = el("img", "stroke-img");
  img.loading = "lazy";
  img.alt = "Stroke order for " + ch;
  img.src = strokeURL(ch);
  img.onerror = () => { stroke.innerHTML = '<p class="notice">No stroke diagram available.</p>'; };
  stroke.appendChild(img);
  if (info.strokes) stroke.appendChild(el("p", "stroke-count", info.strokes + " strokes"));
  top.appendChild(stroke);

  card.appendChild(top);

  // examples
  card.appendChild(el("p", "section-title", "Example words"));
  if (examples.length) {
    const ul = el("ul", "examples");
    for (const ex of examples) {
      const li = el("li");
      li.appendChild(el("span", "ex-word", '<span lang="ja">' + esc(ex.written) + "</span>"));
      if (ex.reading) li.appendChild(el("span", "ex-reading", '<span lang="ja">' + esc(ex.reading) + "</span>"));
      if (ex.meaning) li.appendChild(el("p", "ex-meaning", esc(ex.meaning)));
      ul.appendChild(li);
    }
    card.appendChild(ul);
  } else {
    card.appendChild(el("p", "notice", "No example words found."));
  }
}

/* render a whole word (with meaning), then each of its kanji */
async function renderWord(surface, reading, opts = {}) {
  const block = el("div", "word-block");
  if (opts.passiveOf) {
    block.appendChild(el("span", "passive-tag", "Passive form"));
  }
  const head = el("div", "word-head");
  head.appendChild(el("span", "word-surface", '<span lang="ja">' + esc(surface) + "</span>"));
  block.appendChild(head);
  const mp = el("p", "word-meaning", '<span class="spin"></span>Looking up meaning…');
  block.appendChild(mp);
  if (opts.passiveOf) {
    block.appendChild(el("p", "passive-note",
      "Passive of " + esc(opts.passiveOf) + " — “to be …-ed”. The kanji below are the same as in the plain verb."));
  }
  results.appendChild(block);

  const wm = await getWordMeaning(surface, reading);
  if (wm) {
    head.appendChild(el("span", "word-reading", '<span lang="ja">' + esc(wm.reading) + "</span>"));
    mp.className = "word-meaning";
    mp.textContent = wm.meaning || "(no English meaning found)";
  } else {
    mp.className = "word-meaning notice";
    mp.textContent = "No dictionary meaning found for this word.";
  }

  const kanjiList = [...surface].filter(isKanji);
  const seen = new Set();
  for (const ch of kanjiList) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    await renderKanji(ch, results);
  }
}

/* ---------- main analysis ---------- */
let running = false;
async function analyze(text) {
  text = (text || "").trim();
  if (!text) return;
  if (running) return;
  running = true;
  results.innerHTML = "";
  const loading = el("div", "panel notice", '<span class="spin"></span>Looking up…');
  results.appendChild(loading);

  try {
    // Use the grammar helper ONLY if it is already loaded — never wait for it,
    // so a single kanji (or a phone) is never stuck behind the big dictionary.
    let tokens = null;
    if (readyTokenizer) {
      try { tokens = readyTokenizer.tokenize(text); } catch (e) { tokens = null; }
    }
    loading.remove();

    if (tokens) {
      const done = new Set();
      for (const t of tokens) {
        const surface = t.surface_form;
        if (!surface || !surface.trim()) continue;
        const hasKanji = [...surface].some(isKanji);

        // verbs with okurigana -> show plain word + passive form
        if (t.pos === "動詞" && hasKanji) {
          const reading = t.reading || "";
          await renderWord(t.basic_form && t.basic_form !== "*" ? t.basic_form : surface, "", {});
          const passive = makePassive(t);
          if (passive) {
            await renderWord(passive, "", { passiveOf: t.basic_form || surface });
          }
          continue;
        }

        // any other chunk that contains kanji -> treat as a word
        if (hasKanji) {
          const key = surface;
          if (done.has(key)) continue;
          done.add(key);
          await renderWord(surface, t.reading || "", {});
        }
      }
      // nothing had kanji? fall back to word grouping
      if (!results.children.length) await analyzeWithoutGrammar(text);
    } else {
      await analyzeWithoutGrammar(text);
    }

    if (!results.children.length) {
      results.appendChild(el("div", "panel error-box", "No kanji found in that text. Try a clearer photo or type the characters directly."));
    }
  } catch (e) {
    results.innerHTML = "";
    results.appendChild(el("div", "panel error-box", "Something went wrong: " + esc(e.message)));
  } finally {
    running = false;
  }
}

/* fallback when the grammar helper isn't loaded: split into runs of Japanese
   text and look each up as a word (meaning + its kanji). No big dictionary. */
async function analyzeWithoutGrammar(text) {
  const runs = text.match(/[぀-ヿ㐀-鿿ｦ-ﾟ]+/g) || [];
  const seen = new Set();
  let any = false;
  for (const run of runs) {
    if (![...run].some(isKanji)) continue;
    if (seen.has(run)) continue;
    seen.add(run);
    any = true;
    await renderWord(run, "", {});
  }
  // if we still found nothing, list any loose kanji one by one
  if (!any) {
    const s = new Set();
    for (const ch of text) {
      if (!isKanji(ch) || s.has(ch)) continue;
      s.add(ch);
      await renderKanji(ch, results);
    }
  }
}

/* ---------- OCR ---------- */
const previewPanel = $("#preview-panel");
const previewImg = $("#preview-img");
const ocrStatus = $("#ocr-status");
const ocrReview = $("#ocr-review");
const ocrText = $("#ocr-text");

/* Clean any picture (photo OR drawing) so Tesseract can read it: right size,
   pure black & white, white border. Works on an <img> or a <canvas>. */
function cleanForOCR(drawable, srcW, srcH) {
  const target = 1400;
  const scale = target / Math.max(srcW, srcH);
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const pad = Math.round(Math.max(w, h) * 0.15); // white margin

  const canvas = document.createElement("canvas");
  canvas.width = w + pad * 2;
  canvas.height = h + pad * 2;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(drawable, pad, pad, w, h);

  const imgData = ctx.getImageData(pad, pad, w, h);
  const px = imgData.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    const g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
    px[i] = px[i + 1] = px[i + 2] = g;
    sum += g;
  }
  const mean = sum / (px.length / 4);
  const thr = mean * 0.82;
  for (let i = 0; i < px.length; i += 4) {
    const v = px[i] < thr ? 0 : 255;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(imgData, pad, pad);
  return canvas;
}

/* load an image file, then clean it */
function preprocess(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(cleanForOCR(img, img.width, img.height));
    img.onerror = () => reject(new Error("could not open that image"));
    img.src = URL.createObjectURL(file);
  });
}

// page-segmentation modes to try, in order: single block, then single character
const PSM_TRIES = ["6", "10"];

async function recognizeKanji(canvas) {
  const worker = await Tesseract.createWorker("jpn", 1, {
    logger: (m) => {
      if (m.status === "recognizing text") {
        ocrStatus.innerHTML = '<span class="spin"></span>Reading… ' + Math.round(m.progress * 100) + "%";
      }
    },
  });
  try {
    let best = "";
    for (const psm of PSM_TRIES) {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(canvas);
      const clean = (data.text || "").replace(/\s+/g, "");
      const kanjiCount = [...clean].filter(isKanji).length;
      if (kanjiCount > [...best].filter(isKanji).length) best = clean;
      if (kanjiCount > 0 && psm === "6") break; // block mode already found kanji
    }
    return best;
  } finally {
    await worker.terminate();
  }
}

/* shared: take an already-cleaned canvas, read it, show the result */
async function runOCR(cleanCanvas) {
  previewPanel.classList.remove("hidden");
  previewImg.src = cleanCanvas.toDataURL(); // show exactly what we read
  ocrReview.classList.add("hidden");
  ocrStatus.className = "status";
  ocrStatus.innerHTML = '<span class="spin"></span>Getting the text-reader ready…';
  results.innerHTML = "";

  try {
    await loadScript(TESSERACT_URL);
    if (typeof Tesseract === "undefined") throw new Error("text-reader could not load (check your internet)");
    ocrStatus.innerHTML = '<span class="spin"></span>Reading the character…';

    const clean = await recognizeKanji(cleanCanvas);
    const hasKanji = [...clean].some(isKanji);
    ocrStatus.textContent = hasKanji
      ? "Here’s what I read — fix it if needed:"
      : "I couldn’t clearly read a kanji. Type it in the box below, or try again bigger and clearer.";
    ocrText.value = clean;
    ocrReview.classList.remove("hidden");
    if (hasKanji) analyze(clean); // show results right away; user can still fix + re-run
  } catch (e) {
    ocrStatus.className = "status error";
    ocrStatus.textContent = "Couldn’t read the image: " + e.message;
    ocrReview.classList.remove("hidden");
  }
}

async function handleImage(file) {
  if (!file || !file.type.startsWith("image/")) return;
  previewPanel.classList.remove("hidden");
  ocrStatus.className = "status";
  ocrStatus.innerHTML = '<span class="spin"></span>Cleaning up your image…';
  try {
    const canvas = await preprocess(file);
    await runOCR(canvas);
  } catch (e) {
    ocrStatus.className = "status error";
    ocrStatus.textContent = "Couldn’t open the image: " + e.message;
  }
}

/* ---------- handwriting recognition (Google input tools) ---------- */
async function recognizeHandwriting(strokes, w, h) {
  const ink = strokes.map((s) => [s.x, s.y]);
  const body = {
    options: "enable_pre_space",
    requests: [{
      writing_guide: { writing_area_width: w, writing_area_height: h },
      ink,
      language: "ja",
      max_num_results: 10,
    }],
  };
  const r = await fetch(
    "https://inputtools.google.com/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!r.ok) throw new Error("recogniser unreachable (" + r.status + ")");
  const j = await r.json();
  if (j[0] !== "SUCCESS") throw new Error("could not read the drawing");
  const cands = (j[1] && j[1][0] && j[1][0][1]) || [];
  // put kanji guesses first, keep the rest as backups
  return cands.sort((a, b) => {
    const ak = [...a].some(isKanji) ? 0 : 1;
    const bk = [...b].some(isKanji) ? 0 : 1;
    return ak - bk;
  });
}

/* show the guesses as tappable buttons; tapping one analyses it */
function renderCandidates(cands, chosen) {
  const box = $("#candidates");
  box.innerHTML = "";
  box.appendChild(el("span", "cand-label", "Not right? Tap the character you drew:"));
  const row = el("div", "cand-row");
  cands.slice(0, 10).forEach((c) => {
    const b = el("button", "cand-btn" + (c === chosen ? " active" : ""), esc(c));
    b.type = "button";
    b.lang = "ja";
    b.addEventListener("click", () => {
      [...row.children].forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      ocrText.value = c;
      analyze(c);
    });
    row.appendChild(b);
  });
  box.appendChild(row);
  box.classList.remove("hidden");
}

/* ---------- draw-a-kanji pad (uses the finished strokes; the correct kanji
   appears in the guess list whatever order you draw in) ---------- */
function setupDrawPad() {
  const canvas = $("#draw-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let strokes = [];
  let current = null;

  function clearPad() {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 14;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111";
    strokes = [];
    current = null;
  }
  clearPad();

  let drawing = false;
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - r.left) * (canvas.width / r.width)),
      y: Math.round((e.clientY - r.top) * (canvas.height / r.height)),
    };
  }
  function start(e) {
    if (drawing) return;            // ignore extra fingers
    e.preventDefault();
    drawing = true;
    const p = pos(e);
    current = { x: [p.x], y: [p.y] };
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.1, p.y + 0.1);
    ctx.stroke();
  }
  function move(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    current.x.push(p.x);
    current.y.push(p.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  function stop() {
    if (drawing && current && current.x.length) strokes.push(current);
    drawing = false;
    current = null;
  }
  // Start on the canvas; track move/end on the whole window so a stroke never
  // gets cut off and the pad keeps accepting new strokes forever.
  canvas.addEventListener("pointerdown", start);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);

  $("#draw-clear").addEventListener("click", () => {
    clearPad();
    $("#candidates").classList.add("hidden");
  });

  $("#draw-read").addEventListener("click", async () => {
    previewPanel.classList.remove("hidden");
    $("#candidates").classList.add("hidden");
    ocrReview.classList.add("hidden");
    ocrStatus.className = "status";
    previewImg.src = canvas.toDataURL();
    if (!strokes.length) {
      ocrStatus.textContent = "Draw a kanji first, then tap “Read this kanji”.";
      return;
    }
    ocrStatus.innerHTML = '<span class="spin"></span>Recognising your drawing…';
    results.innerHTML = "";
    try {
      const cands = await recognizeHandwriting(strokes, canvas.width, canvas.height);
      if (!cands.length) {
        ocrStatus.textContent = "Couldn’t recognise that. Try drawing it a bit bigger and clearer.";
        return;
      }
      const primary = cands[0];
      ocrStatus.textContent = "I think you drew:";
      ocrText.value = primary;
      ocrReview.classList.remove("hidden");
      renderCandidates(cands, primary);
      analyze(primary);
    } catch (e) {
      ocrStatus.className = "status error";
      ocrStatus.textContent = "Couldn’t recognise the drawing: " + e.message;
    }
  });
}
setupDrawPad();

/* ---------- wiring ---------- */
$("#file-input").addEventListener("change", (e) => handleImage(e.target.files[0]));
$("#camera-input").addEventListener("change", (e) => handleImage(e.target.files[0]));
$("#analyze-btn").addEventListener("click", () => analyze($("#text-input").value));
$("#text-input").addEventListener("keydown", (e) => { if (e.key === "Enter") analyze(e.target.value); });
$("#ocr-analyze-btn").addEventListener("click", () => analyze(ocrText.value));
ocrText.addEventListener("keydown", (e) => { if (e.key === "Enter") analyze(e.target.value); });

const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("dragover"); }));
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("dragover"); }));
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleImage(f);
});

/* if anything ever crashes, show it on the page instead of failing silently */
window.addEventListener("error", (e) => {
  if (!results.children.length) {
    results.appendChild(el("div", "panel error-box",
      "A script error occurred: " + esc(e.message || "unknown") +
      ". The page may not have loaded fully — please refresh."));
  }
});

/* Quietly load the optional grammar helper a few seconds after the page is
   ready, so passive-verb detection works later WITHOUT ever blocking a tap. */
setTimeout(warmUpTokenizer, 4000);
