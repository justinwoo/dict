// Kana <-> romaji utilities. Used by both the build script (Node) and the page.
//
// Index keys are generated with kanaToRomaji(), which emits Hepburn. User input
// is folded with normalizeRomaji(), which maps wapuro/kunrei variants (si, tu,
// zi, sya...) onto the same Hepburn space so both sides meet in the middle.

const KATA_START = 0x30a1;
const KATA_END = 0x30f6;
const HIRA_OFFSET = 0x60;

/** Katakana -> hiragana, fullwidth ASCII -> ASCII, and strip variation marks. */
export function toHiragana(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= KATA_START && c <= KATA_END) out += String.fromCodePoint(c - HIRA_OFFSET);
    else if (c === 0x30fc) out += 'ー'; // prolonged sound mark stays
    else if (c >= 0xff01 && c <= 0xff5e) out += String.fromCodePoint(c - 0xfee0);
    else if (c === 0x3000) out += ' ';
    else out += ch;
  }
  return out;
}

// Digraphs first; the matcher is greedy on length.
const ROMAJI = {
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', きぇ: 'kye',
  しゃ: 'sha', しゅ: 'shu', しょ: 'sho', しぇ: 'she',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', ちぇ: 'che',
  にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo',
  みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo',
  ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo', じぇ: 'je',
  ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo',
  びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
  ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
  ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', ふゅ: 'fyu',
  ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo',
  てぃ: 'ti', でぃ: 'di', とぅ: 'tu', どぅ: 'du',
  うぃ: 'wi', うぇ: 'we', うぉ: 'wo',
  つぁ: 'tsa', つぃ: 'tsi', つぇ: 'tse', つぉ: 'tso',
  しゅ: 'shu', じゅ: 'ju',
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
  ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
};

const VOWELS = 'aiueo';

/**
 * Hepburn romanization of a kana string. Long vowels are written out
 * (こう -> "kou", コート -> "kooto") because that is how people type them.
 */
export function kanaToRomaji(input) {
  const s = toHiragana(input);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const two = s.slice(i, i + 2);
    if (ROMAJI[two]) { out += ROMAJI[two]; i += 2; continue; }
    const ch = s[i];
    if (ch === 'っ') {
      // Sokuon: double the consonant that follows.
      const nextTwo = s.slice(i + 1, i + 3);
      const next = ROMAJI[nextTwo] || ROMAJI[s[i + 1]];
      if (next) out += next.startsWith('ch') ? 't' : next[0];
      i += 1;
      continue;
    }
    if (ch === 'ー') {
      // Prolonged mark: repeat the previous vowel.
      const prev = out[out.length - 1];
      if (VOWELS.includes(prev)) out += prev;
      i += 1;
      continue;
    }
    if (ch === 'ん') {
      const nextCh = s[i + 1];
      const nextRomaji = nextCh ? (ROMAJI[s.slice(i + 1, i + 3)] || ROMAJI[nextCh] || '') : '';
      // n' before vowels and y, so んあ != な.
      out += (nextRomaji && (VOWELS.includes(nextRomaji[0]) || nextRomaji[0] === 'y')) ? "n'" : 'n';
      i += 1;
      continue;
    }
    if (ROMAJI[ch]) { out += ROMAJI[ch]; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

// Applied in order; longest patterns first so "shi" is not mangled by "si".
const ROMAJI_FOLDS = [
  [/ā/g, 'aa'], [/ī/g, 'ii'], [/ū/g, 'uu'], [/ē/g, 'ee'], [/ō/g, 'ou'],
  [/â/g, 'aa'], [/î/g, 'ii'], [/û/g, 'uu'], [/ê/g, 'ee'], [/ô/g, 'ou'],
  [/shi/g, '\x01'], [/chi/g, '\x02'], [/tsu/g, '\x03'], [/ji/g, '\x04'],
  [/sha/g, '\x05'], [/shu/g, '\x06'], [/sho/g, '\x07'], [/she/g, '\x08'],
  [/cha/g, '\x0b'], [/chu/g, '\x0c'], [/cho/g, '\x0e'], [/che/g, '\x0f'],
  [/(?:jya|zya)/g, '\x10'], [/(?:jyu|zyu)/g, '\x11'], [/(?:jyo|zyo)/g, '\x12'],
  [/(?:sya)/g, '\x05'], [/(?:syu)/g, '\x06'], [/(?:syo)/g, '\x07'],
  [/(?:tya)/g, '\x0b'], [/(?:tyu)/g, '\x0c'], [/(?:tyo)/g, '\x0e'],
  [/si/g, '\x01'], [/ti/g, '\x02'], [/tu/g, '\x03'],
  [/(?:zi|di)/g, '\x04'], [/du/g, 'zu'], [/hu/g, 'fu'],
  [/nn/g, 'n'], [/n'/g, 'n'],
  // restore
  [/\x01/g, 'shi'], [/\x02/g, 'chi'], [/\x03/g, 'tsu'], [/\x04/g, 'ji'],
  [/\x05/g, 'sha'], [/\x06/g, 'shu'], [/\x07/g, 'sho'], [/\x08/g, 'she'],
  [/\x0b/g, 'cha'], [/\x0c/g, 'chu'], [/\x0e/g, 'cho'], [/\x0f/g, 'che'],
  [/\x10/g, 'ja'], [/\x11/g, 'ju'], [/\x12/g, 'jo'],
];

/** Fold a user-typed romaji string into the same space as kanaToRomaji output. */
export function normalizeRomaji(input) {
  let s = input.toLowerCase().normalize('NFC').replace(/[\s　._-]+/g, '');
  for (const [re, to] of ROMAJI_FOLDS) s = s.replace(re, to);
  return s;
}

// Reverse table for romaji -> kana. Where two kana share a romanization
// (じ/ぢ, ず/づ) the first one listed wins, which is the common spelling.
const TO_KANA = new Map();
for (const [kana, romaji] of Object.entries(ROMAJI)) {
  if (!TO_KANA.has(romaji)) TO_KANA.set(romaji, kana);
}

/**
 * Romaji -> hiragana, so typed input can be run through the same kana-based
 * machinery (deconjugation, kana index keys) as pasted Japanese text.
 * Input should already be through normalizeRomaji().
 */
export function romajiToHiragana(input) {
  const s = input;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    // Doubled consonant -> sokuon.
    if (c === s[i + 1] && !VOWELS.includes(c) && c !== 'n') { out += 'っ'; i++; continue; }
    if (c === 'n' && (i + 1 === s.length || (!VOWELS.includes(s[i + 1]) && s[i + 1] !== 'y'))) {
      out += 'ん';
      i += s[i + 1] === "'" ? 2 : 1;
      continue;
    }
    let matched = false;
    for (const len of [3, 2, 1]) {
      const kana = TO_KANA.get(s.slice(i, i + len));
      if (kana) { out += kana; i += len; matched = true; break; }
    }
    if (!matched) { out += c; i++; }
  }
  return out;
}

// Long vowels are the main thing people spell inconsistently: とうきょう is
// typed toukyou, tokyo, tookyoo or tōkyō. Collapsing them all to a single
// short-vowel form gives a forgiving fallback key.
const LOOSE_FOLDS = [
  [/(?:ou|oo|wo)/g, 'o'], [/uu/g, 'u'], [/aa/g, 'a'], [/ii/g, 'i'], [/(?:ee|ei)/g, 'e'],
];

/** Long-vowel-insensitive romaji key. Lossy on purpose; used as a fallback. */
export function looseRomaji(romaji) {
  let s = normalizeRomaji(romaji);
  for (const [re, to] of LOOSE_FOLDS) s = s.replace(re, to);
  return s;
}

const HAS_KANA = /[぀-ヿ]/;
const HAS_HAN = /[㐀-鿿豈-﫿]/;
const HAS_LATIN = /[a-zÀ-ɏ]/i;

export function scriptOf(s) {
  return {
    kana: HAS_KANA.test(s),
    han: HAS_HAN.test(s),
    latin: HAS_LATIN.test(s),
  };
}
