// UI layer: owns the input, the mode switch and rendering. All lookups go to
// worker.js so a wide search never janks the keyboard.

const $ = (sel) => document.querySelector(sel);
const qInput = $('#q');
const modesEl = $('#modes');
const splitEl = $('#split');
const listEl = $('#list');
const detailEl = $('#detail');
const recentEl = $('#recent');
const recentListEl = $('#recentList');
const histBtn = $('#histBtn');
const loadingEl = $('#loading');
const statusEl = $('#status');
const introEl = $('#intro');
const barFill = $('#barfill');
const loadNote = $('#loadnote');

const minorBtn = $('#minor');

// The mode selects which language's entries come back, not a direction.
const MODES = ['all', 'jp', 'cn', 'jpcn'];
// Chinese first: that is what this is mostly used for.
let mode = localStorage.getItem('dict.mode') || 'cn';
if (!MODES.includes(mode)) mode = 'cn';
let hideMinor = localStorage.getItem('dict.hideMinor') !== 'false';

// ------------------------------------------------------------ worker plumbing

const worker = new Worker('worker.js', { type: 'module' });
const pending = new Map();
let nextId = 1;
let dataReady = false;

function ask(type, payload) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

worker.onmessage = (e) => {
  const { id, type, payload, error } = e.data;
  if (type === 'progress') {
    const pct = Math.round((e.data.loaded / e.data.total) * 100);
    barFill.style.width = `${pct}%`;
    loadNote.textContent = `${pct}% — ${e.data.file}`;
    return;
  }
  if (type === 'ready') {
    dataReady = true;
    loadingEl.classList.add('hidden');
    const { jp, cn } = e.data.meta.counts;
    setStatus(`${jp.toLocaleString()} Japanese · ${cn.toLocaleString()} Chinese entries`, 'dim');
    if (qInput.value.trim()) run();
    else introEl.classList.remove('hidden');
    purgeOldData(e.data.meta);
    refreshCacheBox(e.data.meta);
    return;
  }
  if (type === 'extras') {
    // Cards drawn before the example file landed have no sentences, so redraw
    // them — but not over a linked entry the reader deliberately opened.
    if (qInput.value.trim()) run({ push: false });
    return;
  }
  if (type === 'note') {
    setStatus(e.data.text, 'warn');
    return;
  }
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (type === 'error') p.reject(new Error(error));
  else p.resolve(payload);
};

worker.onerror = (e) => {
  loadingEl.classList.add('hidden');
  setStatus(`Worker failed: ${e.message}`, 'warn');
};

worker.postMessage({ type: 'load', payload: { base: 'data' } });

// ------------------------------------------------------------------- render

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// --------------------------------------------------- per-character popover

// CJK ideographs only — kana and punctuation are left alone.
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
const charCache = new Map();

/** The Chinese entry for a single character, looked up once and remembered. */
function lookupChar(ch) {
  if (!charCache.has(ch)) charCache.set(ch, ask('char', { ch }).then((r) => r.char));
  return charCache.get(ch);
}

/**
 * Split text so every Han character is its own hoverable, clickable span.
 * Everything else stays plain text.
 */
function hanify(text) {
  const frag = document.createDocumentFragment();
  let run = '';
  for (const ch of String(text)) {
    if (HAN.test(ch)) {
      if (run) { frag.append(run); run = ''; }
      const span = el('span', 'han', ch);
      span.dataset.ch = ch;
      frag.append(span);
    } else {
      run += ch;
    }
  }
  if (run) frag.append(run);
  return frag;
}

const tip = el('div', 'tip hidden');
document.body.append(tip);
let tipFor = null;

async function showTip(span) {
  const ch = span.dataset.ch;
  tipFor = ch;
  const info = await lookupChar(ch);
  if (tipFor !== ch) return;               // pointer already moved on
  tip.replaceChildren();
  if (!info) {
    tip.append(el('div', 'tip-gloss', `${ch} — no Chinese entry`));
  } else {
    const head = el('div', 'tip-head');
    head.append(el('span', 'tip-char', info.head + (info.simp ? ` / ${info.simp}` : '')));
    head.append(el('span', 'tip-reading', info.reading));
    tip.append(head, el('div', 'tip-gloss', info.gloss));
    tip.append(el('div', 'tip-hint', 'click to open'));
  }
  const r = span.getBoundingClientRect();
  tip.classList.remove('hidden');
  const w = tip.offsetWidth;
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  const above = r.top > tip.offsetHeight + 12;
  tip.style.top = `${above ? r.top - tip.offsetHeight - 8 : r.bottom + 8}px`;
}

function hideTip() {
  tipFor = null;
  tip.classList.add('hidden');
}

document.addEventListener('mouseover', (e) => {
  const span = e.target.closest?.('.han');
  if (span) showTip(span);
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest?.('.han')) hideTip();
});
document.addEventListener('click', async (e) => {
  const span = e.target.closest?.('.han');
  if (!span) return;
  const info = await lookupChar(span.dataset.ch);
  if (!info) return;
  hideTip();
  openEntry('cn', info.id);
});
window.addEventListener('scroll', hideTip, true);

function whyLabel(why) {
  if (!why) return '';
  if (why.type === 'deconjugated') return `${why.key} · ${why.reasons.join(' ← ')}`;
  if (why.type === 'exact') return 'exact';
  if (why.type === 'fuzzy') return `did you mean ${why.key}?`;
  if (why.type === 'prefix') return why.key;
  return why.type;
}

function renderExamples(parent, examples, lang) {
  if (!examples.length) return;
  const box = el('div', 'examples');
  for (const [a, b] of examples.slice(0, 3)) {
    const row = el('div', 'ex');
    const src = el('div', `ex-src ${lang}`);
    src.append(hanify(a));
    row.append(src, el('div', 'ex-tr', b));
    box.append(row);
  }
  parent.append(box);
}

/**
 * Copy without assuming a secure context: served over plain http on a LAN
 * address there is no navigator.clipboard, so fall back to the old trick.
 */
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through to the textarea */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** A row of "copy X" buttons; each shows what it will copy. */
function renderCopies(parent, items) {
  const row = el('div', 'copies');
  for (const [label, text] of items) {
    if (!text) continue;
    const btn = el('button', 'copy');
    btn.type = 'button';
    btn.title = `Copy ${text}`;
    btn.append(el('span', 'copy-icon', '⧉'), el('span', 'copy-label', label));
    btn.onclick = async () => {
      const ok = await copyText(text);
      const labelEl = btn.querySelector('.copy-label');
      labelEl.textContent = ok ? 'copied' : 'failed';
      btn.classList.add(ok ? 'done' : 'failed');
      setTimeout(() => {
        labelEl.textContent = label;
        btn.classList.remove('done', 'failed');
      }, 1200);
    };
    row.append(btn);
  }
  if (row.children.length) parent.append(row);
}

function renderLinks(parent, links, label) {
  if (!links || !links.length) return;
  const box = el('div', 'links');
  box.append(el('div', 'links-label', label));
  for (const l of links) {
    const chip = el('button', 'chip');
    chip.type = 'button';
    const head = el('span', 'chip-head', l.head + (l.simp ? ` / ${l.simp}` : ''));
    chip.append(head);
    if (l.reading) chip.append(el('span', 'chip-reading', l.reading));
    if (l.romaji) chip.append(el('span', 'chip-reading', l.romaji));
    chip.append(el('span', 'chip-gloss', l.gloss));
    chip.onclick = () => openEntry(l.kind, l.id);
    box.append(chip);
  }
  parent.append(box);
}

function jpCard(entry) {
  const card = el('article', 'card');
  const head = el('header', 'head');
  const main = el('div', 'headword jp');
  main.append(hanify(entry.kanji[0] || entry.kana[0] || ''));
  head.append(main);

  const reading = el('div', 'reading');
  if (entry.kanji.length && entry.kana.length) reading.append(el('span', 'kana', entry.kana[0]));
  if (entry.romaji[0]) reading.append(el('span', 'romaji', entry.romaji[0]));
  head.append(reading);

  const tags = el('div', 'tags');
  tags.append(el('span', 'tag lang', 'JP'));
  if (entry.common) tags.append(el('span', 'tag common', 'common'));
  const why = whyLabel(entry.why);
  if (why) tags.append(el('span', 'tag why', why));
  head.append(tags);
  card.append(head);

  const alts = [...entry.kanji.slice(1), ...entry.kana.slice(1)];
  if (alts.length) {
    const altRow = el('div', 'alts');
    altRow.append('also ', hanify(alts.slice(0, 6).join('、')));
    card.append(altRow);
  }

  const word = entry.kanji[0] || entry.kana[0] || '';
  renderCopies(card, [
    ['word', word],
    ['kana', entry.kana[0] !== word ? entry.kana[0] : ''],
    ['romaji', entry.romaji[0]],
  ]);

  const ol = el('ol', 'senses');
  for (const s of entry.senses.slice(0, 8)) {
    const li = el('li');
    if (s.pos.length) li.append(el('span', 'pos', s.pos.slice(0, 3).join(', ')));
    li.append(el('span', 'gloss', s.gloss));
    if (s.misc.length) li.append(el('span', 'misc', s.misc.slice(0, 3).join(', ')));
    ol.append(li);
  }
  card.append(ol);

  renderExamples(card, entry.examples, 'jp');
  renderLinks(card, entry.hanziLinks, 'Chinese — hanzi match');
  renderLinks(card, entry.links, 'Chinese — eng heuristic');
  return card;
}

function cnCard(entry) {
  const card = el('article', 'card');
  const head = el('header', 'head');
  const cnHead = el('div', 'headword cn');
  cnHead.append(hanify(entry.trad));
  head.append(cnHead);
  const reading = el('div', 'reading');
  if (entry.simp !== entry.trad) {
    const simp = el('span', 'kana');
    simp.append(hanify(entry.simp));
    reading.append(simp);
  }
  reading.append(el('span', 'romaji', entry.pinyin));
  head.append(reading);

  const tags = el('div', 'tags');
  tags.append(el('span', 'tag lang cn', 'CN'));
  const why = whyLabel(entry.why);
  if (why) tags.append(el('span', 'tag why', why));
  head.append(tags);
  card.append(head);

  renderCopies(card, [
    ['word', entry.trad],
    ['simp', entry.simp !== entry.trad ? entry.simp : ''],
    ['pinyin', entry.pinyin],
  ]);

  const ol = el('ol', 'senses');
  for (const g of entry.glosses.slice(0, 10)) ol.append(el('li', null, g));
  card.append(ol);

  renderExamples(card, entry.examples, 'cn');
  renderLinks(card, entry.hanziLinks, 'Japanese — hanzi match');
  renderLinks(card, entry.links, 'Japanese — eng heuristic');
  return card;
}

function setStatus(text, cls = '') {
  statusEl.className = `panel ${cls}`;
  statusEl.textContent = text;
  statusEl.classList.toggle('hidden', !text);
}

/** Set when the next render should start a new history entry. */
let pendingPush = false;

/** One compact row in the results list. */
function listRow(entry, i) {
  const li = el('li', 'row');
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', 'false');
  const head = el('div', 'row-head');
  const isJp = entry.kind === 'jp';
  head.append(el('span', `row-word ${entry.kind}`, isJp ? (entry.kanji[0] || entry.kana[0]) : entry.trad));
  const reading = isJp
    ? (entry.kanji.length ? entry.kana[0] : entry.romaji[0])
    : entry.pinyin;
  if (reading) head.append(el('span', 'row-reading', reading));
  // Common words are marked by colouring the tag, not by appending punctuation.
  const tag = el('span', `row-tag${isJp && entry.common ? ' common' : ''}`, isJp ? 'JP' : 'CN');
  head.append(tag);
  li.append(head);
  const gloss = isJp ? (entry.senses[0]?.gloss || '') : entry.glosses.join('; ');
  li.append(el('div', 'row-gloss', gloss));
  li.onclick = () => select(i);
  return li;
}

function detailFor(entry) {
  const frag = document.createDocumentFragment();
  const back = el('button', 'back', '← Results');
  back.type = 'button';
  back.onclick = () => document.body.classList.remove('detail-open');
  frag.append(back, entry.kind === 'jp' ? jpCard(entry) : cnCard(entry));
  return frag;
}

/** True while a history entry is being restored, so nothing rewrites it. */
let restoring = false;
/** Last word written to the saved-lookup list, to skip no-op redraws. */
let lastRecorded = null;

/** Show result `i` in the detail pane. */
function select(i, { push = false } = {}) {
  const entry = current.results[i];
  if (!entry) return;
  current.index = i;
  [...listEl.children].forEach((n, k) => n.setAttribute('aria-selected', String(k === i)));
  listEl.children[i]?.scrollIntoView({ block: 'nearest' });
  detailEl.replaceChildren(detailFor(entry));
  document.body.classList.add('detail-open');
  const key = `${entry.kind}:${entry.id}`;
  if (key !== lastRecorded) {
    lastRecorded = key;
    recordLookup(entry);
  }
  if (!restoring) syncUrl(push);
}

function render(payload, query) {
  const { results, hidden } = payload;
  // Remember what was selected: this function also runs for background
  // redraws (example sentences arriving, the filter being toggled), and those
  // must not throw the reader back to the first row or rewrite the URL.
  const previous = current.results[current.index] || null;
  current = { results, index: -1 };
  listEl.replaceChildren();
  detailEl.replaceChildren();
  document.body.classList.remove('detail-open');
  const buried = hidden ? ` · ${hidden} low scoring hidden` : '';

  if (!results.length) {
    splitEl.classList.add('hidden');
    setStatus(
      hidden
        ? `No strong matches for “${query}” — ${hidden} low-scoring entries hidden. Untick “Hide low scoring” to see them.`
        : `No matches for “${query}” in ${modeLabel(mode)}.`,
      'warn',
    );
    return;
  }

  splitEl.classList.remove('hidden');
  setStatus(`${results.length} result${results.length === 1 ? '' : 's'} · ${modeLabel(mode)}${buried}`, 'dim');
  const frag = document.createDocumentFragment();
  results.forEach((r, i) => frag.append(listRow(r, i)));
  listEl.append(frag);
  // Show the best match straight away — or the word the URL asked for, or
  // whatever was already selected if this is just a redraw.
  let start = 0;
  const want = pendingSelect || previous;
  if (want) {
    const i = results.findIndex((r) => r.kind === want.kind && r.id === want.id);
    if (i >= 0) {
      start = i;
    } else if (pendingSelect) {
      // Not in this result set (the link was followed from elsewhere): fetch it.
      pendingSelect = null;
      pendingPush = false;
      openEntry(want.kind, want.id, { push: false });
      return;
    }
  }
  pendingSelect = null;
  select(start, { push: pendingPush });
  pendingPush = false;
  if (window.matchMedia('(max-width: 720px)').matches) {
    document.body.classList.remove('detail-open');
  }
}

function modeLabel(m) {
  return { all: 'All', jp: 'JP ↔ EN', cn: 'CN ↔ EN', jpcn: 'JP ↔ CN' }[m];
}

/**
 * Digging into a linked word: it becomes the detail pane and gets its own
 * history entry, so Back returns to the word you came from.
 */
async function openEntry(kind, id, { push = true } = {}) {
  runToken++; // invalidate any search still in flight
  clearTimeout(debounce);
  const payload = await ask('entry', { kind, id });
  const e = payload.results[0];
  if (!e) return;
  // Put it at the head of the list so the trail of words you followed is
  // visible rather than replaced.
  current.results.unshift(e);
  const frag = document.createDocumentFragment();
  current.results.forEach((r, i) => frag.append(listRow(r, i)));
  listEl.replaceChildren(frag);
  splitEl.classList.remove('hidden');
  recentEl.classList.add('hidden');
  select(0, { push: push && !restoring });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ------------------------------------------------------------- history

const RECENT_KEY = 'dict.recent';
const RECENT_MAX = 300;

function loadRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Remember a word that was actually looked at, newest first, deduplicated. */
function recordLookup(entry) {
  const isJp = entry.kind === 'jp';
  const item = {
    kind: entry.kind,
    id: entry.id,
    head: isJp ? (entry.kanji[0] || entry.kana[0]) : entry.trad,
    reading: isJp ? (entry.kanji.length ? entry.kana[0] : entry.romaji[0]) : entry.pinyin,
    gloss: isJp ? (entry.senses[0]?.gloss || '') : entry.glosses.slice(0, 3).join('; '),
    at: Date.now(),
  };
  const list = loadRecent().filter((x) => !(x.kind === item.kind && x.id === item.id));
  list.unshift(item);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch { /* storage full or blocked; history is a convenience */ }
}

function showRecent(on) {
  const items = loadRecent();
  histBtn.setAttribute('aria-pressed', String(on));
  recentEl.classList.toggle('hidden', !on);
  splitEl.classList.toggle('hidden', on || !current.results.length);
  introEl.classList.add('hidden');
  if (!on) return;
  setStatus(items.length ? `${items.length} word${items.length === 1 ? '' : 's'} looked up` : '', 'dim');
  recentListEl.replaceChildren();
  if (!items.length) {
    recentListEl.append(el('li', 'row', 'Nothing yet — look something up.'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const li = el('li', 'row');
    const head = el('div', 'row-head');
    head.append(el('span', `row-word ${it.kind}`, it.head));
    if (it.reading) head.append(el('span', 'row-reading', it.reading));
    head.append(el('span', 'row-tag', it.kind === 'jp' ? 'JP' : 'CN'));
    li.append(head, el('div', 'row-gloss', it.gloss));
    li.onclick = () => {
      showRecent(false);
      openEntry(it.kind, it.id);
    };
    frag.append(li);
  }
  recentListEl.append(frag);
}

$('#back').onclick = () => history.back();
$('#fwd').onclick = () => history.forward();

histBtn.onclick = () => showRecent(histBtn.getAttribute('aria-pressed') !== 'true');
$('#clearHist').onclick = () => {
  localStorage.removeItem(RECENT_KEY);
  showRecent(true);
};

/**
 * One history entry per settled query and per word dug into — not per
 * keystroke, which would make Back useless.
 */
function syncUrl(push) {
  const sel = current.results[current.index];
  const state = {
    q: qInput.value,
    mode,
    // The row you were on, by position and by identity: the position restores
    // the same selection instantly, the identity is the fallback if the result
    // set no longer lines up.
    index: current.index,
    sel: sel ? { kind: sel.kind, id: sel.id } : null,
  };
  // The selection goes in the URL, not just history.state: state is lost on a
  // hard refresh and cannot be shared, so #all/doumo/jp:1234 is what actually
  // brings you back to the word you were on.
  const hash = `#${mode}/${encodeURIComponent(qInput.value)}`
    + (sel ? `/${sel.kind}:${sel.id}` : '');
  // Whether this is the very same place as the current entry. The selection
  // counts: following a link keeps the query but changes the word, and
  // comparing only the query made those dives replace their entry instead of
  // adding one, so Back skipped straight past them.
  const st = history.state;
  const samePlace = !!st && st.q === state.q && st.mode === state.mode
    && st.sel?.kind === state.sel?.kind && st.sel?.id === state.sel?.id;

  if (push) {
    // Committing: reuse the scratch entry this was typed into rather than
    // stacking a duplicate on it.
    if (samePlace) history.replaceState(state, '', hash);
    else history.pushState(state, '', hash);
    committed = true;
  } else if (committed && !samePlace) {
    // First edit after a commit: leave that entry alone and work in a new one.
    history.pushState(state, '', hash);
    committed = false;
  } else {
    history.replaceState(state, '', hash);
  }
}

window.addEventListener('popstate', async (e) => {
  // No state means the hash was edited or the entry predates this format.
  const st = e.state || readHash();
  if (!st) return;
  mode = MODES.includes(st.mode) ? st.mode : mode;
  qInput.value = st.q || '';
  syncClear();
  for (const b of modesEl.children) {
    b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  }
  showRecent(false);

  committed = true; // we are sitting on a committed entry again
  restoring = true;
  try {
    await run({ push: false });
    const want = st.sel;
    if (want) {
      // Prefer the remembered row; fall back to finding the same entry, and
      // only re-fetch it if this result set does not contain it at all.
      const at = current.results[st.index];
      const same = at && at.kind === want.kind && at.id === want.id;
      const found = same
        ? st.index
        : current.results.findIndex((r) => r.kind === want.kind && r.id === want.id);
      if (found >= 0) select(found);
      else await openEntry(want.kind, want.id, { push: false });
    }
  } finally {
    restoring = false;
  }
});

// -------------------------------------------------------------------- input

let runToken = 0;
/** The result set on screen, and which of it is in the detail pane. */
let current = { results: [], index: -1 };
/**
 * True when the current history entry is one the reader committed (Enter, a
 * link, a history pick). Typing must not overwrite such an entry — it pushes a
 * scratch entry once and then edits that, or committing a second query would
 * silently replace the first and Back would go nowhere.
 */
let committed = false;

async function run({ push = false } = {}) {
  const query = qInput.value.trim();
  if (!dataReady) return;
  showRecent(false);
  introEl.classList.toggle('hidden', !!query);
  if (!query) {
    current = { results: [], index: -1 };
    listEl.replaceChildren();
    detailEl.replaceChildren();
    splitEl.classList.add('hidden');
    document.body.classList.remove('detail-open');
    setStatus('');
    return;
  }
  const token = ++runToken;
  try {
    const payload = await ask('search', { query, mode, hideMinor });
    // Drop the result if a newer keystroke won.
    if (token !== runToken) return;
    // Typing never commits: every intermediate query would become a history
    // entry and Back would crawl through them one letter at a time. Only
    // deliberate acts do — Enter, following a link, picking from history.
    pendingPush = push;
    const wasPush = pendingPush;
    render(payload, query);
    if (!current.results.length) syncUrl(wasPush);
  } catch (err) {
    // An internal error here usually means mixed-vintage assets: a shell file
    // cached from an older build talking to a newer one. Drop the shell cache
    // and reload, once per session so a genuine bug cannot loop.
    if (!sessionStorage.getItem('dict.healed')) {
      sessionStorage.setItem('dict.healed', '1');
      setStatus('Updating to the latest version…', 'dim');
      try {
        for (const k of await caches.keys()) if (k.includes('shell')) await caches.delete(k);
        const reg = await navigator.serviceWorker?.getRegistration();
        await reg?.update();
      } catch { /* nothing cached to clear */ }
      location.reload();
      return;
    }
    setStatus(err.message, 'warn');
  }
}

let debounce;

/** The clear button is only useful, and only shown, when there is text. */
function syncClear() {
  $('#clear').classList.toggle('hidden', !qInput.value);
}

qInput.addEventListener('input', () => {
  syncClear();
  clearTimeout(debounce);
  debounce = setTimeout(run, 120);
});
// Enter (or the keyboard's Search key) marks the query as deliberate, so it
// earns a place in history.
qInput.addEventListener('search', () => run({ push: true }));
qInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') run({ push: true });
});
$('#clear').onclick = () => {
  qInput.value = '';
  syncClear();
  qInput.focus();
  run();
};

minorBtn.checked = hideMinor;
minorBtn.onchange = () => {
  hideMinor = minorBtn.checked;
  localStorage.setItem('dict.hideMinor', String(hideMinor));
  run();
};

function selectMode(m) {
  mode = m;
  localStorage.setItem('dict.mode', m);
  for (const b of modesEl.children) {
    const on = b.dataset.mode === m;
    b.setAttribute('aria-selected', String(on));
    // The mode row scrolls sideways on a phone; keep the active chip in view.
    if (on) b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }
  run();
}
modesEl.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) selectMode(b.dataset.mode);
});

function cycleMode(step) {
  const i = MODES.indexOf(mode);
  selectMode(MODES[(i + step + MODES.length) % MODES.length]);
}

// Tab cycles modes rather than moving focus, so you can retype nothing and
// just step a query through every dictionary. Shift+Tab goes back.
qInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
  e.preventDefault();
  cycleMode(e.shiftKey ? -1 : 1);
});

// Arrow keys do the same from the chips themselves, which is what a tablist
// is expected to do.
modesEl.addEventListener('keydown', (e) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  cycleMode(step);
  modesEl.querySelector('[aria-selected="true"]')?.focus();
});

/** Selection asked for by the URL, applied once its results arrive. */
let pendingSelect = null;

/** `#mode/query` or `#mode/query/kind:id`. */
function readHash() {
  const parts = location.hash.replace(/^#/, '').split('/');
  if (parts.length < 2 || !MODES.includes(parts[0])) return null;
  const m = /^(jp|cn):(\d+)$/.exec(parts[2] || '');
  return {
    mode: parts[0],
    q: decodeURIComponent(parts[1]),
    sel: m ? { kind: m[1], id: Number(m[2]) } : null,
  };
}

// Restore #mode/query/selection so links and reloads keep their place.
{
  const h = readHash();
  if (h) {
    mode = h.mode;
    qInput.value = h.q;
    pendingSelect = h.sel;
  }
  syncClear();
  selectMode(mode);
}

// "/" jumps to the search box from anywhere, unless you are already typing
// into a field.
window.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t === qInput || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName) || t?.isContentEditable) return;
  e.preventDefault();
  qInput.focus();
  qInput.select();
});

// The results list pins under the header and runs to the bottom of the
// viewport; its offset has to track the header, which grows when the controls
// wrap onto a second line.
{
  const bar = document.querySelector('.bar');
  const setBarHeight = () => {
    document.documentElement.style.setProperty('--bar-h', `${Math.round(bar.getBoundingClientRect().height)}px`);
  };
  setBarHeight();
  if (window.ResizeObserver) new ResizeObserver(setBarHeight).observe(bar);
  else window.addEventListener('resize', setBarHeight);
}

// ------------------------------------------------------------------- offline

/**
 * Data files are cached under a ?v=<build date> URL and never revalidated, so
 * after a rebuild the previous set would sit on the device for ever. Drop
 * anything that is not the build we just loaded.
 */
async function purgeOldData(meta) {
  if (!('caches' in window)) return;
  try {
    const stamp = `v=${encodeURIComponent(meta.built)}`;
    for (const name of await caches.keys()) {
      if (!name.includes('data')) continue;
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        if (!req.url.includes(stamp)) await cache.delete(req);
      }
    }
  } catch (err) {
    console.warn('could not purge old data cache', err);
  }
}

async function refreshCacheBox(meta) {
  const box = document.getElementById('cachebox');
  if (!box) return;
  box.replaceChildren();
  const line = el('div', 'cacheline');
  const mb = (meta.totalBytes / 1e6).toFixed(0);
  line.append(el('span', null, `Dataset ${mb} MB uncompressed, built ${meta.built}.`));
  box.append(line);

  if (!('serviceWorker' in navigator)) {
    box.append(el('div', 'dim', 'Offline caching needs a service worker; this browser has none.'));
    return;
  }
  const state = el('div', 'dim', navigator.onLine ? 'Online.' : 'Offline — serving from cache.');
  box.append(state);

  if (navigator.storage?.estimate) {
    const { usage } = await navigator.storage.estimate();
    box.append(el('div', 'dim', `Cached on this device: ${(usage / 1e6).toFixed(0)} MB.`));
  }

  const btn = el('button', 'btn', 'Clear cached data');
  btn.type = 'button';
  btn.onclick = async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    btn.textContent = 'Cleared — reload to re-download';
  };
  box.append(btn);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('service worker registration failed', err);
    });
  });
}
