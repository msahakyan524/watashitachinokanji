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
const isKatakana = (ch) => {
  const c = ch.codePointAt(0);
  return (c >= 0x30a0 && c <= 0x30ff) || (c >= 0xff66 && c <= 0xff9f); // incl. half-width
};
const isHiragana = (ch) => {
  const c = ch.codePointAt(0);
  return c >= 0x3040 && c <= 0x309f;
};
// any Japanese script (used to reject Latin letters from recognition)
const isJapanese = (ch) => isKanji(ch) || isKatakana(ch) || isHiragana(ch);
// a character worth looking up on its own: kanji or katakana
const isLookup = (ch) => isKanji(ch) || isKatakana(ch);
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
    s.onerror = () => reject(new Error("չհաջողվեց բեռնել՝ " + url));
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

/* example COMPOUND words (2+ kanji) that use this kanji, from kanjiapi.dev.
   kanjiapi lists thousands of compounds and marks common ones via "priorities". */
async function getExamples(ch) {
  try {
    const r = await fetch("https://kanjiapi.dev/v1/words/" + encodeURIComponent(ch));
    if (r.ok) {
      const data = await r.json();
      const out = [];
      const seen = new Set();
      for (const entry of data) {
        const meaning = ((entry.meanings && entry.meanings[0] && entry.meanings[0].glosses) || [])
          .slice(0, 3).join(", ");
        for (const v of entry.variants || []) {
          const written = v.written || "";
          if (!written.includes(ch)) continue;
          if ([...written].filter(isKanji).length < 2) continue; // 2+ kanji
          if (written.length > 4) continue;                       // keep short & common-looking
          if (seen.has(written)) continue;
          seen.add(written);
          out.push({
            written,
            reading: v.pronounced || "",
            meaning,
            common: v.priorities && v.priorities.length ? 1 : 0,
            allKanji: [...written].every(isKanji) ? 1 : 0,
            len: written.length,
          });
          break; // one variant per entry
        }
      }
      // common first, then all-kanji compounds, then shorter words
      out.sort((a, b) => (b.common - a.common) || (b.allKanji - a.allKanji) || (a.len - b.len));
      if (out.length) return out.slice(0, 4);
    }
  } catch (e) {
    /* fall through */
  }
  return [];
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

/* ---------- translation: English meaning -> Russian + Armenian ---------- */
const trCache = new Map();
async function translate(text, target) {
  const key = target + "|" + text;
  if (trCache.has(key)) return trCache.get(key);
  try {
    const r = await fetch(
      "https://api.mymemory.translated.net/get?q=" +
        encodeURIComponent(text) + "&langpair=en%7C" + target
    );
    const j = await r.json();
    const t = (j && j.responseData && j.responseData.translatedText) || "";
    trCache.set(key, t);
    return t;
  } catch (e) {
    return "";
  }
}

/* ---------- speak Japanese out loud (built into the browser) ---------- */
function speak(text) {
  try {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) {}
}
const SPEAKER_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';
function speakerBtn(text) {
  const b = el("button", "speak-btn", SPEAKER_SVG);
  b.type = "button";
  b.title = "Լսել արտասանությունը";
  b.setAttribute("aria-label", "Լսել արտասանությունը");
  b.addEventListener("click", (e) => { e.stopPropagation(); speak(text); });
  return b;
}

/* ---------- rendering ---------- */
const results = $("#results");

/* Build a meaning block: English, then Russian, then Armenian (each copyable) */
function meaningBlock(englishText, extraClass) {
  const wrap = el("div", "meaning-block" + (extraClass ? " " + extraClass : ""));
  const en = copyable(el("p", "m-line m-en",
    '<span class="lang">EN</span>' + esc(englishText || "—")), englishText || "");
  const ru = el("p", "m-line", '<span class="lang">RU</span><span class="spin"></span>');
  const hy = el("p", "m-line", '<span class="lang">HY</span><span class="spin"></span>');
  wrap.appendChild(en); wrap.appendChild(ru); wrap.appendChild(hy);
  function fill(node, label, text) {
    node.innerHTML = '<span class="lang">' + label + "</span>" + esc(text || "—");
    if (text) copyable(node, text);
  }
  if (englishText) {
    translate(englishText, "ru").then((t) => fill(ru, "RU", t));
    translate(englishText, "hy").then((t) => fill(hy, "HY", t));
  } else {
    fill(ru, "RU", ""); fill(hy, "HY", "");
  }
  return wrap;
}

/* mark a node as tap-to-copy */
function copyable(node, text) {
  node.classList.add("copyable");
  node.dataset.copy = text;
  node.title = "Սեղմիր՝ պատճենելու համար";
  return node;
}

async function renderKanji(ch, container) {
  const card = el("div", "kanji-card");
  card.appendChild(el("div", "notice", '<span class="spin"></span>Փնտրում եմ ' + esc(ch) + "…"));
  container.appendChild(card);

  const [info, examples] = await Promise.all([getKanji(ch), getExamples(ch)]);
  card.innerHTML = "";

  if (!info) {
    card.appendChild(el("div", "notice", "Չհաջողվեց բեռնել " + esc(ch) + "-ի տվյալները։"));
    return;
  }

  const top = el("div", "kanji-top");
  const glyphWrap = el("div", "glyph-wrap");
  glyphWrap.appendChild(copyable(el("div", "kanji-glyph", esc(ch)), ch));
  glyphWrap.appendChild(speakerBtn(ch));
  top.appendChild(glyphWrap);

  const facts = el("div", "kanji-facts");
  const meaningText = info.meanings.join(", ");
  facts.appendChild(meaningBlock(meaningText, "kanji-meaning"));

  const readings = el("ul", "readings");
  const onVals = info.on.length ? info.on.map((x) => "<span>" + esc(x) + "</span>").join("") : "—";
  const kunVals = info.kun.length ? info.kun.map((x) => "<span>" + esc(x) + "</span>").join("") : "—";
  readings.appendChild(el("li", null,
    '<span class="reading-tag">Օնյոմի</span><span class="reading-vals" lang="ja">' + onVals + "</span>"));
  readings.appendChild(el("li", null,
    '<span class="reading-tag">Կունյոմի</span><span class="reading-vals" lang="ja">' + kunVals + "</span>"));
  facts.appendChild(readings);
  top.appendChild(facts);

  // stroke order
  const stroke = el("div", "stroke-wrap");
  const img = el("img", "stroke-img");
  img.loading = "lazy";
  img.alt = "Գրելու հերթականությունը՝ " + ch;
  img.src = strokeURL(ch);
  img.onerror = () => { stroke.innerHTML = '<p class="notice">Գրելու սխեման հասանելի չէ։</p>'; };
  stroke.appendChild(img);
  if (info.strokes) stroke.appendChild(el("p", "stroke-count", info.strokes + " գիծ"));
  top.appendChild(stroke);

  card.appendChild(top);

  // examples
  card.appendChild(el("p", "section-title", "Գործածությամբ բառերի օրինակներ"));
  if (examples.length) {
    const ul = el("ul", "examples");
    for (const ex of examples) {
      const li = el("li", "example-item");
      const headRow = el("div", "ex-head");
      // furigana: reading written above the word using <ruby>
      const ruby = ex.reading
        ? '<ruby>' + esc(ex.written) + "<rt>" + esc(ex.reading) + "</rt></ruby>"
        : esc(ex.written);
      headRow.appendChild(copyable(el("span", "ex-word", '<span lang="ja">' + ruby + "</span>"), ex.written));
      headRow.appendChild(speakerBtn(ex.written));
      li.appendChild(headRow);
      if (ex.meaning) li.appendChild(meaningBlock(ex.meaning, "ex-meaning-block"));
      ul.appendChild(li);
    }
    card.appendChild(ul);
  } else {
    card.appendChild(el("p", "notice", "Երկու կանջիով օրինակ բառ չգտնվեց։"));
  }
}

/* render a whole word (with meaning), then each of its kanji */
async function renderWord(surface, reading, opts = {}) {
  const block = el("div", "word-block");
  if (opts.passiveOf) {
    block.appendChild(el("span", "passive-tag", "Կրավորական ձև"));
  }
  const head = el("div", "word-head");
  head.appendChild(copyable(el("span", "word-surface", '<span lang="ja">' + esc(surface) + "</span>"), surface));
  const readingSpan = el("span", "word-reading");
  head.appendChild(readingSpan);
  head.appendChild(speakerBtn(surface));
  block.appendChild(head);
  const mp = el("p", "word-meaning notice", '<span class="spin"></span>Փնտրում եմ իմաստը…');
  block.appendChild(mp);
  if (opts.passiveOf) {
    block.appendChild(el("p", "passive-note",
      esc(opts.passiveOf) + "-ի կրավորական ձևը։ Ներքևի կանջիները նույնն են։"));
  }
  results.appendChild(block);

  const wm = await getWordMeaning(surface, reading);
  // always show a reading (for katakana this is the kana itself)
  const shownReading = (wm && wm.reading) || reading || (isKatakana(surface[0]) ? surface : "");
  if (shownReading) readingSpan.innerHTML = '<span lang="ja">' + esc(shownReading) + "</span>";
  if (wm && wm.meaning) {
    mp.replaceWith(meaningBlock(wm.meaning));
  } else {
    mp.className = "word-meaning notice";
    mp.textContent = "Այս բառի իմաստը չգտնվեց։";
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
  const loading = el("div", "panel notice", '<span class="spin"></span>Փնտրում եմ…');
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
      results.appendChild(el("div", "panel error-box", "Այս տեքստում կանջի չգտնվեց։ Փորձիր ավելի հստակ նկար կամ ուղղակի մուտքագրիր նշանները։"));
    } else {
      saveState(text); // remember results + history until the tab is closed
    }
  } catch (e) {
    results.innerHTML = "";
    results.appendChild(el("div", "panel error-box", "Ինչ-որ բան այնպես չգնաց՝ " + esc(e.message)));
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
    // look up runs that contain a kanji OR katakana (skip pure hiragana particles)
    if (![...run].some(isLookup)) continue;
    if (seen.has(run)) continue;
    seen.add(run);
    any = true;
    await renderWord(run, "", {});
  }
  // if we still found nothing, list any loose kanji/katakana characters
  if (!any) {
    const s = new Set();
    for (const ch of text) {
      if (!isLookup(ch) || s.has(ch)) continue;
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

/* Clean any picture for OCR: right size, grayscale with a gentle contrast
   stretch, white margin. NOT hard black/white — the reader does better with a
   normal grayscale photo. Works on an <img> or a <canvas>. */
function cleanForOCR(drawable, srcW, srcH) {
  const target = 1600;
  const scale = Math.min(target / Math.max(srcW, srcH), 3); // upscale small, cap huge
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const pad = Math.round(Math.max(w, h) * 0.12); // white margin

  const canvas = document.createElement("canvas");
  canvas.width = w + pad * 2;
  canvas.height = h + pad * 2;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(drawable, pad, pad, w, h);

  const imgData = ctx.getImageData(pad, pad, w, h);
  const px = imgData.data;
  // grayscale + find range
  let lo = 255, hi = 0;
  for (let i = 0; i < px.length; i += 4) {
    const g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
    px[i] = px[i + 1] = px[i + 2] = g;
    if (g < lo) lo = g;
    if (g > hi) hi = g;
  }
  // gentle contrast stretch (map [lo,hi] -> [0,255]); keep grays, no binarize
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.max(0, Math.min(255, Math.round(((px[i] - lo) / range) * 255)));
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
    img.onerror = () => reject(new Error("չհաջողվեց բացել նկարը"));
    img.src = URL.createObjectURL(file);
  });
}

// page-segmentation modes to try, in order: single block, then single character
const PSM_TRIES = ["6", "10"];

async function recognizeKanji(canvas) {
  const worker = await Tesseract.createWorker("jpn", 1, {
    logger: (m) => {
      if (m.status === "recognizing text") {
        ocrStatus.innerHTML = '<span class="spin"></span>Կարդում եմ… ' + Math.round(m.progress * 100) + "%";
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

/* OCR.space — a free reader that is actually good at Japanese printed text */
async function ocrSpace(dataUrl) {
  const body = new URLSearchParams();
  body.set("apikey", "helloworld"); // free demo key
  body.set("OCREngine", "3");       // engine 3 reads Japanese far better than 1
  body.set("scale", "true");
  body.set("detectOrientation", "true");
  body.set("base64Image", dataUrl);
  const r = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const j = await r.json();
  if (j.IsErroredOnProcessing) {
    throw new Error(Array.isArray(j.ErrorMessage) ? j.ErrorMessage.join(" ") : (j.ErrorMessage || "OCR error"));
  }
  const t = (j.ParsedResults && j.ParsedResults[0] && j.ParsedResults[0].ParsedText) || "";
  return t.replace(/\s+/g, "");
}

/* shared: take an already-cleaned canvas, read it, show the result */
async function runOCR(cleanCanvas) {
  previewPanel.classList.remove("hidden");
  previewImg.src = cleanCanvas.toDataURL(); // show exactly what we read
  ocrReview.classList.add("hidden");
  ocrStatus.className = "status";
  ocrStatus.innerHTML = '<span class="spin"></span>Կարդում եմ նշանը…';
  results.innerHTML = "";

  let clean = "";
  // 1) OCR.space first (best for Japanese); JPEG keeps it under the size limit
  try {
    clean = await ocrSpace(cleanCanvas.toDataURL("image/jpeg", 0.85));
  } catch (e) {
    clean = "";
  }
  // 2) fall back to Tesseract only if OCR.space found no kanji/katakana
  if (![...clean].some(isLookup)) {
    try {
      ocrStatus.innerHTML = '<span class="spin"></span>Կրկին փորձում եմ…';
      await loadScript(TESSERACT_URL);
      if (typeof Tesseract !== "undefined") {
        const t = await recognizeKanji(cleanCanvas);
        if ([...t].some(isLookup) || !clean) clean = t;
      }
    } catch (e) {}
  }

  const found = [...clean].some(isLookup);
  ocrStatus.className = "status";
  ocrStatus.textContent = found
    ? "Ահա թե ինչ կարդացի — ուղղիր անհրաժեշտության դեպքում՝"
    : "Չկարողացա հստակ կարդալ։ Մուտքագրիր ներքևում կամ փորձիր ավելի մեծ ու հստակ լուսանկար։";
  ocrText.value = clean;
  ocrReview.classList.remove("hidden");
  if (found) analyze(clean); // show results right away; user can still fix + re-run
}

async function handleImage(file) {
  if (!file || !file.type.startsWith("image/")) return;
  previewPanel.classList.remove("hidden");
  ocrStatus.className = "status";
  ocrStatus.innerHTML = '<span class="spin"></span>Մաքրում եմ նկարը…';
  try {
    const canvas = await preprocess(file);
    await runOCR(canvas);
  } catch (e) {
    ocrStatus.className = "status error";
    ocrStatus.textContent = "Չհաջողվեց բացել նկարը՝ " + e.message;
  }
}

/* ---------- live camera (Google-Lens-style: aim, then tap to read) ---------- */
let camStream = null;
async function openCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("Այս զննարկիչը կենդանի տեսախցիկ չի աջակցում");
    return;
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    const v = $("#cam-video");
    v.srcObject = camStream;
    await v.play();
    $("#cam-start").classList.add("hidden");
    $("#cam-live").classList.remove("hidden");
  } catch (e) {
    toast("Տեսախցիկը հասանելի չէ — թույլ տուր մուտքը");
  }
}
function stopCamera() {
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  const v = $("#cam-video");
  if (v) v.srcObject = null;
  const live = $("#cam-live"), start = $("#cam-start");
  if (live) live.classList.add("hidden");
  if (start) start.classList.remove("hidden");
}
async function shootCamera() {
  const v = $("#cam-video");
  if (!v || !v.videoWidth) { toast("Տեսախցիկը դեռ պատրաստ չէ"); return; }
  const c = document.createElement("canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  previewPanel.classList.remove("hidden");
  ocrStatus.className = "status";
  ocrStatus.innerHTML = '<span class="spin"></span>Մաքրում եմ պատկերը…';
  try {
    const cleaned = cleanForOCR(c, c.width, c.height);
    await runOCR(cleaned);
  } catch (e) {
    ocrStatus.className = "status error";
    ocrStatus.textContent = "Չհաջողվեց կարդալ՝ " + e.message;
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
  if (!r.ok) throw new Error("ճանաչիչն անհասանելի է (" + r.status + ")");
  const j = await r.json();
  if (j[0] !== "SUCCESS") throw new Error("չհաջողվեց կարդալ նկարածը");
  const raw = (j[1] && j[1][0] && j[1][0][1]) || [];
  // keep ONLY fully-Japanese guesses; if none qualify, return nothing (show none)
  const jp = raw.filter((c) => c && [...c].every((ch) => isJapanese(ch)));
  // kanji first, then kana
  return jp.sort((a, b) => {
    const ak = [...a].some(isKanji) ? 0 : 1;
    const bk = [...b].some(isKanji) ? 0 : 1;
    return ak - bk;
  });
}

/* show the guesses as tappable buttons; tapping one analyses it */
function renderCandidates(cands, chosen) {
  const box = $("#candidates");
  box.innerHTML = "";
  box.appendChild(el("span", "cand-label", "Ընտրիր քո գրած կանջին"));
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
  let redo = [];        // strokes removed by "one step back", ready to re-add
  let current = null;
  const drawStatus = $("#draw-status");
  function showCount() {
    if (drawStatus) drawStatus.textContent = "Գծերի քանակը՝ " + strokes.length;
  }

  function setStyle() {
    ctx.lineWidth = 14;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111";
  }
  // wipe the canvas and paint every stored stroke again
  function redraw() {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setStyle();
    for (const s of strokes) {
      ctx.beginPath();
      ctx.moveTo(s.x[0], s.y[0]);
      for (let i = 1; i < s.x.length; i++) ctx.lineTo(s.x[i], s.y[i]);
      // a single dot still shows
      if (s.x.length === 1) ctx.lineTo(s.x[0] + 0.1, s.y[0] + 0.1);
      ctx.stroke();
    }
    showCount();
  }

  function clearPad() {
    strokes = [];
    redo = [];
    current = null;
    redraw();
  }
  clearPad();

  function undo() {
    if (!strokes.length) return;
    redo.push(strokes.pop());
    current = null;
    redraw();
  }
  function redoStep() {
    if (!redo.length) return;
    strokes.push(redo.pop());
    redraw();
  }

  let drawing = false;
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - r.left) * (canvas.width / r.width)),
      y: Math.round((e.clientY - r.top) * (canvas.height / r.height)),
    };
  }
  function start(e) {
    e.preventDefault();
    redo = []; // drawing something new clears the "step forward" history
    // if a previous stroke never got a finger-lift, finalise it so we never
    // get stuck refusing new strokes
    if (drawing && current && current.x.length) { strokes.push(current); showCount(); }
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
    if (drawing && current && current.x.length) { strokes.push(current); showCount(); }
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
  $("#draw-undo").addEventListener("click", undo);
  $("#draw-redo").addEventListener("click", redoStep);

  $("#draw-read").addEventListener("click", async () => {
    previewPanel.classList.remove("hidden");
    $("#candidates").classList.add("hidden");
    ocrReview.classList.add("hidden");
    ocrStatus.className = "status";
    previewImg.src = canvas.toDataURL();
    if (!strokes.length) {
      ocrStatus.textContent = "Նախ նկարիր կանջի, ապա սեղմիր «Կարդալ կանջին»։";
      return;
    }
    ocrStatus.innerHTML = '<span class="spin"></span>Ճանաչում եմ նկարածդ…';
    results.innerHTML = "";
    try {
      const cands = await recognizeHandwriting(strokes, canvas.width, canvas.height);
      if (!cands.length) {
        ocrStatus.textContent = "Չհաջողվեց ճանաչել։ Փորձիր ավելի մեծ ու հստակ նկարել։";
        return;
      }
      const primary = cands[0];
      ocrStatus.textContent = "Կարծում եմ՝ նկարեցիր՝";
      ocrText.value = primary;
      ocrReview.classList.remove("hidden");
      renderCandidates(cands, primary);
      analyze(primary);
    } catch (e) {
      ocrStatus.className = "status error";
      ocrStatus.textContent = "Չհաջողվեց ճանաչել նկարածը՝ " + e.message;
    }
  });
}
setupDrawPad();

/* ---------- wiring ---------- */
$("#file-input").addEventListener("change", (e) => handleImage(e.target.files[0]));
$("#camera-input").addEventListener("change", (e) => handleImage(e.target.files[0]));
$("#cam-open").addEventListener("click", openCamera);
$("#cam-stop").addEventListener("click", stopCamera);
$("#cam-shot").addEventListener("click", shootCamera);
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
      "Սխալ առաջացավ՝ " + esc(e.message || "անհայտ") +
      "։ Էջը գուցե ամբողջությամբ չբեռնվեց — թարմացրու։"));
  }
});

/* ---------- tabs ---------- */
function setupTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  const panels = {
    draw: $("#tab-draw"), upload: $("#tab-upload"),
    photo: $("#tab-photo"), type: $("#tab-type"),
  };
  function show(name) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    Object.entries(panels).forEach(([k, p]) => p && p.classList.toggle("hidden", k !== name));
    if (name !== "photo") stopCamera(); // free the camera when leaving the tab
    try { sessionStorage.setItem("mk_tab", name); } catch (e) {}
  }
  tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.tab)));
  let saved = null;
  try { saved = sessionStorage.getItem("mk_tab"); } catch (e) {}
  show(saved && panels[saved] ? saved : "draw");
}
setupTabs();

/* ---------- tap-to-copy (works on restored history too, via delegation) ---------- */
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 1600);
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta);
  }
  toast("Պատճենվեց՝ " + text);
}
document.addEventListener("click", (e) => {
  const c = e.target.closest(".copyable");
  if (c && c.dataset.copy) copyText(c.dataset.copy);
});

/* ---------- search history + restore (kept until the tab is closed) ---------- */
const HISTORY_KEY = "mk_history";
const LAST_HTML_KEY = "mk_last_html";
function getHistory() {
  try { return JSON.parse(sessionStorage.getItem(HISTORY_KEY) || "[]"); } catch (e) { return []; }
}
function renderHistory() {
  const wrap = $("#history-wrap");
  const box = $("#history");
  const items = getHistory();
  box.innerHTML = "";
  if (!items.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  items.forEach((q) => {
    const chip = el("button", "history-chip", '<span lang="ja">' + esc(q) + "</span>");
    chip.type = "button";
    chip.addEventListener("click", () => analyze(q));
    box.appendChild(chip);
  });
}
function saveState(query) {
  try {
    let items = getHistory().filter((q) => q !== query);
    items.unshift(query);
    items = items.slice(0, 24);
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(items));
    sessionStorage.setItem(LAST_HTML_KEY, results.innerHTML);
  } catch (e) {}
  renderHistory();
}
function restoreState() {
  renderHistory();
  try {
    const html = sessionStorage.getItem(LAST_HTML_KEY);
    if (html) results.innerHTML = html; // instant — nothing "happens" on refresh
  } catch (e) {}
}
$("#history-clear").addEventListener("click", () => {
  try {
    sessionStorage.removeItem(HISTORY_KEY);
    sessionStorage.removeItem(LAST_HTML_KEY);
  } catch (e) {}
  results.innerHTML = "";
  renderHistory();
});
restoreState();

/* NOTE: the heavy 15MB grammar dictionary is intentionally NOT loaded — it made
   phones freeze mid-drawing and the page crawl. Kanji lookup works without it.
   (warmUpTokenizer stays available if we ever add a lightweight opt-in later.) */
