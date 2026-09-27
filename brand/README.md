# Lyra brand assets

Vega and the parallelogram — the constellation the assistant is named after. Rendered by
`assets.py` (which uses `brand.py`, a small PNG rasteriser: this machine has no image library, so
shapes are drawn from their distance fields and anti-aliased analytically).

Regenerate everything:

```bash
python3 assets.py . .
```

## Files

| File | Size | Where it goes |
|---|---|---|
| `lyra-avatar-1024.png` | 1024² | Discord (keeps detail for the 128px display) |
| `lyra-avatar-512.png` | 512² | Telegram, and anywhere else asking for a square |
| `lyra-avatar-96.png` | 96² | A favicon or a small embed |
| `lyra-banner-youtube-2560x1440.png` | 2560×1440 | YouTube channel art |
| `lyra-banner-discord-960x540.png` | 960×540 | Discord server or profile banner |
| `lyra-mark.svg` | vector | The source of the mark, for anything new |
| `preview-*.png` | — | Checks, not uploads. See below. |

## Two things the design is built around

**The avatar is cropped to a circle and shown at 40px.** Telegram and Discord both do this. The app
icon's seven stars turn to mush that small, so the mark here is the classical five — Vega plus the
parallelogram — with heavier lines and larger stars. `preview-avatar-40.png` is that check: if a
change survives it, it survives a chat list.

**The banner is mostly cropped away.** YouTube guarantees only the central 1546×423 on every
device; a desktop browser shows the full 2560×1440 and a phone shows the band. So the mark and the
wordmark are sized against the band, and the rest of the canvas carries background only.
`preview-youtube-safe-area.png` is that band cut out of the finished file — everything that has to
be seen is inside it.

## Palette

Taken from `public/icon-512.svg`, so these and the app agree.

| | | |
|---|---|---|
| `#0f172a` | ground | the dark navy everything sits on |
| `#1b2b4d` | lift | a centre glow, so the square reads as depth |
| `#60a5fa` | Vega | the only saturated colour in the mark |
| `#e2e8f0` | stars | the rest of the constellation |
| `#94a3b8` | lines | at 72% on the avatar, 55% on banners |

The app icon at `public/icon-512.svg` is unchanged and still uses the older seven-star figure. If
you want the app and the social profiles to match exactly, that file should be replaced with
`lyra-mark.svg`.
