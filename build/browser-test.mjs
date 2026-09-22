#!/usr/bin/env node
// Drives the real page in headless Chrome over the DevTools protocol, so the
// module worker, the service worker and the rendering all get exercised.
//
//   node build/serve.mjs 8099 &
//   node build/browser-test.mjs http://localhost:8099

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

const base = process.argv[2] || 'http://localhost:8099';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const PROFILE = path.join(process.env.TMPDIR || '/tmp', 'dict-cdp-profile');

// Always start from a cold profile: a warm service worker cache would hide
// exactly the first-load bugs this test exists to catch.
fs.rmSync(PROFILE, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--disable-gpu',
  `--user-data-dir=${PROFILE}`,
  'about:blank',
], { stdio: 'ignore' });

const cleanup = () => {
  try { chrome.kill(); } catch { /* already gone */ }
  // Chrome may still be flushing the profile as we exit; the next run wipes it
  // anyway, so this is best-effort.
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* next run */ }
};
process.on('exit', cleanup);

/** Wait for the debugging endpoint to come up. */
async function targets() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  throw new Error('chrome did not start');
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('cdp connect failed'));
});

let msgId = 0;
const waiting = new Map();
const consoleErrors = [];

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails.exception?.description
      || msg.params.exceptionDetails.text);
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    consoleErrors.push(msg.params.entry.text);
  }
};

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

console.log(`opening ${base}/ ...`);
await send('Page.navigate', { url: `${base}/` });
await sleep(500);

// The page hides the loading panel once the worker reports ready.
const t0 = Date.now();
let loaded = false;
for (let i = 0; i < 300; i++) {
  loaded = await evaluate(`document.getElementById('loading').classList.contains('hidden')`);
  if (loaded) break;
  await sleep(200);
}
if (!loaded) {
  console.error('FAIL: data never finished loading');
  const note = await evaluate(`document.getElementById('loadnote').textContent`);
  console.error(`  last progress: ${note}`);
  console.error(consoleErrors.join('\n'));
  process.exit(1);
}
console.log(`ok   data ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

let failures = 0;

/** Type into the real input, wait for the debounce, read the rendered DOM. */
async function query(text, mode) {
  // Set the value before switching mode (the mode button also triggers a run),
  // and clear what is on screen so the poll below cannot read stale cards.
  await evaluate(`(() => {
    const q = document.getElementById('q');
    q.value = ${JSON.stringify(text)};
    document.querySelector('[data-mode="${mode}"]').click();
    document.getElementById('list').replaceChildren();
    document.getElementById('status').textContent = '';
    q.dispatchEvent(new Event('input'));
  })()`);
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const state = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#list .row')];
      const detail = document.querySelector('#detail .card');
      return {
        status: document.getElementById('status').textContent,
        heads: rows.map(r => r.querySelector('.row-word')?.textContent),
        readings: [detail?.querySelector('.reading')?.textContent],
        examples: [detail ? detail.querySelectorAll('.ex').length : 0],
        links: [[...(detail?.querySelectorAll('.chip-head') || [])].map(e => e.textContent)],
        detailHead: detail?.querySelector('.headword')?.textContent,
      };
    })()`);
    if (state.heads.length || /No matches/.test(state.status)) return state;
  }
  return { heads: [], status: 'timeout', examples: [], links: [] };
}

const enterKey = () => evaluate(`(() => { const q=document.getElementById('q');
  q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);

/** Type a query and commit it with Enter, letting each run settle first. */
async function commit(text, mode) {
  await query(text, mode);
  await sleep(700);   // let the tab-click run and the input run both finish
  await enterKey();
  await sleep(700);
}

/** Reload the page so the history stack starts empty for a navigation test. */
async function freshPage() {
  await send('Page.navigate', { url: `${base}/` });
  await sleep(900);
  for (let i = 0; i < 200; i++) {
    if (await evaluate(`document.getElementById('loading').classList.contains('hidden')`).catch(() => false)) break;
    await sleep(200);
  }
  await sleep(400);
}

async function check(label, text, mode, predicate) {
  const state = await query(text, mode);
  const ok = predicate(state);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(34)} ${state.heads.slice(0, 4).join(' ')}`);
  return state;
}

console.log('\n--- rendering ---');
const jp = await check('JP→EN 食べる renders', '食べる', 'jp', (s) => s.heads[0] === '食べる');
console.log(`     reading: ${jp.readings[0]}`);

// Example sentences load after the core data, and the page redraws when they
// arrive, so give that a moment rather than reading the first paint.
let exCount = 0;
for (let i = 0; i < 100; i++) {
  exCount = await evaluate(`document.querySelectorAll('#detail .ex').length`);
  if (exCount) break;
  await sleep(200);
}
if (!exCount) { failures++; console.log('FAIL no example sentences rendered'); }
else console.log(`ok   example sentences appear once loaded (${exCount})`);

await check('romaji tabemashita', 'tabemashita', 'jp', (s) => s.heads[0] === '食べる');
await check('pinyin nihao', 'nihao', 'cn', (s) => s.heads[0] === '你好');
await check('EN→JP eat', 'eat', 'jp', (s) => s.heads.includes('食べる'));

const pivot = await check('JP→CN 食べる links', '食べる', 'jp', (s) => s.links[0]?.includes('吃'));
console.log(`     links: ${pivot.links[0]?.slice(0, 5).join(' ')}`);

const all = await check('all 你好', '你好', 'all', (s) => s.heads.includes('你好'));
console.log(`     status: ${all.status}`);

console.log('\n--- tab cycles modes ---');
{
  const MODE_ORDER = ['all', 'jp', 'cn', 'jpcn'];
  const tab = (shift) => evaluate(`(() => {
    const q = document.getElementById('q');
    q.focus();
    const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: ${!!shift}, bubbles: true, cancelable: true });
    const notPrevented = q.dispatchEvent(e);
    return {
      defaultPrevented: !notPrevented,
      mode: document.querySelector('.modes [aria-selected="true"]')?.dataset.mode,
      focused: document.activeElement?.id,
    };
  })()`);

  await query('食べる', 'all');
  const seen = [];
  let prevented = true;
  let keptFocus = true;
  for (let i = 0; i < MODE_ORDER.length; i++) {
    const s = await tab(false);
    seen.push(s.mode);
    if (!s.defaultPrevented) prevented = false;
    if (s.focused !== 'q') keptFocus = false;
    await sleep(150);
  }
  const forward = seen.join(' ');
  const wantForward = [...MODE_ORDER.slice(1), MODE_ORDER[0]].join(' ');
  const okForward = forward === wantForward;
  if (!okForward) failures++;
  console.log(`${okForward ? 'ok  ' : 'FAIL'} Tab cycles forward: ${forward}`);

  if (!prevented) { failures++; console.log('FAIL Tab still moved focus (not preventDefault-ed)'); }
  else console.log('ok   Tab does not move focus out of the search box');
  if (!keptFocus) { failures++; console.log('FAIL focus left the search box'); }

  const back = await tab(true);
  const okBack = back.mode === MODE_ORDER[MODE_ORDER.length - 1];
  if (!okBack) failures++;
  console.log(`${okBack ? 'ok  ' : 'FAIL'} Shift+Tab goes back: ${back.mode}`);

  // Switching mode must re-run the query, not just repaint the chips.
  await sleep(600);
  const st = await evaluate(`document.getElementById('status').textContent`);
  const okRan = /result|matches/.test(st);
  if (!okRan) failures++;
  console.log(`${okRan ? 'ok  ' : 'FAIL'} query re-runs on mode change: ${st}`);
}

console.log('\n--- copy buttons ---');
{
  await query('食べる', 'jp');
  await sleep(600); // let any debounced re-render settle before clicking
  // Headless Chrome has no clipboard permission, so assert on what the button
  // hands to the clipboard rather than on the system clipboard itself.
  await evaluate(`(() => {
    window.__copied = null;
    navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); };
  })()`);
  const labels = await evaluate(`[...document.querySelectorAll('#detail .copy .copy-label')].map(e => e.textContent)`);
  const hasButtons = labels.length >= 2;
  if (!hasButtons) failures++;
  console.log(`${hasButtons ? 'ok  ' : 'FAIL'} copy buttons render: ${labels.slice(0, 4).join(' ')}`);

  await evaluate(`document.querySelector('#detail .copy').click()`);
  await sleep(300);
  const copied = await evaluate(`window.__copied`);
  const okCopy = copied === '食べる';
  if (!okCopy) failures++;
  console.log(`${okCopy ? 'ok  ' : 'FAIL'} copies the headword: ${JSON.stringify(copied)}`);

  const feedback = await evaluate(`document.querySelector('#detail .copy .copy-label').textContent`);
  const okFeedback = feedback === 'copied';
  if (!okFeedback) failures++;
  console.log(`${okFeedback ? 'ok  ' : 'FAIL'} button confirms: ${feedback}`);
}

console.log('\n--- clear button ---');
{
  await query('食べる', 'jp');
  const shown = await evaluate(`!document.getElementById('clear').classList.contains('hidden')`);
  if (!shown) { failures++; console.log('FAIL clear button not visible with text'); }
  else console.log('ok   clear button visible while there is text');

  await evaluate(`document.getElementById('clear').click()`);
  await sleep(400);
  const state = await evaluate(`({
    value: document.getElementById('q').value,
    cards: document.querySelectorAll('#list .row').length,
    hidden: document.getElementById('clear').classList.contains('hidden'),
  })`);
  const okClear = state.value === '' && state.cards === 0 && state.hidden;
  if (!okClear) failures++;
  console.log(`${okClear ? 'ok  ' : 'FAIL'} clearing empties input and results: ${JSON.stringify(state)}`);
}

console.log('\n--- hide low scoring ---');
{
  const count = async () => {
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      const n = await evaluate(`document.querySelectorAll('#list .row').length`);
      if (n) return n;
    }
    return 0;
  };
  await query('shit', 'jp');
  const on = await count();
  const checked = await evaluate(`document.getElementById('minor').checked`);
  if (!checked) { failures++; console.log('FAIL checkbox is not on by default'); }
  else console.log('ok   "Hide low scoring" is a checkbox, on by default');

  const status = await evaluate(`document.getElementById('status').textContent`);
  const reports = /hidden/.test(status);
  if (!reports) failures++;
  console.log(`${reports ? 'ok  ' : 'FAIL'} status reports what was hidden: ${status}`);

  await evaluate(`(() => { const c = document.getElementById('minor'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);
  await sleep(900);
  // Both lists hit the 25-result cap, so compare what the status reports
  // rather than the card count.
  const offStatus = await evaluate(`document.getElementById('status').textContent`);
  const grew = !/hidden/.test(offStatus);
  if (!grew) failures++;
  console.log(`${grew ? 'ok  ' : 'FAIL'} unchecking stops hiding (${on} cards): ${offStatus}`);
  await evaluate(`(() => { const c = document.getElementById('minor'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
  await sleep(500);
}

console.log('\n--- link chips navigate ---');
{
  await query('食べる', 'jp');
  await evaluate(`document.querySelector('#detail .chip').click()`);
  await sleep(1200);
  const head = await evaluate(`document.querySelector('#detail .headword')?.textContent`);
  const ok = head === '吃';
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} clicking a link chip opens that entry: ${head}`);
}

console.log('\n--- list + detail ---');
{
  const st = await query('\u98df\u3079\u308b', 'jp');
  const shape = await evaluate(`(() => {
    const rows = document.querySelectorAll('#list .row').length;
    const sel = document.querySelector('#list .row[aria-selected="true"]');
    const detail = document.querySelector('#detail .card');
    const row = document.querySelector('#list .row');
    const gloss = row?.querySelector('.row-gloss');
    return {
      rows, hasSelection: !!sel, hasDetail: !!detail,
      rowHeight: Math.round(row.getBoundingClientRect().height),
      glossClipped: gloss ? getComputedStyle(gloss).textOverflow : null,
      detailHead: detail?.querySelector('.headword')?.textContent,
    };
  })()`);
  const ok = shape.rows > 0 && shape.hasSelection && shape.hasDetail
    && shape.detailHead === '\u98df\u3079\u308b';
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} list shows ${shape.rows} rows, first is selected, detail = ${shape.detailHead}`);
  const compact = shape.rowHeight <= 70 && shape.glossClipped === 'ellipsis';
  if (!compact) failures++;
  console.log(`${compact ? 'ok  ' : 'FAIL'} rows are compact (${shape.rowHeight}px, gloss ${shape.glossClipped})`);

  // Clicking a different row swaps the detail pane (needs a multi-row query).
  await query('shin', 'jp');
  await sleep(400);
  const firstHead = await evaluate(`document.querySelector('#detail .headword')?.textContent`);
  await evaluate(`document.querySelectorAll('#list .row')[1]?.click()`);
  await sleep(400);
  const swapped = await evaluate(`({
    head: document.querySelector('#detail .headword')?.textContent,
    selectedIndex: [...document.querySelectorAll('#list .row')].findIndex(r => r.getAttribute('aria-selected') === 'true'),
  })`);
  const okSwap = swapped.selectedIndex === 1 && swapped.head !== firstHead;
  if (!okSwap) failures++;
  console.log(`${okSwap ? 'ok  ' : 'FAIL'} clicking row 2 moves the detail pane: ${swapped.head}`);
}

console.log('\n--- history navigation ---');
{
  // Start from a fresh document so the history stack is ours alone — going
  // back past its first entry would navigate away from the page entirely.
  await freshPage();
  await commit('\u98df\u3079\u308b', 'jp');
  await commit('\u65b0\u805e', 'jp');
  const before = await evaluate(`document.getElementById('q').value`);
  const depth = await evaluate(`history.length`);
  await evaluate(`history.back()`);
  await sleep(900);
  const after = await evaluate(`({ q: document.getElementById('q').value, head: document.querySelector('#detail .headword')?.textContent })`);
  const okBack = before === '\u65b0\u805e' && after.q === '\u98df\u3079\u308b';
  if (!okBack) failures++;
  console.log(`${okBack ? 'ok  ' : 'FAIL'} Back returns to the previous word: ${before} -> ${after.q} (${after.head}) [stack ${depth}]`);

  await evaluate(`history.forward()`);
  await sleep(900);
  const fwd = await evaluate(`document.getElementById('q').value`);
  const okFwd = fwd === '\u65b0\u805e';
  if (!okFwd) failures++;
  console.log(`${okFwd ? 'ok  ' : 'FAIL'} Forward returns again: ${fwd}`);

  // Typing must not leave a history entry per keystroke.
  const len0 = await evaluate(`history.length`);
  for (const t of ['t','ta','tab','tabe']) {
    await evaluate(`(() => { const q=document.getElementById('q'); q.value=${JSON.stringify('x')}; })()`);
    await evaluate(`(() => { const q=document.getElementById('q'); q.value=${JSON.stringify(t)}; q.dispatchEvent(new Event('input')); })()`);
    await sleep(260);
  }
  await sleep(700);
  const len1 = await evaluate(`history.length`);
  const okTyping = len1 - len0 <= 2;
  if (!okTyping) failures++;
  console.log(`${okTyping ? 'ok  ' : 'FAIL'} typing 4 characters added ${len1 - len0} history entries`);
}

console.log('\n--- selection survives Back ---');
{
  // Pick a non-first row, dive into a linked word, then come back: the row you
  // were on must be selected again, not just the query restored.
  await freshPage();
  await commit('shin', 'jp');
  await evaluate(`document.querySelectorAll('#list .row')[2].click()`);
  await sleep(500);
  const picked = await evaluate(`({
    head: document.querySelector('#detail .headword')?.textContent,
    index: [...document.querySelectorAll('#list .row')].findIndex(r => r.getAttribute('aria-selected') === 'true'),
  })`);

  await evaluate(`document.querySelector('#detail .chip')?.click()`);
  await sleep(1200);
  const dived = await evaluate(`document.querySelector('#detail .headword')?.textContent`);

  await evaluate(`history.back()`);
  await sleep(1400);
  const back = await evaluate(`({
    q: document.getElementById('q').value,
    head: document.querySelector('#detail .headword')?.textContent,
    index: [...document.querySelectorAll('#list .row')].findIndex(r => r.getAttribute('aria-selected') === 'true'),
  })`);
  const ok = back.q === 'shin' && back.index === picked.index && back.head === picked.head;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} row ${picked.index} (${picked.head}) -> dived to ${dived} -> Back restored row ${back.index} (${back.head})`);
}

console.log('\n--- the URL carries the selection ---');
{
  await query('doumo', 'all');
  await sleep(600);
  await evaluate(`document.querySelectorAll('#list .row')[2].click()`);
  await sleep(500);
  const picked = await evaluate(`({
    hash: location.hash,
    head: document.querySelector('#detail .headword')?.textContent,
    index: [...document.querySelectorAll('#list .row')].findIndex(r => r.getAttribute('aria-selected') === 'true'),
  })`);
  const inUrl = /\/(jp|cn):\d+$/.test(picked.hash);
  if (!inUrl) failures++;
  console.log(`${inUrl ? 'ok  ' : 'FAIL'} selecting a row writes it to the URL: ${picked.hash}`);

  // A hard reload throws away history.state, so the URL has to be enough.
  await send('Page.navigate', { url: `${base}/${picked.hash}` });
  await sleep(1200);
  for (let i = 0; i < 200; i++) {
    if (await evaluate(`document.getElementById('loading').classList.contains('hidden')`).catch(() => false)) break;
    await sleep(200);
  }
  await sleep(1200);
  const after = await evaluate(`({
    q: document.getElementById('q').value,
    head: document.querySelector('#detail .headword')?.textContent,
    index: [...document.querySelectorAll('#list .row')].findIndex(r => r.getAttribute('aria-selected') === 'true'),
  })`);
  const ok = after.q === 'doumo' && after.index === picked.index && after.head === picked.head;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} reloading that URL restores row ${after.index} (${after.head}), was row ${picked.index} (${picked.head})`);
}

console.log('\n--- redraws leave the selection alone ---');
{
  // Reload cold so the example-sentence file arrives *after* the first render:
  // that background redraw used to reset the selection back to row 0 and
  // rewrite the URL under the reader.
  await evaluate(`localStorage.setItem('dict.recent','[]')`);
  await query('doumo', 'all');
  await sleep(600);
  await evaluate(`document.querySelectorAll('#list .row')[1].click()`);
  await sleep(500);
  const before = await evaluate(`({ hash: location.hash,
    index: [...document.querySelectorAll('#list .row')].findIndex(r => r.getAttribute('aria-selected') === 'true') })`);

  await send('Page.navigate', { url: `${base}/${before.hash}` });
  await sleep(1000);
  for (let i = 0; i < 200; i++) {
    if (await evaluate(`document.getElementById('loading').classList.contains('hidden')`).catch(() => false)) break;
    await sleep(200);
  }
  // Wait past the point where examples land and trigger the redraw.
  await sleep(4000);
  const after = await evaluate(`({ hash: location.hash,
    index: [...document.querySelectorAll('#list .row')].findIndex(r => r.getAttribute('aria-selected') === 'true'),
    head: document.querySelector('#detail .headword')?.textContent,
    examples: document.querySelectorAll('#detail .ex').length })`);
  const held = after.hash === before.hash && after.index === before.index;
  if (!held) failures++;
  console.log(`${held ? 'ok  ' : 'FAIL'} after reload + examples loading: ${before.hash} -> ${after.hash}, row ${before.index} -> ${after.index} (${after.head})`);

  // The saved-lookup list must not be churned by those redraws either.
  const recent = await evaluate(`JSON.parse(localStorage.getItem('dict.recent')||'[]').map(x=>x.head)`);
  const once = recent.length === 1;
  if (!once) failures++;
  console.log(`${once ? 'ok  ' : 'FAIL'} the redraw did not re-log the word (${recent.length} entries: ${recent.join(' ')})`);
}

console.log('\n--- "/" focuses the search box ---');
{
  await evaluate(`document.getElementById('q').blur(); document.body.focus();`);
  await sleep(150);
  const before = await evaluate(`document.activeElement?.id || document.activeElement?.tagName`);
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }))`);
  await sleep(200);
  const after = await evaluate(`document.activeElement?.id`);
  const ok = after === 'q';
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} "/" moves focus ${before} -> ${after}`);

  // Typing "/" inside the box must still insert a slash.
  const notStolen = await evaluate(`(() => {
    const q = document.getElementById('q');
    q.focus();
    const ev = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    q.dispatchEvent(ev);
    return !ev.defaultPrevented;
  })()`);
  if (!notStolen) failures++;
  console.log(`${notStolen ? 'ok  ' : 'FAIL'} "/" typed inside the box is not hijacked`);
}

console.log('\n--- list fills the column ---');
{
  await query('doumo', 'all');
  await sleep(500);
  const box = await evaluate(`(() => {
    const l = document.getElementById('list').getBoundingClientRect();
    const d = document.getElementById('detail').getBoundingClientRect();
    return { listBottom: Math.round(l.bottom), detailBottom: Math.round(d.bottom),
             viewportH: innerHeight, rows: document.querySelectorAll('#list .row').length,
             pageScrolls: document.documentElement.scrollHeight > innerHeight + 1 };
  })()`);
  const fits = box.listBottom <= box.viewportH && box.viewportH - box.listBottom < 40;
  if (!fits) failures++;
  console.log(`${fits ? 'ok  ' : 'FAIL'} list runs to the bottom without overshooting (bottom ${box.listBottom} of ${box.viewportH}, ${box.rows} rows)`);
  const aligned = Math.abs(box.listBottom - box.detailBottom) <= 2;
  if (!aligned) failures++;
  console.log(`${aligned ? 'ok  ' : 'FAIL'} list and detail end level (${box.listBottom} vs ${box.detailBottom})`);
  if (box.pageScrolls) { failures++; console.log('FAIL the page itself scrolls; panes should scroll instead'); }
  else console.log('ok   the page does not scroll; each pane scrolls on its own');
}

console.log('\n--- saved lookups ---');
{
  await evaluate(`localStorage.removeItem('dict.recent')`);
  await query('\u98df\u3079\u308b', 'jp');
  await sleep(400);
  await query('\u65b0\u805e', 'jp');
  await sleep(400);
  const stored = await evaluate(`JSON.parse(localStorage.getItem('dict.recent')||'[]').map(x=>x.head)`);
  const okStored = stored.includes('\u98df\u3079\u308b') && stored.includes('\u65b0\u805e') && stored[0] === '\u65b0\u805e';
  if (!okStored) failures++;
  console.log(`${okStored ? 'ok  ' : 'FAIL'} lookups are stored newest first: ${stored.slice(0,4).join(' ')}`);

  await evaluate(`document.getElementById('histBtn').click()`);
  await sleep(500);
  const panel = await evaluate(`({
    open: !document.getElementById('recent').classList.contains('hidden'),
    rows: document.querySelectorAll('#recentList .row').length,
    first: document.querySelector('#recentList .row-word')?.textContent,
  })`);
  const okPanel = panel.open && panel.rows >= 2 && panel.first === '\u65b0\u805e';
  if (!okPanel) failures++;
  console.log(`${okPanel ? 'ok  ' : 'FAIL'} history panel lists ${panel.rows}, newest ${panel.first}`);

  // Clicking an entry in history reopens it.
  await evaluate(`document.querySelectorAll('#recentList .row')[1].click()`);
  await sleep(1000);
  const reopened = await evaluate(`document.querySelector('#detail .headword')?.textContent`);
  const okReopen = reopened === '\u98df\u3079\u308b';
  if (!okReopen) failures++;
  console.log(`${okReopen ? 'ok  ' : 'FAIL'} clicking a history row reopens it: ${reopened}`);

  // Survives a reload.
  await send('Page.navigate', { url: `${base}/` });
  await sleep(1200);
  for (let i = 0; i < 200; i++) {
    if (await evaluate(`document.getElementById('loading').classList.contains('hidden')`).catch(() => false)) break;
    await sleep(200);
  }
  const persisted = await evaluate(`JSON.parse(localStorage.getItem('dict.recent')||'[]').length`);
  const okPersist = persisted >= 2;
  if (!okPersist) failures++;
  console.log(`${okPersist ? 'ok  ' : 'FAIL'} history survives a reload (${persisted} entries)`);

  await evaluate(`document.getElementById('histBtn').click()`);
  await sleep(300);
  await evaluate(`document.getElementById('clearHist').click()`);
  await sleep(300);
  const cleared = await evaluate(`JSON.parse(localStorage.getItem('dict.recent')||'[]').length`);
  if (cleared !== 0) failures++;
  console.log(`${cleared === 0 ? 'ok  ' : 'FAIL'} Clear empties it (${cleared})`);
  await evaluate(`document.getElementById('histBtn').click()`);
  await sleep(200);
}

console.log('\n--- history panel has one scroller ---');
{
  await query('doumo', 'all');
  await sleep(400);
  for (const w of ['shin', 'eat', 'nihao', 'taberu']) { await query(w, 'all'); await sleep(350); }
  await evaluate(`document.getElementById('histBtn').click()`);
  await sleep(500);
  const scrollers = await evaluate(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('#recent, #recent *')) {
      const cs = getComputedStyle(el);
      const scrolls = /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
      if (scrolls) out.push(el.id || el.className);
    }
    return out;
  })()`);
  const one = scrollers.length <= 1;
  if (!one) failures++;
  console.log(`${one ? 'ok  ' : 'FAIL'} history panel scrollers: [${scrollers.join(', ')}]`);
  await evaluate(`document.getElementById('histBtn').click()`);
  await sleep(200);
}

console.log('\n--- back / forward buttons ---');
{
  await freshPage();
  await commit('doumo', 'all');
  await commit('nihao', 'all');
  await evaluate(`document.getElementById('back').click()`);
  await sleep(1000);
  const back = await evaluate(`document.getElementById('q').value`);
  await evaluate(`document.getElementById('fwd').click()`);
  await sleep(1000);
  const fwd = await evaluate(`document.getElementById('q').value`);
  const ok = back === 'doumo' && fwd === 'nihao';
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} arrows navigate: back -> ${back}, forward -> ${fwd}`);
}

console.log('\n--- controls are one size ---');
{
  const sizes = await evaluate(`(() => {
    const h = (s) => Math.round(document.querySelector(s).getBoundingClientRect().height);
    return { tab: h('.modes button'), toggle: h('.toggle'), hist: h('#histBtn'), arrow: h('#back') };
  })()`);
  const vals = Object.values(sizes);
  const ok = Math.max(...vals) - Math.min(...vals) <= 1;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} heights match: ${JSON.stringify(sizes)}`);
}

console.log('\n--- hanzi hover ---');
{
  await query('\u56f3\u66f8\u9928', 'jp');
  await sleep(700);
  const spans = await evaluate(`[...document.querySelectorAll('#detail .headword .han')].map(e => e.dataset.ch)`);
  const split = spans.join('') === '\u56f3\u66f8\u9928';
  if (!split) failures++;
  console.log(`${split ? 'ok  ' : 'FAIL'} headword split into characters: ${spans.join(' ')}`);

  await evaluate(`document.querySelectorAll('#detail .headword .han')[1]
    .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
  await sleep(700);
  const popover = await evaluate(`({
    shown: !document.querySelector('.tip').classList.contains('hidden'),
    char: document.querySelector('.tip-char')?.textContent,
    reading: document.querySelector('.tip-reading')?.textContent,
    gloss: document.querySelector('.tip-gloss')?.textContent?.slice(0, 40),
  })`);
  const ok = popover.shown && popover.reading && popover.char?.startsWith('\u66f8');
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} hovering 書 shows ${popover.char} ${popover.reading} — ${popover.gloss}`);

  await evaluate(`document.querySelectorAll('#detail .headword .han')[1].click()`);
  await sleep(1200);
  const opened = await evaluate(`({
    head: document.querySelector('#detail .headword')?.textContent,
    hash: location.hash,
  })`);
  const okOpen = opened.head === '\u66f8' && /\/cn:\d+$/.test(opened.hash);
  if (!okOpen) failures++;
  console.log(`${okOpen ? 'ok  ' : 'FAIL'} clicking it opens that character: ${opened.head} ${opened.hash}`);

  // Examples are made of characters too.
  await query('\u4f60\u597d', 'cn');
  await sleep(900);
  const inExamples = await evaluate(`document.querySelectorAll('#detail .ex-src .han').length`);
  if (!inExamples) failures++;
  console.log(`${inExamples ? 'ok  ' : 'FAIL'} example sentences are hoverable too (${inExamples} characters)`);
}

console.log('\n--- offline ---');
{
  const reg = await evaluate(`navigator.serviceWorker.getRegistration().then(r => !!r)`);
  if (!reg) { failures++; console.log('FAIL service worker not registered'); }
  else console.log('ok   service worker registered');

  await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
  // Give the data cache a moment to fill from the requests already made.
  await sleep(1500);
  const cached = await evaluate(`(async () => {
    const names = await caches.keys();
    let n = 0;
    for (const name of names) n += (await (await caches.open(name)).keys()).length;
    return { names, n };
  })()`);
  console.log(`     caches: ${cached.names.join(', ')} (${cached.n} entries)`);
  if (cached.n < 10) { failures++; console.log('FAIL too few cached responses'); }
  else console.log('ok   shell and data cached');

  // Cut the network at the browser and reload: this is the real offline path.
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await send('Page.navigate', { url: `${base}/` });
  await sleep(1000);
  let offlineReady = false;
  for (let i = 0; i < 150; i++) {
    offlineReady = await evaluate(`document.getElementById('loading').classList.contains('hidden')`)
      .catch(() => false);
    if (offlineReady) break;
    await sleep(200);
  }
  if (!offlineReady) { failures++; console.log('FAIL page did not load offline'); }
  else {
    const s = await query('食べる', 'jp');
    const ok = s.heads[0] === '食べる';
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} search works with the network off: ${s.heads[0]}`);
  }
  await send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
}

// The offline section pulls the plug on purpose, and the dev server's
// live-reload stream is the first thing to notice.
const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e)
  && !/ERR_INTERNET_DISCONNECTED/.test(e)
  && !/__dev/.test(e));
if (realErrors.length) {
  console.log(`\nconsole errors:\n  ${realErrors.join('\n  ')}`);
  failures += realErrors.length;
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall browser checks passed');
cleanup();
process.exit(failures ? 1 : 0);
