// Pinyin utilities. CC-CEDICT stores numbered pinyin ("ni3 hao3", "lu:4 lu:4"),
// which is good for exactness and terrible for reading, so we render diacritics
// for display and a toneless form for lookup.

const TONE_MARKS = {
  a: ['ā', 'á', 'ǎ', 'à'],
  e: ['ē', 'é', 'ě', 'è'],
  i: ['ī', 'í', 'ǐ', 'ì'],
  o: ['ō', 'ó', 'ǒ', 'ò'],
  u: ['ū', 'ú', 'ǔ', 'ù'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
};

/** Which vowel carries the tone mark, per the standard placement rules. */
function toneVowelIndex(syllable) {
  const a = syllable.indexOf('a');
  if (a >= 0) return a;
  const o = syllable.indexOf('o');
  if (o >= 0) return o;
  const e = syllable.indexOf('e');
  if (e >= 0) return e;
  // iu / ui: the mark goes on the second vowel.
  for (let i = syllable.length - 1; i >= 0; i--) {
    if ('iuü'.includes(syllable[i])) return i;
  }
  return -1;
}

/** "ni3 hao3" -> "nǐ hǎo". Non-syllable tokens (punctuation, latin) pass through. */
export function numberedToDiacritics(numbered) {
  return numbered
    .split(/\s+/)
    .map((tok) => {
      const m = /^([A-Za-zü:]+)([1-5])$/.exec(tok);
      if (!m) return tok.replace(/u:/g, 'ü');
      let syl = m[1].replace(/u:/g, 'ü').replace(/U:/g, 'Ü');
      const tone = Number(m[2]);
      if (tone === 5) return syl; // neutral tone is unmarked
      const lower = syl.toLowerCase();
      const idx = toneVowelIndex(lower);
      if (idx < 0) return syl;
      const base = lower[idx];
      const marked = TONE_MARKS[base]?.[tone - 1];
      if (!marked) return syl;
      const isUpper = syl[idx] !== lower[idx];
      return syl.slice(0, idx) + (isUpper ? marked.toUpperCase() : marked) + syl.slice(idx + 1);
    })
    .join(' ');
}

/** "ni3 hao3" -> "ni hao" (spaced, tones dropped). */
export function numberedToToneless(numbered) {
  return numbered
    .split(/\s+/)
    .map((tok) => tok.replace(/[1-5]$/, '').replace(/u:/g, 'u'))
    .join(' ')
    .toLowerCase()
    .trim();
}

const DIACRITIC_FOLD = [
  [/[āáǎàa]/g, 'a'], [/[ēéěèe]/g, 'e'], [/[īíǐìi]/g, 'i'],
  [/[ōóǒòo]/g, 'o'], [/[ūúǔùu]/g, 'u'], [/[ǖǘǚǜüv]/g, 'u'],
];

/**
 * Fold anything the user might type into the toneless, separator-free form
 * used for index keys: "Nǐ hǎo" / "ni3hao3" / "ni'hao" -> "nihao".
 */
export function normalizePinyin(input) {
  let s = input.toLowerCase().normalize('NFC');
  for (const [re, to] of DIACRITIC_FOLD) s = s.replace(re, to);
  return s.replace(/u:/g, 'u').replace(/[^a-z]/g, '');
}

/** Toneless form with syllable boundaries kept, for the spaced index key. */
export function tonelessSpaced(numbered) {
  return numberedToToneless(numbered);
}
