#!/usr/bin/env node
// Drives worker.js through its real message interface against a running
// dev server, so the search paths exercised here are the ones the page uses.
//
//   node build/serve.mjs 8099 &
//   node build/test.mjs http://localhost:8099

const base = process.argv[2] || 'http://localhost:8099';

// Stand in for the worker globals before importing the module under test.
const inbox = [];
globalThis.postMessage = (msg) => inbox.push(msg);
globalThis.onmessage = null;
globalThis.onerror = null;

await import('../worker.js');

const send = (msg) => globalThis.onmessage({ data: msg });

function waitFor(type, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${type}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

let seq = 0;
async function search(query, mode, hideMinor = true, limit = 12) {
  const id = ++seq;
  send({ id, type: 'search', payload: { query, mode, limit, hideMinor } });
  const msg = await waitFor('result');
  if (msg.type === 'error') throw new Error(msg.error);
  return msg.payload;
}

const t0 = Date.now();
send({ type: 'load', payload: { base: `${base}/data` } });
await waitFor('ready');
console.log(`loaded core in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await waitFor('extras');
console.log(`loaded examples in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

let failures = 0;

/** Assert that `want` shows up in the head field of the first few results. */
async function expect(query, mode, want, { where = 'head', top = 5 } = {}) {
  const started = Date.now();
  const { results } = await search(query, mode);
  const ms = Date.now() - started;
  const heads = results.slice(0, top).map((r) => (
    r.kind === 'jp' ? (r.kanji[0] || r.kana[0]) : r.trad
  ));
  const linkHeads = results.slice(0, top).flatMap((r) => (r.links || []).map((l) => l.head));
  const pool = where === 'link' ? linkHeads : heads;
  const ok = pool.includes(want);
  if (!ok) failures++;
  const first = results[0];
  const detail = first
    ? `${heads.slice(0, 4).join(' ')}${where === 'link' ? ` | links: ${linkHeads.slice(0, 5).join(' ')}` : ''}`
    : '(no results)';
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(4)} ${String(query).padEnd(16)} want ${where} ${String(want).padEnd(6)} ` +
    `${String(ms + 'ms').padStart(6)}  ${detail}`,
  );
}

console.log('--- Japanese headword lookup ---');
await expect('食べる', 'jp', '食べる');
await expect('たべる', 'jp', '食べる');
await expect('taberu', 'jp', '食べる');
await expect('tabemashita', 'jp', '食べる');
await expect('食べました', 'jp', '食べる');
await expect('食べさせられた', 'jp', '食べる');
await expect('よかった', 'jp', '良い');
await expect('nihon', 'jp', '日本');
await expect('tookyoo', 'jp', '東京');
await expect('sinbun', 'jp', '新聞');   // kunrei-shiki input
await expect('shinbun', 'jp', '新聞');
await expect('tabelu', 'jp', '食べる');  // one typo

console.log('\n--- Chinese headword lookup ---');
await expect('你好', 'cn', '你好');
await expect('nihao', 'cn', '你好');
await expect('ni3hao3', 'cn', '你好');
await expect('nǐ hǎo', 'cn', '你好');
await expect('ni hao', 'cn', '你好');
await expect('你好', 'cn', '你好');
await expect('图书馆', 'cn', '圖書館');  // simplified input, traditional head
await expect('tushuguan', 'cn', '圖書館');

console.log('\n--- English lookup ---');
await expect('eat', 'jp', '食べる');
await expect('library', 'cn', '圖書館');
await expect('to eat', 'jp', '食べる');
await expect('newspaper', 'jp', '新聞');

console.log('\n--- cross-language pivot ---');
await expect('食べる', 'jp', '吃', { where: 'link' });
await expect('吃', 'cn', '食べる', { where: 'link' });
await expect('新聞', 'jp', '報紙', { where: 'link' });

console.log('\n--- all ---');
await expect('nihon', 'all', '日本');
await expect('你好', 'all', '你好');
await expect('eat', 'all', '食べる');

console.log('\n--- low-scoring entries are filtered ---');
{
  const heads = (r) => r.results.map((x) => (x.kind === 'jp' ? (x.kanji[0] || x.kana[0]) : x.trad));
  const readings = (r) => r.results.flatMap((x) => (x.kind === 'jp' ? x.kana : []));

  // Wide limit: the point is whether the entry is reachable at all, not where
  // it ranks once the filter is off.
  const on = await search('shit', 'jp', true, 400);
  const off = await search('shit', 'jp', false, 400);
  const gone = !readings(on).includes('ばば') && readings(off).includes('ばば');
  if (!gone) failures++;
  console.log(`${gone ? 'ok  ' : 'FAIL'} ばば dropped from "shit" when filtering (${on.hidden} hidden)`);
  console.log(`     on:  ${heads(on).slice(0, 6).join(' ')}`);
  console.log(`     off: ${heads(off).slice(0, 6).join(' ')}`);

  const kept = heads(on).includes('糞');
  if (!kept) failures++;
  console.log(`${kept ? 'ok  ' : 'FAIL'} the common word 糞 (くそ) survives the filter`);

  // Looking a word up by name must always find it, however obscure.
  const direct = await search('ばば', 'jp');
  const found = readings(direct).includes('ばば');
  if (!found) failures++;
  console.log(`${found ? 'ok  ' : 'FAIL'} exact lookup of ばば still returns it`);
}

console.log('\n--- the matched reading decides ---');
{
  // 寝 lists ね first and しん third, and its corpus frequency is ~50x 新's
  // (寝 is a substring of 寝る, 寝室 ...). An entry whose *main* reading is the
  // query must still win. シン carries a literal English gloss "shin", which
  // must not promote it either.
  for (const q of ['shin', '\u3057\u3093']) {
    const r = await search(q, 'jp');
    const heads = r.results.map((x) => x.kanji[0] || x.kana[0]);
    const ok = heads[0] === '\u65b0';
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} "${q}" ranks 新 first: ${heads.slice(0, 5).join(' ')}`);

    const ne = heads.indexOf('\u5bdd');
    const shin = heads.indexOf('\u65b0');
    const okNe = ne === -1 || ne > shin;
    if (!okNe) failures++;
    console.log(`${okNe ? 'ok  ' : 'FAIL'} 寝 (secondary reading) ranks below 新`);
  }
}

console.log('\n--- hanzi match ranks above the English heuristic ---');
{
  const han = async (q) => {
    const r = await search(q, 'jp');
    const e = r.results[0];
    return {
      head: e && (e.kanji[0] || e.kana[0]),
      hanzi: (e?.hanziLinks || []).map((l) => l.head),
      eng: (e?.links || []).map((l) => l.head),
    };
  };

  for (const [q, want] of [['\u65b0\u805e', '\u65b0\u805e'], ['\u96fb\u8a71', '\u96fb\u8a71']]) {
    const r = await han(q);
    const ok = r.hanzi[0] === want;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${q} hanzi match -> ${r.hanzi.join(' ') || '(none)'}`);
  }

  // Shinjitai: 図 is the modern form of 圖, so this only works via Unihan.
  const lib = await han('\u56f3\u66f8\u9928');
  const okLib = lib.hanzi[0] === '\u5716\u66f8\u9928';
  if (!okLib) failures++;
  console.log(`${okLib ? 'ok  ' : 'FAIL'} shinjitai 図書館 -> ${lib.hanzi.join(' ') || '(none)'}`);

  // A kana verb has no written form to match; the heuristic must still fire.
  const eat = await han('\u98df\u3079\u308b');
  const okEat = eat.hanzi.length === 0 && eat.eng.includes('\u5403');
  if (!okEat) failures++;
  console.log(`${okEat ? 'ok  ' : 'FAIL'} 食べる falls back to eng heuristic -> ${eat.eng.slice(0, 3).join(' ')}`);

  // The two groups must not repeat the same entry.
  const overlap = ['\u65b0\u805e', '\u96fb\u8a71', '\u56f3\u66f8\u9928'];
  let clean = true;
  for (const q of overlap) {
    const r = await han(q);
    if (r.hanzi.some((h) => r.eng.includes(h))) clean = false;
  }
  if (!clean) failures++;
  console.log(`${clean ? 'ok  ' : 'FAIL'} an entry never appears in both link groups`);
}

console.log('\n--- JP <-> CN mode ---');
{
  // Only entries with a counterpart on the other side belong in this mode.
  const r = await search('食べる', 'jpcn');
  const jpHeads = r.results.filter((x) => x.kind === 'jp').map((x) => x.kanji[0] || x.kana[0]);
  const linked = r.results.every((x) => x.links.length > 0);
  const hasJp = jpHeads.includes('食べる');
  if (!hasJp) failures++;
  console.log(`${hasJp ? 'ok  ' : 'FAIL'} 食べる present in JP<->CN: ${jpHeads.slice(0, 4).join(' ')}`);
  if (!linked) failures++;
  console.log(`${linked ? 'ok  ' : 'FAIL'} every result carries a cross-language link`);
  const chips = r.results[0]?.links.map((l) => l.head) || [];
  console.log(`     links on first card: ${chips.slice(0, 5).join(' ')}`);

  const r2 = await search('\u5403', 'jpcn');
  const both = new Set(r2.results.map((x) => x.kind));
  const ok2 = r2.results.length > 0;
  if (!ok2) failures++;
  console.log(`${ok2 ? 'ok  ' : 'FAIL'} Chinese input works too (kinds: ${[...both].join(',')})`);
}

console.log('\n--- single-language modes bridge through the pivot ---');
{
  const r = await search('吃', 'jp');
  const heads = r.results.map((x) => x.kanji[0] || x.kana[0]);
  const ok = heads.some((h) => ['食べる', '食う', '喫する'].includes(h));
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} Chinese input in JP mode returns Japanese: ${heads.slice(0, 5).join(' ')}`);

  const r2 = await search('食べる', 'cn');
  const heads2 = r2.results.map((x) => x.trad);
  const ok2 = heads2.includes('吃');
  if (!ok2) failures++;
  console.log(`${ok2 ? 'ok  ' : 'FAIL'} Japanese input in CN mode returns Chinese: ${heads2.slice(0, 5).join(' ')}`);
}

console.log('\n--- examples present ---');
{
  const { results } = await search('食べる', 'jp');
  const withEx = results.filter((r) => r.examples.length);
  console.log(`${withEx.length ? 'ok  ' : 'FAIL'} ${withEx.length}/${results.length} JP results carry examples`);
  if (!withEx.length) failures++;
  else console.log(`     e.g. ${withEx[0].examples[0][0]} / ${withEx[0].examples[0][1]}`);

  const cn = await search('你好', 'cn');
  const cnEx = cn.results.filter((r) => r.examples.length);
  console.log(`${cnEx.length ? 'ok  ' : 'FAIL'} ${cnEx.length}/${cn.results.length} CN results carry examples`);
  if (!cnEx.length) failures++;
  else console.log(`     e.g. ${cnEx[0].examples[0][0]} / ${cnEx[0].examples[0][1]}`);
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
