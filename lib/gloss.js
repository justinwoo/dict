// English gloss normalization, shared by the build and the page so that index
// keys and query keys are produced by exactly the same rules.

const STOP = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'or',
  'and', 'be', 'is', 'are', 'as', 'that', 'this', 'it', 'one', 'someone',
  'something', 'etc', 'esp', 'usu', 'e', 'g', 'i', 's',
]);

/**
 * Strip the editorial furniture JMdict and CC-CEDICT glosses carry, so
 * "to eat", "(usu. kana) eat" and "eat" all land on "eat".
 */
export function normGloss(g) {
  return String(g || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')      // (usu. kana), (CL: 個)
    .replace(/\[[^\]]*\]/g, ' ')     // [Taiwan pr. ...]
    .replace(/\bsee also\b.*$/, ' ')
    .replace(/\bcl:.*$/, ' ')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^to\s+/, '')
    .replace(/^(?:a|an|the)\s+/, '');
}

/** Content words of a normalized gloss, for word-level indexing. */
export function glossWords(norm) {
  return norm.split(' ').filter((w) => w.length > 1 && !STOP.has(w));
}
