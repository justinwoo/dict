// Rule-based Japanese deconjugation: 食べさせられなかった -> 食べる.
//
// Each rule rewrites a suffix and is tagged with the form it undoes. We apply
// them breadth-first up to a small depth and hand every candidate stem to the
// dictionary; wrong guesses simply miss, so the rules can be generous.

/** @typedef {{from:string,to:string,name:string}} Rule */

/** @type {Rule[]} */
const RULES = [
  // --- polite ---
  { from: 'ません', to: 'る', name: 'polite negative' },
  { from: 'ませんでした', to: 'る', name: 'polite past negative' },
  { from: 'ました', to: 'る', name: 'polite past' },
  { from: 'まして', to: 'る', name: 'polite -te' },
  { from: 'ましょう', to: 'る', name: 'polite volitional' },
  { from: 'ます', to: 'る', name: 'polite' },

  // --- te / ta forms ---
  { from: 'って', to: 'う', name: '-te' },
  { from: 'って', to: 'つ', name: '-te' },
  { from: 'って', to: 'る', name: '-te' },
  { from: 'った', to: 'う', name: 'past' },
  { from: 'った', to: 'つ', name: 'past' },
  { from: 'った', to: 'る', name: 'past' },
  { from: 'んで', to: 'ぶ', name: '-te' },
  { from: 'んで', to: 'ぬ', name: '-te' },
  { from: 'んで', to: 'む', name: '-te' },
  { from: 'んだ', to: 'ぶ', name: 'past' },
  { from: 'んだ', to: 'ぬ', name: 'past' },
  { from: 'んだ', to: 'む', name: 'past' },
  { from: 'いて', to: 'く', name: '-te' },
  { from: 'いた', to: 'く', name: 'past' },
  { from: 'いで', to: 'ぐ', name: '-te' },
  { from: 'いだ', to: 'ぐ', name: 'past' },
  { from: 'して', to: 'す', name: '-te' },
  { from: 'した', to: 'す', name: 'past' },
  { from: 'て', to: 'る', name: '-te' },
  { from: 'た', to: 'る', name: 'past' },
  { from: 'って', to: 'く', name: '-te (irregular 行く)' },
  { from: 'った', to: 'く', name: 'past (irregular 行く)' },

  // --- negative ---
  { from: 'なかった', to: 'ない', name: 'past negative' },
  { from: 'なくて', to: 'ない', name: 'negative -te' },
  { from: 'ない', to: 'る', name: 'negative' },
  ...'わかがさたなばまら'.split('').map((c) => ({
    from: c + 'ない',
    to: { わ: 'う', か: 'く', が: 'ぐ', さ: 'す', た: 'つ', な: 'ぬ', ば: 'ぶ', ま: 'む', ら: 'る' }[c],
    name: 'negative',
  })),

  // --- potential / passive / causative ---
  { from: 'られる', to: 'る', name: 'potential/passive' },
  { from: 'させる', to: 'る', name: 'causative' },
  { from: 'られない', to: 'る', name: 'negative potential' },
  ...'えけげせてねべめれ'.split('').map((c) => ({
    from: c + 'る',
    to: { え: 'う', け: 'く', げ: 'ぐ', せ: 'す', て: 'つ', ね: 'ぬ', べ: 'ぶ', め: 'む', れ: 'る' }[c],
    name: 'potential',
  })),
  ...'わかがさたなばまら'.split('').map((c) => ({
    from: c + 'れる',
    to: { わ: 'う', か: 'く', が: 'ぐ', さ: 'す', た: 'つ', な: 'ぬ', ば: 'ぶ', ま: 'む', ら: 'る' }[c],
    name: 'passive',
  })),
  ...'わかがさたなばまら'.split('').map((c) => ({
    from: c + 'せる',
    to: { わ: 'う', か: 'く', が: 'ぐ', さ: 'す', た: 'つ', な: 'ぬ', ば: 'ぶ', ま: 'む', ら: 'る' }[c],
    name: 'causative',
  })),

  // --- volitional / conditional / imperative ---
  { from: 'よう', to: 'る', name: 'volitional' },
  ...'おこごそとのぼもろ'.split('').map((c) => ({
    from: c + 'う',
    to: { お: 'う', こ: 'く', ご: 'ぐ', そ: 'す', と: 'つ', の: 'ぬ', ぼ: 'ぶ', も: 'む', ろ: 'る' }[c],
    name: 'volitional',
  })),
  ...'えけげせてねべめれ'.split('').map((c) => ({
    from: c + 'ば',
    to: { え: 'う', け: 'く', げ: 'ぐ', せ: 'す', て: 'つ', ね: 'ぬ', べ: 'ぶ', め: 'む', れ: 'る' }[c],
    name: 'conditional',
  })),
  { from: 'れば', to: 'る', name: 'conditional' },
  { from: 'ろ', to: 'る', name: 'imperative' },

  // --- auxiliaries stacked on the -te form ---
  { from: 'ている', to: 'て', name: 'progressive' },
  { from: 'てる', to: 'て', name: 'progressive' },
  { from: 'ている', to: 'て', name: 'progressive' },
  { from: 'でいる', to: 'で', name: 'progressive' },
  { from: 'でる', to: 'で', name: 'progressive' },
  { from: 'てある', to: 'て', name: 'resultant' },
  { from: 'ておく', to: 'て', name: 'preparatory' },
  { from: 'とく', to: 'て', name: 'preparatory' },
  { from: 'てしまう', to: 'て', name: 'completive' },
  { from: 'ちゃう', to: 'て', name: 'completive' },
  { from: 'じゃう', to: 'で', name: 'completive' },
  { from: 'ていく', to: 'て', name: 'directional' },
  { from: 'てくる', to: 'て', name: 'directional' },

  // --- desiderative, -sa, -sugiru ---
  { from: 'たい', to: 'る', name: 'desiderative' },
  { from: 'たがる', to: 'る', name: 'desiderative' },
  { from: 'すぎる', to: 'る', name: 'excessive' },

  // --- i-adjectives ---
  { from: 'くない', to: 'い', name: 'negative' },
  { from: 'かった', to: 'い', name: 'past' },
  { from: 'くなかった', to: 'い', name: 'past negative' },
  { from: 'くて', to: 'い', name: '-te' },
  { from: 'く', to: 'い', name: 'adverbial' },
  { from: 'ければ', to: 'い', name: 'conditional' },
  { from: 'さ', to: 'い', name: 'nominalised' },

  // --- suru / kuru irregulars ---
  { from: 'します', to: 'する', name: 'polite' },
  { from: 'した', to: 'する', name: 'past' },
  { from: 'して', to: 'する', name: '-te' },
  { from: 'しない', to: 'する', name: 'negative' },
  { from: 'できる', to: 'する', name: 'potential' },
  { from: 'される', to: 'する', name: 'passive' },
  { from: 'させる', to: 'する', name: 'causative' },
  { from: 'しよう', to: 'する', name: 'volitional' },
  { from: 'きます', to: 'くる', name: 'polite' },
  { from: 'きた', to: 'くる', name: 'past' },
  { from: 'きて', to: 'くる', name: '-te' },
  { from: 'こない', to: 'くる', name: 'negative' },
  { from: 'した', to: '', name: 'suru-noun past' },
  { from: 'します', to: '', name: 'suru-noun polite' },
  { from: 'する', to: '', name: 'suru-noun' },

  // --- godan masu-stem (書き -> 書く) ---
  ...'いきぎしちにびみり'.split('').map((c) => ({
    from: c,
    to: { い: 'う', き: 'く', ぎ: 'ぐ', し: 'す', ち: 'つ', に: 'ぬ', び: 'ぶ', み: 'む', り: 'る' }[c],
    name: 'stem',
  })),
].filter((r) => r && r.from);

const MAX_DEPTH = 4;

/**
 * Candidate dictionary forms for a possibly-inflected word.
 * @returns {{form:string, reasons:string[]}[]} original first, then candidates
 */
export function deconjugate(word) {
  const seen = new Map([[word, []]]);
  let frontier = [[word, []]];
  const out = [{ form: word, reasons: [] }];

  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next = [];
    for (const [form, reasons] of frontier) {
      for (const rule of RULES) {
        if (form.length <= rule.from.length) continue;
        if (!form.endsWith(rule.from)) continue;
        const stem = form.slice(0, form.length - rule.from.length) + rule.to;
        if (!stem || seen.has(stem)) continue;
        const chain = [...reasons, rule.name];
        seen.set(stem, chain);
        next.push([stem, chain]);
        out.push({ form: stem, reasons: chain });
      }
    }
    frontier = next;
    if (out.length > 400) break;
  }
  return out;
}
