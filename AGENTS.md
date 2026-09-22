# Notes for agents working on this repo

Working notes and non-obvious decisions. Keep them here — **do not write this
kind of thing into README.md.**

## Commands

```
npm run fetch        download upstream dumps into src/   (~450 MB, one time)
npm run build        src/ -> data/                       (~77 MB, ~17 s)
npm run serve        http://localhost:8080, live reload
npm run test:serve   port 8099, for the test suites
npm test             worker-level: lookup, ranking, filtering
npm run test:browser real page in headless Chrome, incl. offline
npm run clean        headless Chrome profiles only
npm run clean:data   also data/
npm run clean:all    also src/
```

## Layout

The site lives at the **repo root**, because GitHub Pages only publishes from
`/` or `/docs` — it cannot serve a `/web` subdirectory. So `index.html`,
`app.js`, `worker.js`, `sw.js`, `styles.css`, `lib/` and `data/` are all at the
top level, alongside `build/` and `src/` which are not part of the site.
`build/serve.mjs` refuses to serve `.git/`, `src/`, `node_modules/` and
`build/` so local serving matches what is published.

`data/` is **deliberately not gitignored**: Pages serves it straight from the
branch. That means ~77 MB per commit that touches it, and a rebuild rewrites
every file, so repeated rebuild-commits will bloat history fast. If that
becomes a problem, switch Pages' Source to GitHub Actions and run
`npm run fetch && npm run build` in the workflow instead of committing data.

`.nojekyll` is required — otherwise Pages runs the files through Jekyll.

No server code runs in production.

## Architecture

- `worker.js` is the search engine and owns all the data; `app.js` only
  renders. Keeps a wide search off the main thread.
- Data files are newline-delimited text, not JSON. The worker holds each file
  as one string plus a `Uint32Array` of line offsets, binary-searches the index
  files, and parses a line into an object only when it is about to be shown.
  A phone never parses a 30 MB object graph to look up one word.
- Index id lists are base-36 gap-encoded (`packIds` / `unpackIds`).
- `lib/*` is imported by **both** the build and the page, so index keys and
  query keys cannot drift apart. Change a normalizer → rebuild.

## Field layout

Separators: `\x1f` between fields, `\x1e` between repeated items, `\x1d`
between subfields.

```
jp.txt   kanji | kana | common | senses(pos ⟂ gloss ⟂ misc) | tatoebaFreq
cn.txt   trad  | simp | pinyinNumbered | glosses | tatoebaFreq
*.idx    key \t packedIds            (en.idx: phraseJP|phraseCN|wordJP|wordCN)
jp2cn / cn2jp   line N = links for entry N, "id:score,..."
*.ex.txt        line N = examples for entry N
```

## Traps already hit — do not re-introduce

- **Service worker caching.** The shell is *network-first*; the data is
  *cache-first* and never revalidated, fetched as `?v=<meta.built>`. Making the
  shell cache-first means edits to `app.js` are invisible in the browser for
  ever, which wasted a lot of time. `meta.json` must stay network-first since
  it carries the stamp. Old `?v=` entries are purged by `purgeOldData`.
- **Mixed-vintage assets.** The page is several independently-cached files, so
  a new `worker.js` can meet an old `meta.json` and look for data files the old
  manifest never listed (`Cannot read properties of undefined (reading
  'count')`). Three defences, keep all of them: `fetchMeta` reads meta.json
  with `cache: 'no-store'` and only falls back to the cached copy when offline;
  every link-file access tolerates a missing file; and a failed search clears
  the shell cache and reloads once per session (`dict.healed`). Bump
  `VERSION` in `sw.js` whenever the data file *set* changes.
- **The layout is centred; verify before "fixing" it.** Measured on the
  deployed site at 1440px: `main` left 333 / right 333, computed margins
  332.5px each side, no horizontal overflow; the clear button's glyph is 0.00px
  off on both axes. If it looks off-centre in a screenshot, suspect a cropped
  capture or something docked to the left of the page viewport (a left-side
  browser panel centres the page in its own viewport but not in a whole-window
  capture). Do not "correct" the centering CSS — it is mathematically right.
- **Never centre a glyph by centring its box.** The `✕` character sits
  off-centre inside its own em-box, so `place-items: center` still looks
  crooked. The clear button uses an inline SVG; verified at 0.00 px offset on
  both axes by comparing `getBoundingClientRect` centres.
- **Ranking is tier-then-ordering, not a sum of bonuses.** `h.score` is the
  match score alone (`HIT.*`, plus the prefix-length penalty). Entry quality is
  applied by the `byRank` comparator: `minor → score → common → glossDepth →
  freq → headLen`. Two earlier attempts with additive bonuses both went wrong:
  uncapped, a common word matched by a weak romaji prefix beat a real gloss hit
  ("shit" surfaced 下 and 舌, since it prefixes the reading *shita*); capped,
  several strong signals saturated and くっそ beat 糞 for "shit" purely because
  its first gloss is literally "shit!". Do not reintroduce points-based
  ranking — add a comparator key instead.
- **`glossDepth` looks at every sense**, not just the first gloss of the first
  sense. 糞 carries "shit" third in sense 1; only checking position 0 made it
  invisible. It is applied **only to English-derived hits** (`why.en`): for a
  reading match it means nothing, and applying it there let シン beat 新 for
  "shin" because シン happens to carry a literal "shin" gloss.
- **Which reading matched is a ranking signal** (`readingRank`). 寝 lists ね
  first and しん third, and its Tatoeba frequency is ~50x 新's because 寝 is a
  substring of 寝る, 寝室 and so on. Raw frequency therefore put the wrong
  entry on top for "shin"; preferring the entry whose *main* reading is the
  query fixes it. Substring-counted frequency is inflated for single kanji in
  general — treat it as a weak tiebreak, never a headline signal.
- **English words are not romaji.** If the latin query is itself a gloss key,
  romaji and pinyin *prefix* matching is switched off (`romajiPrefix` /
  `pinyinPrefix`). Exact reading matches still count, so "sake" still finds 酒.
- **CC-CEDICT packs synonyms into one sense** with `;` (`/to eat; to consume/`).
  Split on both `/` and `;` or the key becomes "eat consume" and never matches
  anything. This is why 吃 was missing from 食べる for a while.
- **Two kinds of JP↔CN link, ranked.** `jp2cn.han.txt` / `cn2jp.han.txt` are
  orthographic: the Japanese written form *is* a Chinese word. Matched against
  both CC-CEDICT columns (covers forms identical to traditional, and shinjitai
  that coincide with simplified), plus Unihan `kJapaneseOldVariant` for
  shinjitai→kyūjitai (図→圖), without which 図書館 never reaches 圖書館.
  `jp2cn.txt` / `cn2jp.txt` are the English-gloss heuristic. The page shows
  hanzi matches first and labels the others "eng heuristic"; an entry reached
  both ways appears only under the hanzi heading. Orthographic ≠ translation:
  大丈夫 matches 大丈夫 but means something else. That is fine — the heading
  and the visible glosses say so.
- **Two corpus counts, used differently per language.** `countCorpus` emits
  `freq` (longest-match segmentation — only the word actually chosen at each
  position) and `seen` (raw substring hits). Chinese ranks on `freq`, because
  CC-CEDICT has no commonness flag and substring counts are dominated by bound
  morphemes: 什 scored 3653 against 什麼's 1332, so "what" returned the piece
  instead of the word. Segmenting drops 什 to 21. Japanese ranks on `seen`,
  because JMdict's `common` flag already separates real words, and segmenting
  starves single kanji that mostly live inside compounds — it pushed 信 above
  新 for "shin". Both use `seen` for attestation (the filter). Chinese also
  splits a form's count among its homographs (嗎 has three CC-CEDICT entries
  and the "(coll.) what?" one was taking the question particle's whole count);
  Japanese does not, because splitting there demoted 新 again.
- **Ordering asks "is it in the headline sense" before frequency, then exact
  depth.** Comparing exact depth first put 3Q above 謝謝 for "thank you", since
  "thank you" is 3Q's only gloss and 謝謝's third.
- **The pivot needs a frequency prior.** Rarity damping alone ranked obscure
  entries above the obvious translation (食べる → 下箸 instead of 吃).
- **Render races.** A debounced search still in flight can paint over a linked
  entry the reader opened. `view` plus `runToken` guard it; `openEntry` bumps
  `runToken`. The browser test needs a settle sleep after `query()` for the
  same reason.
- **JMdict's last entry** shares its line with the brackets closing the file,
  so the line parser peels trailing brackets until it parses.

## View and navigation

Results are a **master/detail** split (Pleco-style): `#list` holds compact rows
(headword, reading, one clipped line of gloss, JP/CN tag coloured when the word
is common), `#detail` holds the full entry. Under 720px only one shows at a
time, with a Back button. Full cards for every result were far too big.

The shell is **fixed height**: `body` is a flex column at `100dvh` with
`overflow: hidden`, and the list and detail each scroll internally. Earlier
attempts sized the list with `calc(100dvh - …)` against a sticky offset, which
overshot the viewport by 39px before the page was scrolled. Under 720px it
reverts to ordinary page scrolling with one pane at a time.

The hash is `#mode/query` or `#mode/query/kind:id` — **the selection is in the
URL**, not only in `history.state`, because state does not survive a hard
refresh and cannot be shared. On load the third segment is applied once its
results arrive (`pendingSelect`), falling back to fetching the entry if this
result set does not contain it.

History state carries `{q, mode, index, sel}` — the **selected row**, not just
the query. Restoring prefers the remembered index, falls back to finding the
same entry in the new result set, and only re-fetches if it is absent. A
`restoring` flag stops `select()` rewriting the very entry being restored.

**Redraws must not move the selection.** `render()` also runs for background
redraws — example sentences arriving, the filter being toggled — and those
reset the reader to row 0 and rewrote the URL under them. It now keeps the
previously selected entry if it is still in the results, and `select()` skips
re-logging a word it just logged so redraws do not churn the saved history.

History rules — **typing must never push a history entry**, or Back crawls
through it one letter at a time:

| action | history |
| --- | --- |
| typing | `replaceState`, but the *first* edit after a commit pushes a scratch entry so the committed one is not overwritten |
| Enter / the keyboard Search key | `pushState` |
| following a link chip | `pushState`, and the word is unshifted onto the list |
| picking from the History panel | `pushState` |

`syncUrl` treats two places as the same only when query, mode **and
selection** match — comparing just the query made link dives replace their
entry, so Back skipped past them.

Looked-up words persist in `localStorage` under `dict.recent` (newest first,
deduplicated by kind+id, capped at 300), reachable from the History button.

## Filtering low-value entries

`hideMinor` (the "Hide low scoring" checkbox, on by default) drops an entry
when every sense carries a `LOW_VALUE` tag (`arch`, `obs`, `rare`, `chn`,
`sl`, `vulg`, …), or when it is unattested in the corpus and not `common`; for
Chinese, when every gloss is a bare `variant of` / `surname`. **An exact
headword match is never hidden** — looking a word up by name must always find
it. The count is reported in the status line.

This is about usefulness, not decency: `ばば` is dropped because nobody needs
it, not because it is rude. `くそ` stays.

## Modes

The tab picks which entries come back, not a direction. Every query is matched
against Japanese, Chinese and English regardless.

| key | tab | behaviour |
| --- | --- | --- |
| `all` | All | JP and CN entries |
| `jp` | JP ↔ EN | JP entries; CN matches bridged through `cn2jp` |
| `cn` | CN ↔ EN | CN entries; JP matches bridged through `jp2cn` |
| `jpcn` | JP ↔ CN | both, but only entries that have a counterpart |

## JP↔CN source data — already researched, don't redo it

There is no free JP↔CN dictionary comparable to CC-CEDICT. JMdict ships
eng/dut/fre/ger/hun/rus/slv/spa/swe glosses — no Chinese. Hence the pivot.

If the heuristic links need to get better, in rough order of value:

1. **Open Multilingual Wordnet** — the Japanese (NICT) and Chinese (COW)
   wordnets are both expansion wordnets over Princeton WordNet 3.0, so they
   share synset offsets. Joining on a concept id beats matching gloss strings.
   Via the `wn` Python package (`omw-ja`, `omw-zh`) or NLTK's omw-1.4.
2. **Wiktionary translation tables** — ja.wiktionary and zh.wiktionary carry
   editor-asserted cross-language translations; machine-readable via
   kaikki.org / wiktextract.
3. **Wikidata sitelinks** — ja↔zh article titles, strong for nouns and
   technical terms.

## QR code

`build/qr.py` is a from-scratch QR encoder (byte mode, EC level M, versions
1-10) — no npm package, no pip install, stock Python only. `npm run qr`
regenerates `qr.svg`; the page shows it on the start screen and the README
embeds it.

`npm run qr:verify` checks it against `qrencode`, asserting our symbol is
identical to the reference **under one of the eight masks**. That pins down the
encoding, Reed-Solomon codewords, interleaving, placement and format bits. The
chosen mask may differ and that is fine: mask selection is a scan-reliability
optimisation, all eight are valid, and libqrencode's rule-3 scan diverges from
the spec (it does not extend runs into the quiet zone). Bugs this caught, all
of which still produce plausible-looking codes: pad bytes must alternate from
`0xEC` counted from the *first* pad byte; the two copies of the format bits run
in opposite directions; rule 4 compares against the neighbouring multiples of
five rather than a rounded percentage.

## Per-character popover

Han characters in the detail pane (headword, alternate forms, example
sentences) are individually wrapped by `hanify()`; hovering asks the worker for
the best Chinese entry written that way and clicking opens it. "Best" prefers a
substantive entry over a cross-reference or surname regardless of frequency —
otherwise hovering 書 offered "abbr. for 書經" instead of "book". The popover is
`pointer-events: none` so it never swallows the click.

## House rules

- **Keep `TASKS.md` current.** Requests arrive faster than they can be done;
  write each one down as it arrives and tick it off when verified, rather than
  carrying it in your head.
- Verify in the browser, not just at the worker level — several bugs only
  appeared through the real page.
- Don't hand the user `rm` commands; add it to `build/clean.mjs`.
- Service workers and the clipboard API need a secure context. `localhost` is
  fine; a plain-http LAN address from a phone gets neither.
