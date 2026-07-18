#!/usr/bin/env python3
"""Generate the Nimbus Web Clipper extension icons from scratch.

No third-party deps: shapes are rasterized with 4x supersampling and encoded to
PNG via the stdlib `zlib`. Concept: a light Nimbus cloud + a bookmark/clip tag on
a solid brand-blue rounded-square tile. Run: `python scripts/gen-icons.py`.
"""

import math
import os
import struct
import zlib

# --- palette (matches the extension UI: brand blue #2d6cdf / light #6ea8ff) ---
TILE_TOP = (0x3b, 0x78, 0xea)   # subtle vertical gradient, top
TILE_BOT = (0x27, 0x5f, 0xd4)   # ...bottom
CLOUD = (0xf6, 0xf9, 0xff)      # near-white cloud
CLIP = (0xe6, 0xef, 0xff)       # very light blue bookmark fill
KEYLINE = TILE_BOT              # blue gap that separates clip from cloud

SS = 4  # supersampling factor


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_rect(x, y, x0, y0, x1, y1, r):
    """Point-in-rounded-rectangle test (unit coords)."""
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    # inside the bounding box: only the four corner quadrants can fall outside,
    # and each is a quarter-circle test against that corner's centre
    if x < x0 + r and y < y0 + r:
        return (x - (x0 + r)) ** 2 + (y - (y0 + r)) ** 2 <= r * r
    if x > x1 - r and y < y0 + r:
        return (x - (x1 - r)) ** 2 + (y - (y0 + r)) ** 2 <= r * r
    if x < x0 + r and y > y1 - r:
        return (x - (x0 + r)) ** 2 + (y - (y1 - r)) ** 2 <= r * r
    if x > x1 - r and y > y1 - r:
        return (x - (x1 - r)) ** 2 + (y - (y1 - r)) ** 2 <= r * r
    return True


def in_circle(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


CLOUD_PUFFS = [
    (0.28, 0.46, 0.150),
    (0.44, 0.355, 0.190),
    (0.605, 0.445, 0.150),
]


def in_cloud(x, y):
    for cx, cy, r in CLOUD_PUFFS:
        if in_circle(x, y, cx, cy, r):
            return True
    # flat base so the bottom reads as a cloud, not a blob of circles
    return rounded_rect(x, y, 0.19, 0.45, 0.665, 0.605, 0.055)


def in_bookmark(x, y, inflate=0.0):
    """Bookmark tag at lower-right: rounded-top rect minus a bottom V-notch."""
    x0, y0, x1, y1 = 0.545 - inflate, 0.475 - inflate, 0.815 + inflate, 0.825 + inflate
    if not rounded_rect(x, y, x0, y0, x1, y1, 0.045):
        return False
    # carve the notch: a triangle removed from the bottom, apex pointing up
    notch_top = 0.735 - inflate  # apex y (higher = deeper notch)
    cx = (x0 + x1) / 2
    if y >= notch_top:
        # width of removed region shrinks to 0 at the apex
        frac = (y - notch_top) / (y1 - notch_top)
        half = frac * (x1 - x0) / 2
        if abs(x - cx) <= half:
            return False
    return True


def sample(x, y, h):
    """Return (r,g,b,a) for a point in unit coords. h = vertical grad position."""
    # tile
    if not rounded_rect(x, y, 0.0, 0.0, 1.0, 1.0, 0.22):
        return (0, 0, 0, 0)
    tile = lerp(TILE_TOP, TILE_BOT, h)

    # draw order: cloud, then blue keyline around clip, then clip fill on top
    color = tile
    if in_cloud(x, y):
        color = CLOUD
    # keyline: pixels just outside the bookmark get the blue gap (separates it
    # from the cloud it overlaps)
    if in_bookmark(x, y, inflate=0.022) and not in_bookmark(x, y):
        color = KEYLINE
    if in_bookmark(x, y):
        color = CLIP
    return (color[0], color[1], color[2], 255)


def render(size):
    hi = size * SS
    # accumulate supersampled coverage into the final pixels
    out = bytearray(size * size * 4)
    acc = [[0, 0, 0, 0] for _ in range(size * size)]
    for hy in range(hi):
        fy = (hy + 0.5) / hi
        for hx in range(hi):
            fx = (hx + 0.5) / hi
            r, g, b, a = sample(fx, fy, fy)
            idx = (hy // SS) * size + (hx // SS)
            p = acc[idx]
            # premultiply so edge antialiasing against transparency is correct
            p[0] += r * a
            p[1] += g * a
            p[2] += b * a
            p[3] += a
    n = SS * SS
    for i in range(size * size):
        p = acc[i]
        a = p[3] // n
        if a == 0:
            rgba = (0, 0, 0, 0)
        else:
            rgba = (p[0] // p[3], p[1] // p[3], p[2] // p[3], a)
        out[i * 4:i * 4 + 4] = bytes(rgba)
    return bytes(out)


def write_png(path, size, rgba):
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0
        raw.extend(rgba[y * size * 4:(y + 1) * size * 4])
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, "..", "src", "icons")
    for size in (16, 48, 128):
        rgba = render(size)
        path = os.path.join(out_dir, f"icon-{size}.png")
        write_png(path, size, rgba)
        print(f"wrote {os.path.normpath(path)} ({size}x{size})")


if __name__ == "__main__":
    main()
