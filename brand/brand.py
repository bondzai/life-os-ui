"""Render Lyra's brand assets as PNG, with no image library available.

Anti-aliasing is analytic: every shape computes per-pixel coverage from its distance field, so a
star edge is smooth without supersampling a canvas four times the size — which in pure Python would
be the difference between two seconds and two minutes.
"""
import math, struct, zlib

def hexrgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) / 255 for i in (0, 2, 4))

class Canvas:
    def __init__(self, w, h, bg):
        self.w, self.h = w, h
        self.px = [list(bg) for _ in range(w * h)]

    def _blend(self, i, color, a):
        if a <= 0:
            return
        if a > 1:
            a = 1.0
        p = self.px[i]
        p[0] += (color[0] - p[0]) * a
        p[1] += (color[1] - p[1]) * a
        p[2] += (color[2] - p[2]) * a

    def vignette(self, cx, cy, radius, color, strength):
        """A soft lift at the centre, so a flat dark square reads as depth rather than as a hole."""
        for y in range(self.h):
            dy = (y + 0.5 - cy) ** 2
            row = y * self.w
            for x in range(self.w):
                d = math.sqrt((x + 0.5 - cx) ** 2 + dy) / radius
                if d < 1:
                    t = (1 - d) ** 2
                    self._blend(row + x, color, strength * t)

    def disc(self, cx, cy, r, color, alpha=1.0):
        x0, x1 = max(0, int(cx - r - 1)), min(self.w - 1, int(cx + r + 1))
        y0, y1 = max(0, int(cy - r - 1)), min(self.h - 1, int(cy + r + 1))
        for y in range(y0, y1 + 1):
            dy = y + 0.5 - cy
            row = y * self.w
            for x in range(x0, x1 + 1):
                d = math.hypot(x + 0.5 - cx, dy) - r
                cov = 0.5 - d
                if cov > 0:
                    self._blend(row + x, color, alpha * min(1.0, cov))

    def glow(self, cx, cy, r, color, alpha, power=2.2):
        """Falls off to nothing at `r`, so the halo has no visible edge of its own."""
        x0, x1 = max(0, int(cx - r - 1)), min(self.w - 1, int(cx + r + 1))
        y0, y1 = max(0, int(cy - r - 1)), min(self.h - 1, int(cy + r + 1))
        for y in range(y0, y1 + 1):
            dy = (y + 0.5 - cy) ** 2
            row = y * self.w
            for x in range(x0, x1 + 1):
                d = math.sqrt((x + 0.5 - cx) ** 2 + dy) / r
                if d < 1:
                    self._blend(row + x, color, alpha * (1 - d) ** power)

    def line(self, x1, y1, x2, y2, width, color, alpha=1.0):
        """Round-capped, so strokes meeting at a star join cleanly instead of showing a notch."""
        hw = width / 2
        x0, xe = max(0, int(min(x1, x2) - hw - 1)), min(self.w - 1, int(max(x1, x2) + hw + 1))
        y0, ye = max(0, int(min(y1, y2) - hw - 1)), min(self.h - 1, int(max(y1, y2) + hw + 1))
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy or 1.0
        for y in range(y0, ye + 1):
            row = y * self.w
            for x in range(x0, xe + 1):
                px, py = x + 0.5 - x1, y + 0.5 - y1
                t = max(0.0, min(1.0, (px * dx + py * dy) / L2))
                d = math.hypot(px - t * dx, py - t * dy) - hw
                cov = 0.5 - d
                if cov > 0:
                    self._blend(row + x, color, alpha * min(1.0, cov))

    def rounded_mask(self, radius):
        """Flatten the corners to transparent-looking background — an app-icon squircle."""
        pass

    def png(self, path):
        raw = bytearray()
        for y in range(self.h):
            raw.append(0)  # filter type 0
            row = y * self.w
            for x in range(self.w):
                p = self.px[row + x]
                raw += bytes((
                    max(0, min(255, round(p[0] * 255))),
                    max(0, min(255, round(p[1] * 255))),
                    max(0, min(255, round(p[2] * 255))),
                ))

        def chunk(tag, data):
            return (struct.pack('>I', len(data)) + tag + data
                    + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

        with open(path, 'wb') as f:
            f.write(b'\x89PNG\r\n\x1a\n')
            f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', self.w, self.h, 8, 2, 0, 0, 0)))
            f.write(chunk(b'IDAT', zlib.compress(bytes(raw), 9)))
            f.write(chunk(b'IEND', b''))
