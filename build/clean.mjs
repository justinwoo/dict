#!/usr/bin/env node
// Removes generated and scratch artefacts.
//
//   node build/clean.mjs          scratch only: headless Chrome profiles
//   node build/clean.mjs --data   also the generated data/
//   node build/clean.mjs --all    also the downloaded source dumps
//
// The default is deliberately cheap: it throws away browser profiles (whose
// stale service-worker caches are the usual reason the page looks wrong) but
// keeps the 78 MB of built data.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const all = process.argv.includes('--all');
const withData = all || process.argv.includes('--data');
const tmp = process.env.TMPDIR || os.tmpdir();

const targets = [
  [path.join(tmp, 'dict-cdp-profile'), 'headless Chrome test profile'],
  [path.join(tmp, 'dict-probe'), 'headless Chrome probe profile'],
  [path.join(tmp, 'dict-shot'), 'headless Chrome screenshot profile'],
];
if (withData) targets.push(['data', 'generated dictionary files']);
if (all) targets.push(['src', 'downloaded source dumps']);

for (const [target, what] of targets) {
  if (!fs.existsSync(target)) {
    console.log(`[clean] absent  ${target}`);
    continue;
  }
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`[clean] removed ${target}  (${what})`);
}

if (!withData) console.log('[clean] kept data — pass --data to rebuild from scratch');
if (!all) console.log('[clean] kept src/ — pass --all to remove the downloads too');
