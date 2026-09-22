#!/usr/bin/env python3
"""Minimal QR encoder: byte mode, error-correction level M, versions 1-10.

Written out rather than pulled from a package so the build has no dependency
beyond a stock Python. It covers exactly what this repo needs — one short URL —
and `build/qr_verify.py` checks its output module-for-module against the
`qrencode` reference implementation.

    python3 build/qr.py "https://jusrin.dev/dict/" qr.svg
"""

import sys

# Per version (index 1-10) at EC level M: error-correction codewords per block,
# then the block layout as (count, data codewords per block) groups.
EC_M = {
    1:  (10, [(1, 16)]),
    2:  (16, [(1, 28)]),
    3:  (26, [(1, 44)]),
    4:  (18, [(2, 32)]),
    5:  (24, [(2, 43)]),
    6:  (16, [(4, 27)]),
    7:  (18, [(4, 31)]),
    8:  (22, [(2, 38), (2, 39)]),
    9:  (22, [(3, 36), (2, 37)]),
    10: (26, [(4, 43), (1, 44)]),
}

ALIGNMENT = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
}

# Versions 2-6 carry 7 unused bits after the codeword stream; 1 and 7-13 carry none.
REMAINDER_BITS = {1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0}


# ----------------------------------------------------------- GF(256) arithmetic

EXP = [0] * 512
LOG = [0] * 256
_x = 1
for _i in range(255):
    EXP[_i] = _x
    LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:            # x^8 + x^4 + x^3 + x^2 + 1
        _x ^= 0x11D
for _i in range(255, 512):
    EXP[_i] = EXP[_i - 255]


def gf_mul(a, b):
    if a == 0 or b == 0:
        return 0
    return EXP[LOG[a] + LOG[b]]


def rs_generator(degree):
    """Generator polynomial (x - a^0)(x - a^1)...(x - a^(degree-1))."""
    poly = [1]
    for i in range(degree):
        poly.append(0)
        for j in range(len(poly) - 1, 0, -1):
            poly[j] ^= gf_mul(poly[j - 1], EXP[i])
    return poly


def rs_remainder(data, degree):
    """Reed-Solomon error-correction codewords for one block."""
    gen = rs_generator(degree)
    rem = [0] * degree
    for byte in data:
        factor = byte ^ rem[0]
        rem = rem[1:] + [0]
        for i, g in enumerate(gen[1:]):
            rem[i] ^= gf_mul(g, factor)
    return rem


# ------------------------------------------------------------------- encoding

def choose_version(length):
    for version in range(1, 11):
        _, groups = EC_M[version]
        capacity = sum(count * size for count, size in groups)
        # mode indicator (4 bits) + character count (8 bits here) + payload
        if length + 2 <= capacity:
            return version
    raise ValueError(f'{length} bytes is more than this encoder handles (max version 10)')


def encode_data(payload, version):
    """Mode + length + payload + terminator + padding, as codewords."""
    _, groups = EC_M[version]
    capacity = sum(count * size for count, size in groups)

    bits = []

    def put(value, width):
        for i in range(width - 1, -1, -1):
            bits.append((value >> i) & 1)

    put(0b0100, 4)                       # byte mode
    put(len(payload), 8)                 # count is 8 bits for versions 1-9
    for byte in payload:
        put(byte, 8)

    put(0, min(4, capacity * 8 - len(bits)))   # terminator
    while len(bits) % 8:
        bits.append(0)

    codewords = [int(''.join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]
    pad = [0xEC, 0x11]                   # alternating, always starting at 0xEC
    i = 0
    while len(codewords) < capacity:
        codewords.append(pad[i % 2])
        i += 1
    return codewords


def interleave(codewords, version):
    """Split into blocks, append EC per block, then interleave both."""
    ec_len, groups = EC_M[version]
    blocks, pos = [], 0
    for count, size in groups:
        for _ in range(count):
            blocks.append(codewords[pos:pos + size])
            pos += size
    ec_blocks = [rs_remainder(b, ec_len) for b in blocks]

    out = []
    for i in range(max(len(b) for b in blocks)):
        for b in blocks:
            if i < len(b):
                out.append(b[i])
    for i in range(ec_len):
        for b in ec_blocks:
            out.append(b[i])
    return out


# ------------------------------------------------------------------ placement

def build_matrix(version):
    """Empty grid plus a parallel map of which cells are function patterns."""
    size = version * 4 + 17
    grid = [[0] * size for _ in range(size)]
    fixed = [[False] * size for _ in range(size)]

    def finder(row, col):
        for r in range(-1, 8):
            for c in range(-1, 8):
                rr, cc = row + r, col + c
                if not (0 <= rr < size and 0 <= cc < size):
                    continue
                edge = r in (0, 6) and 0 <= c <= 6
                side = c in (0, 6) and 0 <= r <= 6
                core = 2 <= r <= 4 and 2 <= c <= 4
                grid[rr][cc] = 1 if (edge or side or core) else 0
                fixed[rr][cc] = True

    finder(0, 0)
    finder(0, size - 7)
    finder(size - 7, 0)

    for i in range(8, size - 8):        # timing patterns
        bit = 1 if i % 2 == 0 else 0
        grid[6][i] = bit
        fixed[6][i] = True
        grid[i][6] = bit
        fixed[i][6] = True

    centres = ALIGNMENT[version]
    for r in centres:
        for c in centres:
            if fixed[r][c]:             # skips the three finder corners
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    grid[r + dr][c + dc] = 1 if max(abs(dr), abs(dc)) != 1 else 0
                    fixed[r + dr][c + dc] = True

    grid[size - 8][8] = 1               # always-dark module
    fixed[size - 8][8] = True

    for i in range(9):                  # reserve format information
        if not fixed[8][i]:
            fixed[8][i] = True
        if not fixed[i][8]:
            fixed[i][8] = True
    for i in range(8):
        fixed[8][size - 1 - i] = True
        fixed[size - 1 - i][8] = True

    if version >= 7:                    # reserve version information
        for i in range(6):
            for j in range(3):
                fixed[size - 11 + j][i] = True
                fixed[i][size - 11 + j] = True

    return grid, fixed, size


def place_data(grid, fixed, size, bitstream):
    """Two-module-wide columns, zigzagging up and down, skipping column 6."""
    idx = 0
    col = size - 1
    upward = True
    while col > 0:
        if col == 6:
            col -= 1
        rows = range(size - 1, -1, -1) if upward else range(size)
        for row in rows:
            for c in (col, col - 1):
                if fixed[row][c]:
                    continue
                grid[row][c] = bitstream[idx] if idx < len(bitstream) else 0
                idx += 1
        upward = not upward
        col -= 2


MASKS = [
    lambda r, c: (r + c) % 2 == 0,
    lambda r, c: r % 2 == 0,
    lambda r, c: c % 3 == 0,
    lambda r, c: (r + c) % 3 == 0,
    lambda r, c: (r // 2 + c // 3) % 2 == 0,
    lambda r, c: (r * c) % 2 + (r * c) % 3 == 0,
    lambda r, c: ((r * c) % 2 + (r * c) % 3) % 2 == 0,
    lambda r, c: ((r + c) % 2 + (r * c) % 3) % 2 == 0,
]


def format_bits(mask):
    """15-bit format information for EC level M with the given mask."""
    value = (0b00 << 3) | mask          # 00 = level M
    rem = value << 10
    for i in range(4, -1, -1):
        if rem & (1 << (i + 10)):
            rem ^= 0x537 << i
    return ((value << 10) | rem) ^ 0b101010000010010


def version_bits(version):
    rem = version << 12
    for i in range(5, -1, -1):
        if rem & (1 << (i + 12)):
            rem ^= 0x1F25 << i
    return (version << 12) | rem


def apply_format(grid, size, mask):
    """Both copies of the 15 format bits.

    The two copies run in opposite directions around the finders, which is easy
    to get subtly wrong: writing the first copy with the same row/column order
    as the second reverses it, and the code still looks symmetrical.
    """
    bits = format_bits(mask)
    for i in range(15):
        bit = (bits >> i) & 1
        if i < 6:
            grid[i][8] = bit
        elif i == 6:
            grid[7][8] = bit
        elif i == 7:
            grid[8][8] = bit
        elif i == 8:
            grid[8][7] = bit
        else:
            grid[8][14 - i] = bit
        if i < 8:
            grid[8][size - 1 - i] = bit
        else:
            grid[size - 15 + i][8] = bit


def apply_version(grid, size, version):
    if version < 7:
        return
    bits = version_bits(version)
    for i in range(18):
        bit = (bits >> i) & 1
        r, c = i // 3, i % 3
        grid[size - 11 + c][r] = bit
        grid[r][size - 11 + c] = bit


def _finder_patterns(history, size):
    """How many finder-like 1:1:3:1:1 runs the last seven runs describe."""
    n = history[1]
    if n <= 0:
        return 0
    core = history[2] == n and history[3] == n * 3 and history[4] == n and history[5] == n
    if not core:
        return 0
    return ((1 if history[0] >= n * 4 and history[6] >= n else 0)
            + (1 if history[6] >= n * 4 and history[0] >= n else 0))


def _add_run(history, length, size):
    if history[0] == 0:
        length += size          # the light quiet zone counts as part of the run
    history[:] = [length] + history[:6]


def _line_penalty(line, size):
    """Rules 1 and 3 along a single row or column."""
    score = 0
    history = [0] * 7
    colour = 0
    run = 0
    for cell in line:
        if cell == colour:
            run += 1
            if run == 5:
                score += 3
            elif run > 5:
                score += 1
        else:
            _add_run(history, run, size)
            if not colour:
                score += _finder_patterns(history, size) * 40
            colour = cell
            run = 1
    if colour:
        _add_run(history, run, size)
        run = 0
    _add_run(history, run + size, size)
    score += _finder_patterns(history, size) * 40
    return score


def penalty(grid, size):
    """The four mask-evaluation rules from the specification."""
    score = 0
    for row in grid:
        score += _line_penalty(row, size)
    for col in zip(*grid):
        score += _line_penalty(list(col), size)

    for r in range(size - 1):           # rule 2: same-colour 2x2 blocks
        for c in range(size - 1):
            if len({grid[r][c], grid[r][c + 1], grid[r + 1][c], grid[r + 1][c + 1]}) == 1:
                score += 3

    # Rule 4: how far the dark/light balance strays from 50%, in 5% steps.
    dark = sum(sum(row) for row in grid)
    total = size * size
    score += (-(-abs(dark * 20 - total * 10) // total) - 1) * 10
    return score


def make_matrix(text):
    payload = text.encode('utf-8')
    version = choose_version(len(payload))
    codewords = interleave(encode_data(payload, version), version)

    bitstream = []
    for cw in codewords:
        for i in range(7, -1, -1):
            bitstream.append((cw >> i) & 1)
    bitstream.extend([0] * REMAINDER_BITS[version])

    best = None
    for mask in range(8):
        grid, fixed, size = build_matrix(version)
        place_data(grid, fixed, size, bitstream)
        for r in range(size):
            for c in range(size):
                if not fixed[r][c] and MASKS[mask](r, c):
                    grid[r][c] ^= 1
        apply_format(grid, size, mask)
        apply_version(grid, size, version)
        score = penalty(grid, size)
        if best is None or score < best[0]:
            best = (score, grid)
    return best[1]


def to_svg(matrix, quiet=4, scale=8):
    """One <path> of squares — no per-module elements, so the file stays small."""
    size = len(matrix)
    total = (size + quiet * 2) * scale
    parts = []
    for r, row in enumerate(matrix):
        for c, cell in enumerate(row):
            if cell:
                x = (c + quiet) * scale
                y = (r + quiet) * scale
                parts.append(f'M{x} {y}h{scale}v{scale}h-{scale}z')
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{total}" height="{total}" '
        f'viewBox="0 0 {total} {total}" shape-rendering="crispEdges" role="img">\n'
        f'<rect width="{total}" height="{total}" fill="#fff"/>\n'
        f'<path fill="#000" d="{"".join(parts)}"/>\n</svg>\n'
    )


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    svg = to_svg(make_matrix(sys.argv[1]))
    with open(sys.argv[2], 'w') as fh:
        fh.write(svg)
    print(f'wrote {sys.argv[2]} for {sys.argv[1]}')
