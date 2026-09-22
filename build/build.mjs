#!/usr/bin/env node
// Turns the upstream dictionary dumps into the compact files the page loads.
//
//   node --max-old-space-size=8192 build/build.mjs <srcDir> <outDir>
//
// Output is deliberately line-oriented text rather than JSON: the page keeps
// each file as one big string and binary-searches it, so a phone never has to
// parse a 30 MB object graph just to look up one word.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { kanaToRomaji, toHiragana, looseRomaji } from '../lib/kana.js';
import { numberedToToneless, normalizePinyin } from '../lib/pinyin.js';
import { normGloss, glossWords } from '../lib/gloss.js';

const FS = '\x1f'; // between fields of an entry
const RS = '\x1e'; // between repeated items within a field
const US = '\x1d'; // between subfields of an item

const srcDir = process.argv[2];
const outDir = process.argv[3];
if (!srcDir || !outDir) {
  console.error('usage: build.mjs <srcDir> <outDir>');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const log = (...a) => console.log('[build]', ...a);

// ---------------------------------------------------------------- CC-CEDICT

/** @returns {{trad:string,simp:string,py:string,glosses:string[]}[]} */
function parseCedict(file) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const m = /^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.*)\/\s*$/.exec(line);
    if (!m) continue;
    // CC-CEDICT separates senses with "/" but packs near-synonyms into one
    // sense with ";", so "to eat; to consume" has to be split both ways or
    // the whole string becomes one unmatchable key.
    const glosses = m[4]
      .split('/')
      .flatMap((g) => g.split(';'))
      .map((g) => g.trim())
      .filter(Boolean);
    if (!glosses.length) continue;
    out.push({ trad: m[1], simp: m[2], py: m[3], glosses });
  }
  return out;
}

// ------------------------------------------------------------------ JMdict

/**
 * The jmdict-simplified dump puts one word object per line, so we can read it
 * incrementally instead of materialising a multi-gigabyte object graph.
 */
async function parseJmdict(file, onWord) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let tags = {};
  let inWords = false;
  for await (const raw of rl) {
    const line = raw.trim();
    if (!inWords) {
      if (line.startsWith('"tags"')) {
        tags = JSON.parse(`{${line.replace(/,$/, '')}}`).tags;
      }
      if (line.startsWith('"words"')) inWords = true;
      continue;
    }
    if (line === ']' || line === ']}' || line === '}') continue;
    let json = line.endsWith(',') ? line.slice(0, -1) : line;
    if (json.length < 2) continue;
    let word;
    try {
      word = JSON.parse(json);
    } catch {
      // The last entry shares its line with the brackets that close the file;
      // peel them off until what is left parses.
      while (json.length > 2 && !word) {
        json = json.slice(0, -1);
        try { word = JSON.parse(json); } catch { /* keep peeling */ }
      }
      if (!word) continue;
    }
    onWord(word);
  }
  return tags;
}

// ----------------------------------------------------------- gloss handling

// --------------------------------------------------------- index accumulator

/**
 * Ids are ascending, so store gaps in base 36. "12,15,900" becomes "c,3,qj".
 * Roughly halves the index files, which are mostly id lists.
 */
function packIds(ids) {
  let prev = 0;
  let out = '';
  for (const id of ids) {
    out += (out ? ',' : '') + (id - prev).toString(36);
    prev = id;
  }
  return out;
}

/** Collects key -> id list, then emits a sorted, binary-searchable text file. */
class Index {
  constructor(cap = 600) {
    this.map = new Map();
    this.cap = cap;
  }
  add(key, id) {
    if (!key) return;
    let v = this.map.get(key);
    if (!v) { v = []; this.map.set(key, v); }
    if (v.length < this.cap && v[v.length - 1] !== id) v.push(id);
  }
  write(file, encode = packIds) {
    const keys = [...this.map.keys()].sort();
    const parts = [];
    for (const k of keys) parts.push(k, '\t', encode(this.map.get(k)), '\n');
    fs.writeFileSync(file, parts.join(''));
    return keys.length;
  }
}

// ------------------------------------------------------------------- main

const t0 = Date.now();

log('parsing CC-CEDICT...');
const cedict = parseCedict(path.join(srcDir, 'cedict.txt.gz'));
log(`  ${cedict.length} Chinese entries`);

log('parsing JMdict (this takes a minute)...');
const jmdictFile = fs.readdirSync(srcDir).find((f) => /^jmdict-examples-eng.*\.json$/.test(f));
if (!jmdictFile) throw new Error(`no jmdict-examples-eng*.json in ${srcDir} — run build/fetch.mjs`);
const jp = [];
const jmTags = await parseJmdict(path.join(srcDir, jmdictFile), (w) => {
  const kanji = w.kanji.map((k) => k.text);
  const kana = w.kana.map((k) => k.text);
  const common = w.kanji.some((k) => k.common) || w.kana.some((k) => k.common);
  const senses = [];
  const examples = [];
  for (const s of w.sense) {
    const glosses = s.gloss.map((g) => g.text);
    if (!glosses.length) continue;
    senses.push({
      pos: s.partOfSpeech,
      misc: [...(s.misc || []), ...(s.field || [])],
      glosses,
    });
    for (const ex of s.examples || []) {
      if (examples.length >= 3) break;
      const j = ex.sentences.find((x) => x.lang === 'jpn');
      const e = ex.sentences.find((x) => x.lang === 'eng');
      if (j && e) examples.push([j.text, e.text]);
    }
  }
  if (!senses.length) return;
  jp.push({ kanji, kana, common, senses, examples });
});
log(`  ${jp.length} Japanese entries`);

// ------------------------------------------------------ Japanese frequency

// JMdict's "common" flag is binary and coarse, which leaves obscure entries
// sitting next to everyday words. Counting headwords in the Tatoeba Japanese
// corpus gives a real usage signal to rank with.
/**
 * Corpus counts, two ways.
 *
 *   freq — longest-match segmentation: only the word actually chosen at each
 *          position is counted. This is the ranking signal.
 *   seen — plain substring occurrences. Only used to answer "is this word
 *          attested at all", which decides whether it can be filtered away.
 *
 * Substring counting alone is badly misleading: 什 appears inside every 什麼
 * and 為什麼, giving it 3653 hits against 什麼's 1332, so "what" ranked the
 * bound morpheme above the actual word. Segmenting drops 什 to 21.
 */
function countCorpus(sentences, forms, size, maxLen, { split = false } = {}) {
  // `split` shares a form's count among the entries that write it the same
  // way, because the corpus cannot say which homograph it is. CC-CEDICT needs
  // this — 嗎 has three entries differing only in pinyin, and the "(coll.)
  // what?" one was taking the whole question-particle count. JMdict does not:
  // it has fewer same-form entries and a `common` flag that already separates
  // them, and splitting there demoted 新 below 信 for "shin".
  const freq = new Float64Array(size);
  const seen = new Float64Array(size);
  let n = 0;
  for (const line of sentences.split('\n')) {
    const i = line.indexOf('\t');
    if (i < 0) continue;
    const j = line.indexOf('\t', i + 1);
    const s = line.slice(j + 1);
    if (!s || s.length > 60) continue;
    n++;
    for (let a = 0; a < s.length; a++) {
      for (let len = 1; len <= maxLen && a + len <= s.length; len++) {
        const ids = forms.get(s.slice(a, a + len));
        if (ids) { const w = split ? 1 / ids.length : 1; for (const id of ids) seen[id] += w; }
      }
    }
    let a = 0;
    while (a < s.length) {
      let hit = 0;
      for (let len = Math.min(maxLen, s.length - a); len >= 1; len--) {
        const ids = forms.get(s.slice(a, a + len));
        if (ids) {
          const w = split ? 1 / ids.length : 1;
          for (const id of ids) freq[id] += w;
          hit = len;
          break;
        }
      }
      a += hit || 1;
    }
  }
  return {
    freq: Uint32Array.from(freq, Math.round),
    seen: Uint32Array.from(seen, Math.round),
    sentences: n,
  };
}

log('counting Japanese word frequency...');
const jpFreq = new Uint32Array(jp.length);
const jpSeen = new Uint32Array(jp.length);
{
  const surface = new Map(); // written form -> jp entry ids
  let maxLen = 1;
  jp.forEach((e, i) => {
    for (const form of new Set([...e.kanji, ...e.kana])) {
      if (!form || form.length > 8) continue;
      let v = surface.get(form);
      if (!v) { v = []; surface.set(form, v); }
      v.push(i);
      if (form.length > maxLen) maxLen = form.length;
    }
  });
  const text = execFileSync('bzcat', [path.join(srcDir, 'jpn_sentences.tsv.bz2')], {
    maxBuffer: 1 << 30, encoding: 'utf8',
  });
  const r = countCorpus(text, surface, jp.length, maxLen);
  jpFreq.set(r.freq);
  jpSeen.set(r.seen);
  log(`  ${r.sentences} sentences, ${jpSeen.reduce((n, f) => n + (f > 0 ? 1 : 0), 0)} attested`);
}

// ------------------------------------------------- Tatoeba Chinese examples

log('parsing Tatoeba links...');
const readBz2 = (f) => execFileSync('bzcat', [f], { maxBuffer: 1 << 30, encoding: 'utf8' });

const cmnText = new Map(); // id -> chinese sentence
for (const line of readBz2(path.join(srcDir, 'cmn_sentences.tsv.bz2')).split('\n')) {
  const i = line.indexOf('\t');
  if (i < 0) continue;
  const j = line.indexOf('\t', i + 1);
  cmnText.set(line.slice(0, i), line.slice(j + 1));
}
const engText = new Map();
for (const line of readBz2(path.join(srcDir, 'eng_sentences.tsv.bz2')).split('\n')) {
  const i = line.indexOf('\t');
  if (i < 0) continue;
  const j = line.indexOf('\t', i + 1);
  engText.set(line.slice(0, i), line.slice(j + 1));
}
log(`  ${cmnText.size} cmn / ${engText.size} eng sentences`);

/** Chinese sentence -> English translation, for pairs Tatoeba links. */
const cmnPairs = [];
{
  const seen = new Set();
  const links = fs.readFileSync(path.join(srcDir, 'links.csv'), 'utf8');
  let start = 0;
  while (start < links.length) {
    let end = links.indexOf('\n', start);
    if (end < 0) end = links.length;
    const tab = links.indexOf('\t', start);
    if (tab > 0 && tab < end) {
      const a = links.slice(start, tab);
      const b = links.slice(tab + 1, end);
      if (!seen.has(a) && cmnText.has(a) && engText.has(b)) {
        seen.add(a);
        cmnPairs.push([cmnText.get(a), engText.get(b)]);
      }
    }
    start = end + 1;
  }
}
cmnText.clear();
engText.clear();
log(`  ${cmnPairs.length} cmn-eng sentence pairs`);

// Attach examples by scanning each sentence for headwords it contains.
// Substring enumeration (1..6 chars) is far cheaper than matching 125k
// headwords against every sentence.
log('matching Chinese examples to headwords...');
const headword = new Map(); // surface form -> cedict indices
cedict.forEach((e, i) => {
  for (const form of new Set([e.trad, e.simp])) {
    if (form.length > 6) continue;
    let v = headword.get(form);
    if (!v) { v = []; headword.set(form, v); }
    v.push(i);
  }
});
const cnExamples = cedict.map(() => []);
// CC-CEDICT carries no frequency information, which leaves no way to prefer
// 吃 over 下箸. Corpus counts stand in — see countCorpus for why there are two.
const cnFreq = new Uint32Array(cedict.length);
const cnSeen = new Uint32Array(cedict.length);
{
  const forms = new Map();
  let maxLen = 1;
  cedict.forEach((e, i) => {
    for (const f of new Set([e.trad, e.simp])) {
      if (f.length > 8) continue;
      let v = forms.get(f);
      if (!v) { v = []; forms.set(f, v); }
      v.push(i);
      if (f.length > maxLen) maxLen = f.length;
    }
  });
  const r = countCorpus(readBz2(path.join(srcDir, 'cmn_sentences.tsv.bz2')), forms, cedict.length, maxLen, { split: true });
  cnFreq.set(r.freq);
  cnSeen.set(r.seen);
  log(`  Chinese: ${r.sentences} sentences, ${cnSeen.reduce((n, f) => n + (f > 0 ? 1 : 0), 0)} attested`);
}
// Short sentences illustrate a word better than long ones.
cmnPairs.sort((a, b) => a[0].length - b[0].length);
for (const [zh, en] of cmnPairs) {
  if (zh.length > 40) continue;
  for (let i = 0; i < zh.length; i++) {
    for (let n = 1; n <= 6 && i + n <= zh.length; n++) {
      const ids = headword.get(zh.slice(i, i + n));
      if (!ids) continue;
      for (const id of ids) {
        if (cnExamples[id].length < 3) cnExamples[id].push([zh, en]);
      }
    }
  }
}
headword.clear();
log(`  ${cnExamples.filter((x) => x.length).length} Chinese entries with examples`);

// ------------------------------------------------------- English gloss pivot

log('building English pivot...');
const jpByGloss = new Map(); // normalized gloss -> jp ids
const cnByGloss = new Map();
const addGloss = (map, key, id) => {
  let v = map.get(key);
  if (!v) { v = []; map.set(key, v); }
  v.push(id);
};

const jpGlossKeys = jp.map((e, i) => {
  const keys = new Set();
  for (const s of e.senses) for (const g of s.glosses) {
    const n = normGloss(g);
    if (n && n.length > 1) keys.add(n);
  }
  for (const k of keys) addGloss(jpByGloss, k, i);
  return keys;
});
const cnGlossKeys = cedict.map((e, i) => {
  const keys = new Set();
  for (const g of e.glosses) {
    const n = normGloss(g);
    if (n && n.length > 1) keys.add(n);
  }
  for (const k of keys) addGloss(cnByGloss, k, i);
  return keys;
});

/**
 * Link JP and CN entries that share an English gloss.
 *
 * Rarity damping alone is wrong here: it ranks an obscure entry that happens
 * to share a rare gloss above the obvious everyday translation. So the
 * headline sense of each entry — its first gloss — carries extra weight, which
 * is what puts 吃 rather than 下箸 at the top for 食べる.
 */
const MAX_LINKS = 8;
const primaryJ = jp.map((e) => normGloss(e.senses[0].glosses[0]));
const primaryC = cedict.map((e) => normGloss(e.glosses[0]));
const jp2cn = jp.map(() => []);
const cn2jp = cedict.map(() => []);
for (let i = 0; i < jp.length; i++) {
  const scores = new Map();
  const pj = primaryJ[i];
  for (const key of jpGlossKeys[i]) {
    const cns = cnByGloss.get(key);
    // A gloss shared by hundreds of entries is weak, but it is often also the
    // right one ("eat"), so damp it rather than discarding it.
    if (!cns || cns.length > 400) continue;
    const dfJ = jpByGloss.get(key).length;
    const w = 1 / Math.sqrt(dfJ * cns.length);
    for (const c of cns) scores.set(c, (scores.get(c) || 0) + w);
  }
  if (!scores.size) continue;
  for (const [c, s] of scores) {
    let bonus = 0;
    if (pj && pj === primaryC[c]) bonus += 2;               // headline senses agree
    else if (pj && cnGlossKeys[c].has(pj)) bonus += 0.8;    // ours is one of theirs
    else if (primaryC[c] && jpGlossKeys[i].has(primaryC[c])) bonus += 0.8;
    // Short Chinese headwords are the everyday words; long ones are compounds
    // that only coincidentally share a gloss.
    if (cedict[c].trad.length <= 2) bonus += 0.3;
    bonus += Math.min(1.6, Math.log10(1 + cnFreq[c]) * 0.7);
    if (bonus) scores.set(c, s + bonus);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_LINKS);
  jp2cn[i] = ranked;
  for (const [c, s] of ranked) cn2jp[c].push([i, s]);
}
// The reverse direction needs the same preference for common, headline senses;
// a Chinese word should surface 食べる before 吸い取る.
for (let c = 0; c < cn2jp.length; c++) {
  cn2jp[c] = cn2jp[c].map(([i, s]) => {
    let bonus = jp[i].common ? 1.5 : 0;
    bonus += Math.min(1.6, Math.log10(1 + jpFreq[i]) * 0.7);
    if (primaryC[c] && primaryC[c] === primaryJ[i]) bonus += 2;
    return [i, s + bonus];
  });
}
for (let c = 0; c < cn2jp.length; c++) {
  cn2jp[c] = cn2jp[c].sort((a, b) => b[1] - a[1]).slice(0, MAX_LINKS);
}
log(`  ${jp2cn.filter((x) => x.length).length} JP entries linked to Chinese`);

// ------------------------------------------------- orthographic (hanzi) link

// A far stronger signal than a shared English gloss: the Japanese written form
// *is* a Chinese word. Matching against both CC-CEDICT columns covers the two
// common cases — Japanese forms identical to traditional Chinese (新聞), and
// shinjitai that coincide with simplified Chinese (国, 学, 会). Shinjitai that
// match neither (駅, 塩) are missed; that needs a kyūjitai table.
//
// These are orthographic matches, not verified translations: 大丈夫 exists in
// both languages meaning different things. The page labels them as such and
// shows the glosses so the reader can judge.
log('matching Japanese and Chinese by written form...');
const jp2cnHan = jp.map(() => []);
const cn2jpHan = cedict.map(() => []);
{
  // shinjitai -> kyujitai, from Unihan. Without it 図書館 never reaches
  // 圖書館, because the modern Japanese form of 圖 exists in no Chinese script.
  const oldForm = new Map();
  const variantsFile = path.join(srcDir, 'Unihan_Variants.txt');
  if (fs.existsSync(variantsFile)) {
    for (const line of fs.readFileSync(variantsFile, 'utf8').split('\n')) {
      if (line[0] !== 'U') continue;
      const [cp, field, rest] = line.split('\t');
      if (field !== 'kJapaneseOldVariant') continue;
      const ch = String.fromCodePoint(parseInt(cp.slice(2), 16));
      const olds = rest.trim().split(/\s+/).slice(0, 3)
        .map((t) => String.fromCodePoint(parseInt(t.replace(/^U\+/, '').split('<')[0], 16)));
      oldForm.set(ch, olds);
    }
    log(`  ${oldForm.size} shinjitai->kyujitai mappings`);
  } else {
    log('  no Unihan_Variants.txt — shinjitai forms will not match (run build/fetch.mjs)');
  }

  /** The word as written, plus spellings using the pre-reform characters. */
  function traditionalForms(word) {
    let forms = [''];
    for (const ch of word) {
      const options = [ch, ...(oldForm.get(ch) || [])];
      const next = [];
      for (const prefix of forms) {
        for (const o of options) {
          if (next.length < 12) next.push(prefix + o);
        }
      }
      forms = next;
    }
    return forms.slice(1); // index 0 is the word unchanged, matched separately
  }

  const cnByForm = new Map();
  cedict.forEach((e, i) => {
    for (const f of new Set([e.trad, e.simp])) {
      let v = cnByForm.get(f);
      if (!v) { v = []; cnByForm.set(f, v); }
      v.push(i);
    }
  });
  const jpByForm = new Map();
  jp.forEach((e, i) => {
    for (const k of new Set(e.kanji)) {
      let v = jpByForm.get(k);
      if (!v) { v = []; jpByForm.set(k, v); }
      v.push(i);
    }
  });

  // Reverse map too, so a Chinese headword finds the modern Japanese spelling.
  const jpByOldForm = new Map();
  jp.forEach((e, i) => {
    for (const k of new Set(e.kanji)) {
      for (const t of traditionalForms(k)) {
        let v = jpByOldForm.get(t);
        if (!v) { v = []; jpByOldForm.set(t, v); }
        v.push(i);
      }
    }
  });

  jp.forEach((e, i) => {
    const best = new Map();
    for (const k of e.kanji) {
      // A direct hit outranks one that needed the pre-reform spelling.
      for (const c of cnByForm.get(k) || []) {
        const s = Math.log10(1 + cnFreq[c]) + (cedict[c].trad === k ? 0.2 : 0) + 1;
        if (!(best.get(c) >= s)) best.set(c, s);
      }
      for (const t of traditionalForms(k)) {
        for (const c of cnByForm.get(t) || []) {
          const s = Math.log10(1 + cnFreq[c]);
          if (!(best.get(c) >= s)) best.set(c, s);
        }
      }
    }
    jp2cnHan[i] = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_LINKS);
  });

  cedict.forEach((e, c) => {
    const best = new Map();
    for (const f of new Set([e.trad, e.simp])) {
      for (const j of jpByForm.get(f) || []) {
        const s = (jp[j].common ? 1 : 0) + Math.log10(1 + jpFreq[j]) + 1;
        if (!(best.get(j) >= s)) best.set(j, s);
      }
      for (const j of jpByOldForm.get(f) || []) {
        const s = (jp[j].common ? 1 : 0) + Math.log10(1 + jpFreq[j]);
        if (!(best.get(j) >= s)) best.set(j, s);
      }
    }
    cn2jpHan[c] = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_LINKS);
  });

  log(`  ${jp2cnHan.filter((x) => x.length).length} JP entries have a written-form match`);
  log(`  ${cn2jpHan.filter((x) => x.length).length} CN entries have one`);
}

// ------------------------------------------------------------ emit entries

log('writing entry files...');
// Example sentences live in their own line-aligned files so the page can start
// answering queries before they have finished downloading.
const jpLines = jp.map((e, i) => [
  e.kanji.join(RS),
  e.kana.join(RS),
  e.common ? '1' : '',
  e.senses.map((s) => [s.pos.join(','), s.glosses.join('; '), s.misc.join(',')].join(US)).join(RS),
  jpFreq[i] || '',
  jpSeen[i] || '',
].join(FS));
fs.writeFileSync(path.join(outDir, 'jp.txt'), jpLines.join('\n') + '\n');
fs.writeFileSync(
  path.join(outDir, 'jp.ex.txt'),
  jp.map((e) => e.examples.map((x) => x.join(US)).join(RS)).join('\n') + '\n',
);

const cnLines = cedict.map((e, i) => [
  e.trad,
  e.simp,
  e.py,
  e.glosses.join('; '),
  cnFreq[i] || '',
  cnSeen[i] || '',
].join(FS));
fs.writeFileSync(path.join(outDir, 'cn.txt'), cnLines.join('\n') + '\n');
fs.writeFileSync(
  path.join(outDir, 'cn.ex.txt'),
  cnExamples.map((ex) => ex.map((x) => x.join(US)).join(RS)).join('\n') + '\n',
);

const fmtLinks = (arr) => arr.map(([id, s]) => `${id}:${s.toFixed(3)}`).join(',');
fs.writeFileSync(path.join(outDir, 'jp2cn.txt'), jp2cn.map(fmtLinks).join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'cn2jp.txt'), cn2jp.map(fmtLinks).join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'jp2cn.han.txt'), jp2cnHan.map(fmtLinks).join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'cn2jp.han.txt'), cn2jpHan.map(fmtLinks).join('\n') + '\n');

// ------------------------------------------------------------ emit indexes

log('writing indexes...');

// Japanese: kanji forms, kana readings (as hiragana), and romaji.
const jpIdx = new Index();
jp.forEach((e, i) => {
  for (const k of e.kanji) jpIdx.add(k, i);
  for (const r of e.kana) {
    const hira = toHiragana(r);
    jpIdx.add(hira, i);
    const romaji = kanaToRomaji(r).replace(/'/g, '');
    jpIdx.add(romaji, i);
    // "~" marks the long-vowel-insensitive fallback keys so the page can rank
    // them below an exact spelling.
    const loose = looseRomaji(romaji);
    if (loose !== romaji) jpIdx.add(`~${loose}`, i);
  }
});
const nJp = jpIdx.write(path.join(outDir, 'jp.idx'));

// Chinese: traditional, simplified, toneless pinyin (run together and spaced),
// and numbered pinyin for people who type tones.
const cnIdx = new Index();
cedict.forEach((e, i) => {
  cnIdx.add(e.trad, i);
  if (e.simp !== e.trad) cnIdx.add(e.simp, i);
  const toneless = numberedToToneless(e.py);
  cnIdx.add(toneless.replace(/\s+/g, ''), i);
  cnIdx.add(toneless, i);
  cnIdx.add(normalizePinyin(e.py), i);
});
const nCn = cnIdx.write(path.join(outDir, 'cn.idx'));

// English. A key can match as a whole gloss ("eat" is all of 食べる's first
// gloss) or as one word inside a longer gloss ("eat" in "eat one's fill").
// Those are very different in quality, so they are stored separately.
const enIdx = new Map(); // key -> {pj, pc, wj, wc}
const addEn = (key, bucket, id) => {
  if (!key) return;
  let v = enIdx.get(key);
  if (!v) { v = { pj: [], pc: [], wj: [], wc: [] }; enIdx.set(key, v); }
  const arr = v[bucket];
  if (arr.length < 200 && arr[arr.length - 1] !== id) arr.push(id);
};
jpGlossKeys.forEach((keys, i) => {
  for (const k of keys) {
    addEn(k, 'pj', i);
    for (const w of glossWords(k)) if (w !== k) addEn(w, 'wj', i);
  }
});
cnGlossKeys.forEach((keys, i) => {
  for (const k of keys) {
    addEn(k, 'pc', i);
    for (const w of glossWords(k)) if (w !== k) addEn(w, 'wc', i);
  }
});
{
  const keys = [...enIdx.keys()].sort();
  const parts = [];
  for (const k of keys) {
    const v = enIdx.get(k);
    parts.push(k, '\t', packIds(v.pj), '|', packIds(v.pc), '|', packIds(v.wj), '|', packIds(v.wc), '\n');
  }
  fs.writeFileSync(path.join(outDir, 'en.idx'), parts.join(''));
  log(`  ${keys.length} English keys`);
}

fs.writeFileSync(
  path.join(outDir, 'tags.json'),
  JSON.stringify(jmTags),
);

// `core` is everything search needs; `extra` is fetched afterwards.
const core = ['tags.json', 'jp.txt', 'cn.txt', 'jp.idx', 'cn.idx', 'en.idx',
  'jp2cn.txt', 'cn2jp.txt', 'jp2cn.han.txt', 'cn2jp.han.txt'];
const extra = ['jp.ex.txt', 'cn.ex.txt'];
const files = [...core, ...extra];
const meta = {
  built: new Date().toISOString().slice(0, 10),
  counts: { jp: jp.length, cn: cedict.length, jpKeys: nJp, cnKeys: nCn },
  core,
  extra,
  files: Object.fromEntries(
    files.map((f) => [f, fs.statSync(path.join(outDir, f)).size]),
  ),
};
meta.totalBytes = Object.values(meta.files).reduce((a, b) => a + b, 0);
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const [f, n] of Object.entries(meta.files)) {
  log(`  ${f.padEnd(12)} ${(n / 1e6).toFixed(1)} MB`);
}
log(`  ${'total'.padEnd(12)} ${(meta.totalBytes / 1e6).toFixed(1)} MB`);
