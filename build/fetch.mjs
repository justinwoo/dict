#!/usr/bin/env node
// Downloads the upstream dictionary dumps. Roughly 450 MB of source data that
// the build reduces to about 78 MB of shipped files.
//
//   node build/fetch.mjs [srcDir]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const srcDir = path.resolve(process.argv[2] || 'src');
fs.mkdirSync(srcDir, { recursive: true });

const log = (...a) => console.log('[fetch]', ...a);

async function download(url, dest) {
  if (fs.existsSync(dest)) { log(`have ${path.basename(dest)}`); return; }
  log(`${url} -> ${path.basename(dest)}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

// JMdict, as the examples build: entries plus Tatoeba sentences per sense.
const release = await (await fetch(
  'https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest',
  { headers: { accept: 'application/vnd.github+json' } },
)).json();
const asset = release.assets.find((a) => /^jmdict-examples-eng-.*\.json\.tgz$/.test(a.name));
if (!asset) throw new Error('no jmdict-examples-eng asset in the latest release');

await download(asset.browser_download_url, path.join(srcDir, 'jmdict-ex.json.tgz'));
const jsonName = asset.name.replace(/\.tgz$/, '');
if (!fs.existsSync(path.join(srcDir, jsonName))) {
  log('extracting JMdict...');
  execFileSync('tar', ['xzf', 'jmdict-ex.json.tgz'], { cwd: srcDir });
}
await download(
  'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz',
  path.join(srcDir, 'cedict.txt.gz'),
);

for (const lang of ['cmn', 'eng', 'jpn']) {
  await download(
    `https://downloads.tatoeba.org/exports/per_language/${lang}/${lang}_sentences.tsv.bz2`,
    path.join(srcDir, `${lang}_sentences.tsv.bz2`),
  );
}

// Unihan's kJapaneseOldVariant is the shinjitai -> kyujitai map (図 -> 圖),
// which is what lets a modern Japanese spelling reach its Chinese counterpart.
await download('https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip', path.join(srcDir, 'Unihan.zip'));
if (!fs.existsSync(path.join(srcDir, 'Unihan_Variants.txt'))) {
  log('extracting Unihan variants...');
  execFileSync('unzip', ['-o', '-q', 'Unihan.zip', 'Unihan_Variants.txt'], { cwd: srcDir });
}

await download('https://downloads.tatoeba.org/exports/links.tar.bz2', path.join(srcDir, 'links.tar.bz2'));
if (!fs.existsSync(path.join(srcDir, 'links.csv'))) {
  log('extracting Tatoeba links...');
  execFileSync('tar', ['xjf', 'links.tar.bz2'], { cwd: srcDir });
}

log(`ready in ${srcDir}`);
