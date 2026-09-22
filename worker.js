// Search engine. Runs off the main thread so a 40 MB load and a wide prefix
// scan never block typing.
//
// The data files are kept as plain strings plus a Uint32Array of line offsets.
// Nothing is parsed into objects until a line actually appears in results,
// which is what keeps memory on a phone reasonable.

import {
  toHiragana, kanaToRomaji, normalizeRomaji, romajiToHiragana, looseRomaji, scriptOf,
} from './lib/kana.js';
import { numberedToDiacritics, numberedToToneless, normalizePinyin } from './lib/pinyin.js';
import { deconjugate } from './lib/deconjugate.js';
import { normGloss } from './lib/gloss.js';

const FS = '\x1f';
const RS = '\x1e';
const US = '\x1d';

/** A newline-delimited file with O(1) line access and O(log n) key search. */
class Lines {
  constructor(text) {
    this.text = text;
    const starts = [0];
    let pos = 0;
    for (;;) {
      const i = text.indexOf('\n', pos);
      if (i < 0) break;
      pos = i + 1;
      if (pos < text.length) starts.push(pos);
    }
    this.starts = Uint32Array.from(starts);
  }

  get count() { return this.starts.length; }

  line(i) {
    const s = this.starts[i];
    const e = i + 1 < this.starts.length ? this.starts[i + 1] - 1 : this.text.length;
    return this.text.slice(s, e);
  }

  /** Key portion (up to the first tab) of line i, without copying the value. */
  key(i) {
    const s = this.starts[i];
    const e = this.text.indexOf('\t', s);
    return this.text.slice(s, e);
  }

  value(i) {
    const s = this.text.indexOf('\t', this.starts[i]) + 1;
    const e = i + 1 < this.starts.length ? this.starts[i + 1] - 1 : this.text.length;
    return this.text.slice(s, e);
  }

  /** Index of the first line whose key is >= key. */
  lowerBound(key) {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.key(mid) < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  exact(key) {
    const i = this.lowerBound(key);
    return i < this.count && this.key(i) === key ? this.value(i) : null;
  }

  /** Lines whose key starts with `prefix`, capped. */
  prefix(prefix, cap = 60) {
    const out = [];
    for (let i = this.lowerBound(prefix); i < this.count && out.length < cap; i++) {
      const k = this.key(i);
      if (!k.startsWith(prefix)) break;
      out.push([k, this.value(i)]);
    }
    return out;
  }
}

// --------------------------------------------------------------- load

const DATA = {};
let ready = false;

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/**
 * meta.json decides which data files exist and what version stamp they carry,
 * so a stale copy poisons everything after it — the worker would look for
 * files the old manifest never mentions. Bypass every cache for it, and fall
 * back to the cached copy only when the network is genuinely gone.
 */
async function fetchMeta(base) {
  try {
    const res = await fetch(`${base}/meta.json?t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) return JSON.parse(await res.text());
  } catch { /* offline — fall through */ }
  return JSON.parse(await fetchText(`${base}/meta.json`));
}

async function loadAll(base) {
  const meta = await fetchMeta(base);
  DATA.meta = meta;
  const coreBytes = meta.core.reduce((n, f) => n + meta.files[f], 0);
  let done = 0;
  // Stamp the build date into the URL so a rebuilt dictionary is a different
  // cache entry. Without it the service worker would serve the old data for
  // ever, since these files are deliberately cached hard.
  const v = encodeURIComponent(meta.built);

  for (const name of meta.core) {
    const text = await fetchText(`${base}/${name}?v=${v}`);
    if (name === 'tags.json') DATA.tags = JSON.parse(text);
    else DATA[name] = new Lines(text);
    done += meta.files[name] || 0;
    postMessage({ type: 'progress', loaded: done, total: coreBytes, file: name });
  }
  ready = true;
  postMessage({ type: 'ready', meta });

  // Example sentences are not needed to answer a query, so they arrive after.
  for (const name of meta.extra) {
    try {
      DATA[name] = new Lines(await fetchText(`${base}/${name}?v=${v}`));
    } catch (err) {
      postMessage({ type: 'note', text: `examples unavailable: ${err.message}` });
      return;
    }
  }
  postMessage({ type: 'extras' });
}

// --------------------------------------------------------- entry hydration

/** Examples arrive in a separate, line-aligned file that may not be loaded yet. */
function examplesFor(file, id) {
  const lines = DATA[file];
  if (!lines || id >= lines.count) return [];
  const raw = lines.line(id);
  return raw ? raw.split(RS).map((e) => e.split(US)) : [];
}

function jpEntry(id) {
  const [kanji, kana, common, senses] = DATA['jp.txt'].line(id).split(FS);
  const kanaForms = kana ? kana.split(RS) : [];
  return {
    kind: 'jp',
    id,
    kanji: kanji ? kanji.split(RS) : [],
    kana: kanaForms,
    romaji: kanaForms.map((k) => kanaToRomaji(k)),
    common: common === '1',
    senses: (senses ? senses.split(RS) : []).map((s) => {
      const [pos, gloss, misc] = s.split(US);
      return {
        pos: pos ? pos.split(',').map((t) => DATA.tags[t] || t) : [],
        gloss,
        misc: misc ? misc.split(',').map((t) => DATA.tags[t] || t) : [],
      };
    }),
    examples: examplesFor('jp.ex.txt', id),
  };
}

function cnEntry(id) {
  const [trad, simp, py, glosses] = DATA['cn.txt'].line(id).split(FS);
  return {
    kind: 'cn',
    id,
    trad,
    simp,
    pinyin: numberedToDiacritics(py),
    pinyinPlain: numberedToToneless(py),
    glosses: glosses ? glosses.split('; ') : [],
    examples: examplesFor('cn.ex.txt', id),
  };
}

/** Compact form used for the cross-language link chips on a card. */
function jpBrief(id) {
  const [kanji, kana, common, senses] = DATA['jp.txt'].line(id).split(FS);
  const head = kanji ? kanji.split(RS)[0] : kana.split(RS)[0];
  const reading = kana ? kana.split(RS)[0] : '';
  return {
    kind: 'jp',
    id,
    head,
    reading,
    romaji: reading ? kanaToRomaji(reading) : '',
    common: common === '1',
    gloss: senses ? senses.split(RS)[0].split(US)[1] : '',
  };
}

function cnBrief(id) {
  const [trad, simp, py, glosses] = DATA['cn.txt'].line(id).split(FS);
  return {
    kind: 'cn',
    id,
    head: trad,
    simp: simp !== trad ? simp : '',
    reading: numberedToDiacritics(py),
    gloss: glosses ? glosses.split('; ').slice(0, 3).join('; ') : '',
  };
}

function linksFor(file, id, brief, max = 5) {
  const lines = DATA[file];
  // A data file can legitimately be absent: an older cached meta.json will not
  // list files added by a later build. Degrade to "no links" rather than throw
  // and take the whole search down with it.
  if (!lines) return [];
  const raw = id < lines.count ? lines.line(id) : '';
  if (!raw) return [];
  // Both dictionaries hold several entries per headword; showing the same
  // word three times as a "translation" is just noise.
  const seen = new Set();
  const out = [];
  for (const tok of raw.split(',')) {
    if (!tok || out.length >= max) break;
    const [tid, score] = tok.split(':');
    const item = { ...brief(Number(tid)), score: Number(score) };
    if (seen.has(item.head)) continue;
    seen.add(item.head);
    out.push(item);
  }
  return out;
}

// ------------------------------------------------------------- scoring

const HIT = {
  exact: 1000,
  deconjugated: 820,
  gloss: 760,   // the query is the whole of some gloss
  prefix: 520,
  loose: 500,   // matched only after collapsing long vowels
  word: 330,    // the query is one word inside a longer gloss
  fuzzy: 260,
};

/** Accumulates the best hit per entry id. */
class Hits {
  constructor() { this.map = new Map(); }
  add(id, score, why) {
    const prev = this.map.get(id);
    if (!prev || score > prev.score) this.map.set(id, { id, score, why });
  }
  get size() { return this.map.size; }
  ranked() { return [...this.map.values()].sort((a, b) => b.score - a.score); }
}

/**
 * Which of an entry's readings the query matched, as an index. 0 means the
 * headword's main reading. 寝 lists ね first and しん third, so searching
 * "shin" should not put it above 新, whose only reading is しん — even though
 * 寝 scores far higher on raw corpus frequency.
 */
function matchedReadingRank(kanaForms, why) {
  const key = why?.key;
  if (!key || why.en) return 0;
  const i = kanaForms.findIndex(
    (k) => toHiragana(k) === key || kanaToRomaji(k).replace(/'/g, '') === key,
  );
  return i > 0 ? i : 0;
}

/**
 * Where in an entry the query turns up: earlier sense and earlier gloss is a
 * better match. Returns Infinity when it does not appear at all, which is
 * normal — the hit may have come from a reading rather than a gloss.
 */
function glossDepth(glossLists, key) {
  if (!key) return Infinity;
  for (let s = 0; s < glossLists.length; s++) {
    const g = glossLists[s].indexOf(key);
    if (g >= 0) return s * 10 + g;
  }
  return Infinity;
}

/** Inverse of the build's packIds: base-36 gaps back to absolute ids. */
function unpackIds(packed) {
  if (!packed) return [];
  const out = [];
  let prev = 0;
  for (const tok of packed.split(',')) {
    prev += parseInt(tok, 36);
    out.push(prev);
  }
  return out;
}

function addIds(hits, packed, score, why) {
  for (const id of unpackIds(packed)) hits.add(id, score, why);
}

/** Levenshtein distance, abandoned as soon as it exceeds `max`. */
function boundedEdit(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * One-typo fallback over the index block sharing the query's first character.
 * Only worth running when the better match types came up empty.
 */
function fuzzyScan(lines, query, hits, cap = 15000) {
  if (query.length < 4) return;
  let scanned = 0;
  for (let i = lines.lowerBound(query[0]); i < lines.count && scanned < cap; i++, scanned++) {
    const k = lines.key(i);
    if (k[0] !== query[0]) break;
    if (Math.abs(k.length - query.length) > 1) continue;
    if (boundedEdit(k, query, 1) <= 1) {
      addIds(hits, lines.value(i), HIT.fuzzy, { type: 'fuzzy', key: k });
    }
  }
}

// ------------------------------------------------------------- lookups

/** Japanese side: kanji, kana, romaji, and inflected forms. */
function lookupJp(query, { romajiPrefix = true } = {}) {
  const hits = new Hits();
  const idx = DATA['jp.idx'];
  const q = query.trim();
  const script = scriptOf(q);

  // Index keys to try, and the kana forms to hand the deconjugator. Romaji is
  // converted to kana so typed and pasted Japanese take the same path.
  const keys = [];
  const kanaForms = [];
  if (script.kana || script.han) {
    const hira = toHiragana(q);
    keys.push(hira);
    kanaForms.push(hira);
  }
  let romaji = '';
  if (script.latin) {
    romaji = normalizeRomaji(q);
    if (romaji) {
      keys.push(romaji);
      kanaForms.push(romajiToHiragana(romaji));
    }
  }

  for (const key of keys) {
    addIds(hits, idx.exact(key), HIT.exact, { type: 'exact', key });
    // Prefix matching on romaji is suppressed for plain English queries:
    // "shit" is a prefix of the reading "shita", which is noise, not a hit.
    if (!romajiPrefix && key === romaji) continue;
    for (const [k, v] of idx.prefix(key, 80)) {
      if (k === key) continue;
      addIds(hits, v, HIT.prefix - Math.min(200, (k.length - key.length) * 12), {
        type: 'prefix', key: k,
      });
    }
  }

  // Inflected input: look up every dictionary form the rules can reach, by
  // kana and (for romaji input) by its romanization too.
  for (const kana of kanaForms) {
    for (const { form, reasons } of deconjugate(kana)) {
      if (form === kana) continue;
      const score = HIT.deconjugated - reasons.length * 20;
      const why = { type: 'deconjugated', key: form, reasons };
      addIds(hits, idx.exact(form), score, why);
      if (romaji) addIds(hits, idx.exact(kanaToRomaji(form).replace(/'/g, '')), score, why);
    }
  }

  // Long-vowel-insensitive fallback: "tookyoo" and "tokyo" for とうきょう.
  if (romaji && romajiPrefix && hits.size < 8) {
    const loose = `~${looseRomaji(romaji)}`;
    addIds(hits, idx.exact(loose), HIT.loose, { type: 'spelling', key: loose.slice(1) });
    for (const [k, v] of idx.prefix(loose, 40)) {
      if (k === loose) continue;
      addIds(hits, v, HIT.loose - Math.min(200, (k.length - loose.length) * 12), {
        type: 'spelling', key: k.slice(1),
      });
    }
  }

  // Only when nothing matched at all: a typo fallback that fires alongside
  // good hits just buries them in near-spellings.
  if (hits.size === 0 && romaji) fuzzyScan(idx, romaji, hits);
  return hits;
}

/** Chinese side: hanzi (either script) and pinyin with or without tones. */
function lookupCn(query, { pinyinPrefix = true } = {}) {
  const hits = new Hits();
  const idx = DATA['cn.idx'];
  const script = scriptOf(query);
  const keys = [];

  if (script.han) keys.push(query.trim());
  if (script.latin) {
    keys.push(normalizePinyin(query));
    const spaced = query.toLowerCase().trim().replace(/\s+/g, ' ');
    if (spaced.includes(' ')) keys.push(spaced);
  }

  for (const key of keys) {
    if (!key) continue;
    addIds(hits, idx.exact(key), HIT.exact, { type: 'exact', key });
    // Same reasoning as the romaji side: an English word should not prefix
    // match its way into a pile of unrelated pinyin syllables.
    if (!pinyinPrefix && script.latin) continue;
    for (const [k, v] of idx.prefix(key, 80)) {
      if (k === key) continue;
      addIds(hits, v, HIT.prefix - Math.min(200, (k.length - key.length) * 12), {
        type: 'prefix', key: k,
      });
    }
  }

  if (hits.size === 0 && script.latin) fuzzyScan(idx, normalizePinyin(query), hits);
  return { hits, keys };
}

/** English side. Returns hits for both dictionaries. */
function lookupEn(query) {
  const idx = DATA['en.idx'];
  const jp = new Hits();
  const cn = new Hits();
  const norm = query.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!norm) return { jp, cn };

  // Each line is "phraseJP|phraseCN|wordJP|wordCN": entries whose whole gloss
  // is this key, then entries that merely contain it.
  const take = (value, phraseScore, why) => {
    const [pj, pc, wj, wc] = value.split('|');
    addIds(jp, pj, phraseScore, { ...why, en: true });
    addIds(cn, pc, phraseScore, { ...why, en: true });
    addIds(jp, wj, HIT.word, { ...why, type: 'in gloss', en: true });
    addIds(cn, wc, HIT.word, { ...why, type: 'in gloss', en: true });
  };

  const phrase = norm.replace(/^to\s+/, '').replace(/^(?:a|an|the)\s+/, '');
  const hit = idx.exact(phrase);
  if (hit) take(hit, HIT.gloss, { type: 'gloss', key: phrase });

  for (const [k, v] of idx.prefix(phrase, 40)) {
    if (k === phrase) continue;
    const [pj, pc] = v.split('|');
    const score = HIT.prefix - Math.min(200, (k.length - phrase.length) * 8);
    addIds(jp, pj, score, { type: 'prefix', key: k, en: true });
    addIds(cn, pc, score, { type: 'prefix', key: k, en: true });
  }

  // Multi-word queries: require every word, anywhere in the entry's glosses.
  const words = phrase.split(' ').filter((w) => w.length > 1);
  if (words.length > 1) {
    const perWord = words.map((w) => {
      const v = idx.exact(w);
      if (!v) return null;
      const [pj, pc, wj, wc] = v.split('|');
      return {
        j: new Set([...unpackIds(pj), ...unpackIds(wj)]),
        c: new Set([...unpackIds(pc), ...unpackIds(wc)]),
      };
    });
    if (perWord.every(Boolean)) {
      for (const side of ['j', 'c']) {
        const sets = perWord.map((p) => p[side]).sort((a, b) => a.size - b.size);
        for (const id of sets[0]) {
          if (sets.every((s) => s.has(id))) {
            (side === 'j' ? jp : cn).add(id, HIT.word, { type: 'all words', key: phrase, en: true });
          }
        }
      }
    }
  } else if (words.length === 1 && words[0] !== phrase) {
    const v = idx.exact(words[0]);
    if (v) take(v, HIT.gloss, { type: 'gloss', key: words[0] });
  }

  return { jp, cn };
}

// ---------------------------------------------------------------- modes

// The mode picks which language's entries come back, not which direction the
// lookup runs: every query is matched against Japanese, Chinese and English
// regardless. In a single-language mode, matches in the *other* language are
// followed through the pivot links, which is what replaces the old JP→CN and
// CN→JP modes.
const MODES = {
  all: { show: ['jp', 'cn'], link: 'both', bridge: false },
  jp: { show: ['jp'], link: 'cn', bridge: true },
  cn: { show: ['cn'], link: 'jp', bridge: true },
  // Both languages, but only entries that actually have a counterpart on the
  // other side — an entry with no pivot link is a dead end here.
  jpcn: { show: ['jp', 'cn'], link: 'both', bridge: false, requireLink: true },
};

// Senses marked only with these are dictionary trivia: archaic, obscure,
// children's words and the like. An entry whose every sense is one of them is
// noise in a result list, however real the word is.
const LOW_VALUE = new Set([
  'arch', 'obs', 'obsc', 'rare', 'dated', 'chn', 'sl', 'derog', 'joc',
  'vulg', 'X', 'male-sl', 'poet', 'euph', 'yoji', 'proverb', 'id',
]);

/** True when every sense of a JP entry carries a low-value tag. */
function jpIsMinor(senses) {
  if (!senses) return false;
  const list = senses.split(RS);
  return list.every((s) => {
    const misc = s.split(US)[2];
    return misc ? misc.split(',').some((t) => LOW_VALUE.has(t)) : false;
  });
}

const CN_MINOR = /^(?:(?:old|archaic|erhua)\s+)?variant of|^surname\s|^see [A-Z]?|^abbr\. for/i;

/** True when a CC-CEDICT entry is only a cross-reference or a surname. */
function cnIsMinor(glosses) {
  if (!glosses) return false;
  return glosses.split('; ').every((g) => CN_MINOR.test(g.trim()));
}

function search({ query, mode, limit = 25, hideMinor = true }) {
  const cfg = MODES[mode] || MODES.all;
  const q = query.trim();
  if (!q) return { results: [], counts: {}, hidden: 0 };

  const jpHits = new Hits();
  const cnHits = new Hits();
  const merge = (into, from, weight = 1) => {
    for (const h of from.map.values()) into.add(h.id, h.score * weight, h.why);
  };

  // A latin query that is itself a dictionary gloss ("shit", "eat") is English,
  // not a mistyped reading, so transliteration prefix matching is turned off
  // for it. Exact reading matches still count, so "sake" finds 酒.
  const isEnglishWord = !scriptOf(q).kana && !scriptOf(q).han
    && DATA['en.idx'].exact(normGloss(q)) !== null;

  // Always look in all three; the mode only decides what is shown.
  merge(jpHits, lookupJp(q, { romajiPrefix: !isEnglishWord }));
  merge(cnHits, lookupCn(q, { pinyinPrefix: !isEnglishWord }).hits);
  const en = lookupEn(q);
  // No extra weight needed: the gloss tier already sits below the headword
  // tiers, and ties are broken by the ordering further down.
  merge(jpHits, en.jp);
  merge(cnHits, en.cn);

  // Single-language mode: reach the requested language through the pivot when
  // the query actually matched the other one (typing 吃 with JP selected).
  if (cfg.bridge) {
    const [from, into, file, want] = cfg.show[0] === 'jp'
      ? [cnHits, jpHits, 'cn2jp.txt', 'jp']
      : [jpHits, cnHits, 'jp2cn.txt', 'cn'];
    const lines = DATA[file];
    for (const h of lines ? from.ranked().slice(0, 40) : []) {
      if (h.id >= lines.count) continue;
      for (const tok of lines.line(h.id).split(',')) {
        if (!tok) continue;
        const [tid] = tok.split(':');
        into.add(Number(tid), h.score * 0.55, { type: `via ${want === 'jp' ? 'Chinese' : 'Japanese'}`, key: h.why?.key });
      }
    }
  }

  let wanted = [];
  if (cfg.show.includes('jp')) wanted.push(...jpHits.ranked().map((h) => ({ ...h, kind: 'jp' })));
  if (cfg.show.includes('cn')) wanted.push(...cnHits.ranked().map((h) => ({ ...h, kind: 'cn' })));

  if (cfg.requireLink) {
    const hasLink = (h, file) => {
      const lines = DATA[file];
      return !!lines && h.id < lines.count && lines.line(h.id).length > 0;
    };
    wanted = wanted.filter((h) => (h.kind === 'jp'
      ? hasLink(h, 'jp2cn.han.txt') || hasLink(h, 'jp2cn.txt')
      : hasLink(h, 'cn2jp.han.txt') || hasLink(h, 'cn2jp.txt')));
  }

  // Two passes: cut to a shortlist on match quality alone, then re-rank that
  // shortlist with per-entry signals. A broad English word can match hundreds
  // of entries at an identical score, and how much the word is actually used
  // is what separates them.
  const shortlist = wanted.sort((a, b) => b.score - a.score).slice(0, 400);
  const enKey = normGloss(q);

  // Entry quality is applied as an explicit ordering, not as points added to
  // the match score. Adding them meant several strong signals could outweigh
  // the match itself: searching "shit" put くっそ above 糞 because くっそ's
  // first gloss is exactly "shit!", even though 糞 is the common, canonical
  // word carrying "shit" in its first sense. Deciding the tie by commonness
  // first is both more predictable and easier to reason about.
  for (const h of shortlist) {
    // Gloss depth says where an *English* query sits among an entry's senses.
    // It means nothing for a reading match, and applying it there let シン beat
    // 新 for "shin" purely because シン happens to carry a literal "shin" gloss.
    const useDepth = enKey && h.why?.en;
    if (h.kind === 'jp') {
      const [kanji, kana, common, senses, freq, seen] = DATA['jp.txt'].line(h.id).split(FS);
      h.common = common === '1';
      // Japanese ranks on total corpus presence (`seen`). JMdict's `common`
      // flag already separates real words from clutter, so the segmented count
      // adds nothing and actively hurts: single kanji like 新 are mostly used
      // inside compounds, so segmenting starved them and pushed 信 above 新.
      h.freq = Number(seen || 0);
      h.seen = Number(seen || 0);
      const kanaForms = kana ? kana.split(RS) : [];
      const head = (kanji ? kanji.split(RS)[0] : kanaForms[0]) || '';
      h.headLen = head.length;
      h.readingRank = matchedReadingRank(kanaForms, h.why);
      h.depth = useDepth
        ? glossDepth(
            (senses ? senses.split(RS) : []).map(
              (s) => (s.split(US)[1] || '').split('; ').map(normGloss),
            ),
            enKey,
          )
        : Infinity;
      h.minor = jpIsMinor(senses) || (!h.common && !h.seen);
    } else {
      const [trad, , , glosses, freq, seen] = DATA['cn.txt'].line(h.id).split(FS);
      h.common = false;
      // Chinese has no commonness flag, so the corpus is the only signal — and
      // raw substring counts are dominated by bound morphemes (什 outscored
      // 什麼 three to one). The segmented count is what distinguishes a word
      // from a piece of one.
      h.freq = Number(freq || 0);
      h.seen = Number(seen || 0);
      h.headLen = trad.length;
      h.readingRank = 0;
      h.depth = useDepth ? glossDepth([(glosses || '').split('; ').map(normGloss)], enKey) : Infinity;
      h.minor = cnIsMinor(glosses) || !h.seen;
    }
    if (!Number.isFinite(h.depth)) h.depth = 9999;
  }

  /** Strongest match first, then the most useful entry among equal matches. */
  const byRank = (a, b) => (
    (a.minor === b.minor ? 0 : a.minor ? 1 : -1)
    || b.score - a.score              // match tier, and specificity within it
    || (a.common === b.common ? 0 : a.common ? -1 : 1)
    || a.readingRank - b.readingRank  // matched the entry's main reading
    // Whether the query is in the headline sense at all, then how common the
    // word is, then the finer position. Comparing exact depth before frequency
    // put 3Q above 謝謝 for "thank you", because "thank you" is 3Q's only
    // gloss and 謝謝's third.
    || (a.depth < 10 ? 0 : 1) - (b.depth < 10 ? 0 : 1)
    || b.freq - a.freq                // how often the word is actually used
    || a.depth - b.depth
    || (a.kind === b.kind ? 0 : a.kind === 'cn' ? -1 : 1) // Chinese first on a tie
    || a.headLen - b.headLen
  );

  // An exact headword match is never hidden: if you look a word up by name you
  // get it, however obscure. Only gloss-derived clutter is dropped.
  let hidden = 0;
  const kept = shortlist.filter((h) => {
    if (!hideMinor || !h.minor || h.why?.type === 'exact') return true;
    hidden++;
    return false;
  });

  const ranked = kept.sort(byRank).slice(0, limit);

  const results = ranked.map((h) => {
    const entry = h.kind === 'jp' ? jpEntry(h.id) : cnEntry(h.id);
    entry.why = h.why;
    entry.score = Math.round(h.score);
    const wantLinks = h.kind === 'jp'
      ? (cfg.link === 'cn' || cfg.link === 'both')
      : (cfg.link === 'jp' || cfg.link === 'both');
    const [hanFile, glossFile, brief] = h.kind === 'jp'
      ? ['jp2cn.han.txt', 'jp2cn.txt', cnBrief]
      : ['cn2jp.han.txt', 'cn2jp.txt', jpBrief];
    if (wantLinks) {
      entry.hanziLinks = linksFor(hanFile, h.id, brief);
      // The same entry reached both ways is one result, shown under the
      // stronger heading.
      const already = new Set(entry.hanziLinks.map((l) => l.id));
      entry.links = linksFor(glossFile, h.id, brief, 8)
        .filter((l) => !already.has(l.id))
        .slice(0, 5);
    } else {
      entry.hanziLinks = [];
      entry.links = [];
    }
    return entry;
  });

  return {
    results,
    hidden,
    counts: { jp: jpHits.size, cn: cnHits.size },
  };
}

// ------------------------------------------------------------- messages

onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    if (type === 'load') {
      await loadAll(payload.base);
      return;
    }
    if (type === 'search') {
      if (!ready) throw new Error('data not loaded yet');
      postMessage({ id, type: 'result', payload: search(payload) });
      return;
    }
    if (type === 'char') {
      // A single character, for the hover popover: the most-used Chinese
      // entry written exactly that way.
      const lines = DATA['cn.idx'];
      let best = null;
      for (const cid of unpackIds(lines ? lines.exact(payload.ch) : null)) {
        const [trad, simp, py, glosses, freq] = DATA['cn.txt'].line(cid).split(FS);
        const f = Number(freq || 0);
        // A character usually has several entries; prefer one that actually
        // defines it over a cross-reference or a surname, whatever their
        // corpus counts. Hovering 書 should give "book", not "abbr. for 書經".
        const minor = cnIsMinor(glosses);
        const better = !best
          || (best.minor && !minor)
          || (best.minor === minor && f > best.freq);
        if (better) {
          best = {
            id: cid,
            freq: f,
            minor,
            head: trad,
            simp: simp !== trad ? simp : '',
            reading: numberedToDiacritics(py),
            gloss: glosses ? glosses.split('; ').slice(0, 4).join('; ') : '',
          };
        }
      }
      postMessage({ id, type: 'result', payload: { char: best } });
      return;
    }
    if (type === 'entry') {
      const entry = payload.kind === 'jp' ? jpEntry(payload.id) : cnEntry(payload.id);
      const [hf, gf, br] = payload.kind === 'jp'
        ? ['jp2cn.han.txt', 'jp2cn.txt', cnBrief]
        : ['cn2jp.han.txt', 'cn2jp.txt', jpBrief];
      entry.hanziLinks = linksFor(hf, payload.id, br, 8);
      const seenIds = new Set(entry.hanziLinks.map((l) => l.id));
      entry.links = linksFor(gf, payload.id, br, 10).filter((l) => !seenIds.has(l.id)).slice(0, 8);
      postMessage({ id, type: 'result', payload: { results: [entry], counts: {} } });
      return;
    }
    throw new Error(`unknown message ${type}`);
  } catch (err) {
    postMessage({ id, type: 'error', error: String(err && err.message ? err.message : err) });
  }
};
