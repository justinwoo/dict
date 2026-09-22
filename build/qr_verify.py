#!/usr/bin/env python3
"""Check build/qr.py against the qrencode reference implementation.

A hand-written QR encoder is only worth having if it is provably right, so this
compares module matrices with qrencode. What is asserted is that our symbol is
identical to the reference **under one of the eight masks** — that pins down the
data encoding, Reed-Solomon codewords, block interleaving, module placement and
format information exactly.

The chosen mask may differ. Mask selection is a scan-reliability optimisation,
not part of correctness: all eight produce a valid, scannable symbol, and
libqrencode's rule-3 scan diverges slightly from the specification (it does not
extend runs into the quiet zone). Ours follows the spec.

qrencode is only needed for this check, never to build.

    python3 build/qr_verify.py
"""

import shutil
import subprocess
import sys

import qr


def reference(text):
    """qrencode's matrix for the same settings: level M, no quiet zone."""
    out = subprocess.run(
        ['qrencode', '-t', 'ASCII', '-l', 'M', '-m', '0', '--', text],
        capture_output=True, text=True, check=True,
    ).stdout
    # Two characters per module: '##' dark, '  ' light.
    return [[1 if line[i] == '#' else 0 for i in range(0, len(line), 2)]
            for line in out.splitlines() if line.strip()]


def candidates(text):
    """Our symbol under each of the eight masks, plus the one we would pick."""
    payload = text.encode('utf-8')
    version = qr.choose_version(len(payload))
    codewords = qr.interleave(qr.encode_data(payload, version), version)
    bits = []
    for cw in codewords:
        for i in range(7, -1, -1):
            bits.append((cw >> i) & 1)
    bits.extend([0] * qr.REMAINDER_BITS[version])

    grids, scores = [], []
    for mask in range(8):
        grid, fixed, size = qr.build_matrix(version)
        qr.place_data(grid, fixed, size, bits)
        for r in range(size):
            for c in range(size):
                if not fixed[r][c] and qr.MASKS[mask](r, c):
                    grid[r][c] ^= 1
        qr.apply_format(grid, size, mask)
        qr.apply_version(grid, size, version)
        grids.append(grid)
        scores.append(qr.penalty(grid, size))
    return grids, scores.index(min(scores))


# Byte mode only: qrencode switches to the denser alphanumeric mode for
# uppercase-and-digits input, which is a different (also valid) encoding.
CASES = [
    'https://jusrin.dev/dict/',
    'https://jusrin.dev/dict/#cn/nihao',
    'hello world',
    'hello worlds',
    'hello there world',
    'abcdefghijklmnopqrstuvwx',
    'https://example.com/a/fairly/long/path?with=query&more=parameters#and-a-fragment',
]

if not shutil.which('qrencode'):
    print('qrencode not installed - skipping verification')
    sys.exit(0)

failures = 0
for text in CASES:
    ref = reference(text)
    grids, chosen = candidates(text)
    size = len(ref)
    matches = [m for m, g in enumerate(grids)
               if len(g) == size and all(g[r][c] == ref[r][c]
                                         for r in range(size) for c in range(size))]
    if not matches:
        print(f'FAIL {text[:52]!r}: no mask reproduces the reference')
        failures += 1
        continue
    note = '' if chosen in matches else f' (we pick mask {chosen}, qrencode {matches[0]})'
    print(f'ok   {size}x{size} matches qrencode under mask {matches[0]}{note}  {text[:44]}')

print('all QR symbols match the reference' if not failures else f'{failures} mismatch(es)')
sys.exit(1 if failures else 0)
