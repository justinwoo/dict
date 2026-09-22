#!/usr/bin/env node
// Static server for local use. Compresses on the fly so the transfer sizes
// match what a real host would send, and sets long cache lifetimes on data.
//
//   node build/serve.mjs [port] [root] [--no-watch]
//
// Root defaults to the repo root, which is what GitHub Pages publishes.
//
// Watches the app files and reloads open pages on change. It drops the service
// worker's shell cache before reloading, otherwise the worker would keep
// serving the previous app.js. Editing the dictionary data is not watched —
// that needs `npm run build`.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const root = path.resolve(process.argv[3] || '.');
const port = Number(process.argv[2] || 8080);

const watch = !process.argv.includes('--no-watch');

// Injected into HTML so an edit reloads whatever is open.
const LIVE_RELOAD = `
<script>
(() => {
  const es = new EventSource('/__dev');
  es.onmessage = async (e) => {
    if (e.data !== 'reload') return;
    // The service worker would otherwise serve the shell it cached a moment
    // ago; drop it and let the reload fetch fresh files.
    try {
      for (const k of await caches.keys()) if (k.includes('shell')) await caches.delete(k);
    } catch {}
    location.reload();
  };
})();
</script>`;

const clients = new Set();
let reloadTimer;

function scheduleReload(file) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    console.log(`changed: ${file} — reloading ${clients.size} client(s)`);
    for (const res of clients) res.write('data: reload\n\n');
  }, 60);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.idx': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.txt', '.idx']);

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/__dev') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    // The site now lives at the repo root, so the repo's own working files sit
    // alongside it. They are not part of the site.
    if (/^\/(?:\.git|src|node_modules|build)\//.test(rel)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const file = path.join(root, rel);
    if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }

    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) { res.writeHead(404).end('not found'); return; }

    const ext = path.extname(file);
    const headers = {
      'content-type': TYPES[ext] || 'application/octet-stream',
      // The service worker handles staleness; do not let the browser cache
      // the shell across edits during development.
      'cache-control': rel.includes('/data/') ? 'public, max-age=86400' : 'no-cache',
    };

    const accepts = req.headers['accept-encoding'] || '';
    const gzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(accepts);
    if (gzip) headers['content-encoding'] = 'gzip';

    // HTML gets the reload snippet spliced in, so its length changes.
    const inject = watch && ext === '.html';
    let body = null;
    if (inject) {
      const html = await fs.promises.readFile(file, 'utf8');
      body = Buffer.from(
        html.includes('</body>') ? html.replace('</body>', `${LIVE_RELOAD}\n</body>`) : html + LIVE_RELOAD,
      );
    }
    if (!gzip) headers['content-length'] = body ? body.length : stat.size;

    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }

    const source = body ? Readable.from(body) : fs.createReadStream(file);
    if (gzip) await pipeline(source, zlib.createGzip({ level: 6 }), res);
    else await pipeline(source, res);
  } catch (err) {
    if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !res.headersSent) {
      res.writeHead(500).end(String(err.message));
    }
  }
}).listen(port, () => {
  console.log(`serving ${root} at http://localhost:${port}/`);
  if (watch) console.log('watching for changes (live reload on)');
});

if (watch) {
  // Ignore generated data, downloads and tooling — only the page matters here.
  fs.watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const f = filename.replaceAll('\\', '/');
    if (/^(data|src|build|node_modules|\.git)\//.test(f) || f.endsWith('~') || f.startsWith('.')) return;
    scheduleReload(f);
  });
}
