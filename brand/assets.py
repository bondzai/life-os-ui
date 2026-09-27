"""Lyra's social assets, built from the app icon's own constellation."""
import math, sys
sys.path.insert(0, sys.argv[1])
from brand import Canvas, hexrgb

# The app icon's palette (public/icon-512.svg), kept so the avatar and the app agree.
INK   = hexrgb('#0f172a')   # deep navy ground
LIFT  = hexrgb('#1b2b4d')   # the centre lift, so the square reads as depth
VEGA  = hexrgb('#60a5fa')   # the bright star, and the only saturated thing in the mark
STAR  = hexrgb('#e2e8f0')   # the rest of the constellation
LINE  = hexrgb('#94a3b8')   # the lines between them
DUST  = hexrgb('#fafafa')   # background stars

# Lyra as the sky actually draws it: Vega, then the little parallelogram.
#
# The app icon stylises this into seven stars with a second pair below the parallelogram. That
# reads at 512px and turns to mush at 40 — which is the size a Telegram chat list shows an avatar.
# Five stars is both the classical figure and the one that survives the crop: fewer, larger, wider
# apart, so the shape stays a constellation instead of collapsing into an outline.
# Vega sits off to one side, joined by a single line — as the sky has it.
#
# Centred above the parallelogram with two symmetric lines, it reads as a house: a square with a
# pitched roof. One stem and a properly slanted rhombus is both what Lyra actually looks like and
# the thing nobody mistakes for a home icon.
VEGA_PT = (196, 120)
PTS = {
    'b': (268, 236),   # the star Vega hangs from
    'c': (392, 286),   # upper-right
    'd': (330, 412),   # lower-right
    'e': (206, 362),   # lower-left
}
EDGES = [(VEGA_PT, PTS['b']),
         (PTS['b'], PTS['c']), (PTS['c'], PTS['d']), (PTS['d'], PTS['e']), (PTS['e'], PTS['b'])]
CENTRE = (294, 266)  # the mark's own centre, which is not the square's

def place(p, cx, cy, k):
    return (cx + (p[0] - CENTRE[0]) * k, cy + (p[1] - CENTRE[1]) * k)

def constellation(c, cx, cy, k, line_w, line_a, radii, glow=True):
    for a, b in EDGES:
        c.line(*place(a, cx, cy, k), *place(b, cx, cy, k), line_w, LINE, line_a)
    if glow:
        vx, vy = place(VEGA_PT, cx, cy, k)
        c.glow(vx, vy, radii['vega'] * 3.6, VEGA, 0.38)
        c.glow(vx, vy, radii['vega'] * 1.9, VEGA, 0.30)
    for key, r in (('b', 'mid'), ('c', 'mid'), ('d', 'low'), ('e', 'low')):
        c.disc(*place(PTS[key], cx, cy, k), radii[r], STAR, 0.95)
    c.disc(*place(VEGA_PT, cx, cy, k), radii['vega'], VEGA)
    c.disc(*place(VEGA_PT, cx, cy, k), radii['vega'] * 0.42, hexrgb('#dbeafe'), 0.9)

# ── The wordmark ────────────────────────────────────────────────────────────────────────────────
# Monoline, drawn at the constellation's own stroke weight so mark and name read as one object.
# Each letter is segments in a unit box (y down), with its advance width.
GLYPHS = {
    'L': (0.60, [((0, 0), (0, 1)), ((0, 1), (0.58, 1))]),
    'Y': (0.92, [((0, 0), (0.46, 0.52)), ((0.92, 0), (0.46, 0.52)), ((0.46, 0.52), (0.46, 1))]),
    'R': (0.78, [((0, 0), (0, 1)), ((0, 0), (0.68, 0)), ((0.68, 0), (0.68, 0.47)),
                 ((0.68, 0.47), (0, 0.47)), ((0.34, 0.47), (0.76, 1))]),
    'A': (0.94, [((0, 1), (0.47, 0)), ((0.47, 0), (0.94, 1)), ((0.20, 0.64), (0.74, 0.64))]),
}

def wordmark(c, text, x, y, cap, weight, color, alpha=1.0, tracking=0.26):
    """Draw `text` with cap height `cap`, top-left at (x, y). Returns the width drawn."""
    cursor = x
    for ch in text:
        adv, segs = GLYPHS[ch]
        for (ax, ay), (bx, by) in segs:
            c.line(cursor + ax * cap, y + ay * cap, cursor + bx * cap, y + by * cap,
                   weight, color, alpha)
        cursor += adv * cap + tracking * cap
    return cursor - tracking * cap - x

def dust(c, w, h, seed=7):
    """A handful of faint background stars. Deterministic, so the file is reproducible."""
    n = max(10, int(w * h / 42000))
    x, out = seed, []
    for _ in range(n):
        x = (1103515245 * x + 12345) % (1 << 31)
        px = (x / (1 << 31)) * w
        x = (1103515245 * x + 12345) % (1 << 31)
        py = (x / (1 << 31)) * h
        x = (1103515245 * x + 12345) % (1 << 31)
        r = 1.0 + (x / (1 << 31)) * (w / 900)
        out.append((px, py, r))
    for px, py, r in out:
        c.disc(px, py, r, DUST, 0.22)

# ── Avatar ──────────────────────────────────────────────────────────────────────────────────────
def avatar(size, path):
    c = Canvas(size, size, INK)
    c.vignette(size * 0.5, size * 0.46, size * 0.72, LIFT, 0.85)
    dust(c, size, size)
    s = size / 512
    # 1.12 fills the circle both platforms crop to while keeping every star clear of the edge, and
    # the weights below are what still read once the file is shown at 40px.
    constellation(
        c, size * 0.5, size * 0.5, 1.12 * s,
        line_w=11.0 * s, line_a=0.72,
        radii={'vega': 30 * s, 'mid': 19 * s, 'low': 16 * s},
    )
    c.png(path)
    return path

# ── Banner ──────────────────────────────────────────────────────────────────────────────────────
def banner(w, h, path, safe_h):
    """A banner laid out inside `safe_h`, the band that is visible on every device.

    YouTube shows the full 2560x1440 only on a desktop browser; a phone sees the central
    1546x423 and a TV somewhere between. Composing to the full canvas puts Vega a long way
    outside that band, so on a phone the banner becomes half a diamond and a word. Everything that
    must be seen is therefore sized and placed against the safe band, and the canvas beyond it
    carries only background — stars and a vignette, which crop away without loss.
    """
    c = Canvas(w, h, INK)
    c.vignette(w * 0.40, h * 0.5, w * 0.58, LIFT, 0.8)
    dust(c, w, h)

    cap = safe_h * 0.355                 # cap height of the wordmark
    weight = max(3.0, safe_h * 0.036)    # one stroke weight for letters and constellation
    # 292 spans the star *centres*; the discs add their radii on top (30 above, 16 below), and
    # sizing to the centres alone is what clipped Vega against the top of the safe band.
    mark_k = (safe_h * 0.88) / (292 + 30 + 16)
    mark_w = (196 + 30 + 16) * mark_k
    gap = cap * 0.80
    text_w = sum(GLYPHS[ch][0] for ch in 'LYRA') * cap + 3 * 0.26 * cap
    x0 = (w - (mark_w + gap + text_w)) / 2
    mid = h / 2

    constellation(
        c, x0 + mark_w / 2, mid, mark_k,
        line_w=weight, line_a=0.55,
        radii={'vega': 30 * mark_k, 'mid': 19 * mark_k, 'low': 16 * mark_k},
    )
    wordmark(c, 'LYRA', x0 + mark_w + gap, mid - cap / 2, cap, weight, hexrgb('#f1f5f9'), 0.97)
    c.png(path)
    return path

def safe_crop(src_w, src_h, safe_w, safe_h, path, out):
    """Re-render only the safe band, to see what a phone actually shows."""
    pass

if __name__ == '__main__':
    out = sys.argv[2]
    print(avatar(1024, f'{out}/lyra-avatar-1024.png'))
    print(avatar(512, f'{out}/lyra-avatar-512.png'))
    print(avatar(96, f'{out}/lyra-avatar-96.png'))
    print(avatar(40, f'{out}/preview-avatar-40.png'))
    # 423 is the height of YouTube's all-devices safe band.
    print(banner(2560, 1440, f'{out}/lyra-banner-youtube-2560x1440.png', safe_h=423))
    # Discord shows its banner whole, so the 'safe band' is just a comfortable proportion.
    print(banner(960, 540, f'{out}/lyra-banner-discord-960x540.png', safe_h=540 * 0.55))
