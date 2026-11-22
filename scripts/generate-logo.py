# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""Reproduce assets/logo.png from the product mark's vector geometry.

Run without arguments to write the image, or with --check to compare pixels.
"""

import math
import os
import sys
import struct
import zlib

SIZE = 1024.0
CORNER_R = 229.0
STROKE = 70.0
HW = STROKE / 2.0

APEX = (512, 274)
VALLEY = (512, 800)
FOOT_L, FOOT_R = (180, 845), (844, 845)
BAR_Y = 162
BAR = [(405, BAR_Y), (619, BAR_Y)]
# clearance between the bar's underside and the top of the tip's round join,
# kept at ~60% of the stroke so the two never read as one shape
BAR_GAP = (APEX[1] - HW) - (BAR_Y + HW)


def shoulder(foot):
    """Where the inner arm crosses the leg. The inner V mirrors the outer legs,
    so by symmetry the crossing sits halfway between apex and valley."""
    sy = (APEX[1] + VALLEY[1]) / 2.0
    sx = APEX[0] + (foot[0] - APEX[0]) * (sy - APEX[1]) / (foot[1] - APEX[1])
    return (round(sx, 1), sy)


SHOULDER_L, SHOULDER_R = shoulder(FOOT_L), shoulder(FOOT_R)


def mark_box():
    """viewBox for the bare mark: the glyph's bounding box."""
    x0, x1 = FOOT_L[0] - HW, FOOT_R[0] + HW
    y0, y1 = BAR_Y - HW, FOOT_L[1] + HW
    return ("%g %g %g %g" % (x0, y0, x1 - x0, y1 - y0), int(x1 - x0), int(y1 - y0))

# How the tip meets the M, i.e. what the boundary between the two colours looks
# like. Whoever is painted last owns the joint:
#   flat      tip on top, butt cap on the shoulder — cut across the leg, and it
#             shaves off the M's corner
#   round     tip on top, round cap — arc bulging down into the M
#   tangent   as round, raised half a stroke so the arc just touches the shoulder
#   round-up  M on top, round join — its round shoulder bulges up into the tip
#   flat-up   M on top, legs run half a stroke past the shoulder, cut flat
#   miter-up  M on top, sharp (miter) join — the corner runs out to a point and
#             the boundary lies along the inner arm's outer edge, i.e. parallel
#             to the M's two middle strokes
JOINT = "miter-up"
JOINT_STYLES = {
    "flat": dict(lift=0.0, cap="butt", m_on_top=False, join="round"),
    "round": dict(lift=0.0, cap="round", m_on_top=False, join="round"),
    "tangent": dict(lift=HW, cap="round", m_on_top=False, join="round"),
    "round-up": dict(lift=0.0, cap="butt", m_on_top=True, join="round"),
    "flat-up": dict(lift=HW, cap="butt", m_on_top=True, join="round"),
    "miter-up": dict(lift=0.0, cap="butt", m_on_top=True, join="miter"),
}


def along_leg(shoulder, lift):
    """Walk `lift` units from a shoulder towards the apex."""
    dx, dy = APEX[0] - shoulder[0], APEX[1] - shoulder[1]
    n = math.hypot(dx, dy)
    return (shoulder[0] + dx / n * lift, shoulder[1] + dy / n * lift)


def parts(joint=None):
    """(name, polyline, cap, join), painted in order — the last one drawn owns
    the shoulder, so its outline is what the colour boundary follows."""
    s = JOINT_STYLES[joint or JOINT]
    lift, join = s["lift"], s["join"]
    bar = [("bar", BAR, "round", "round")]

    if not s["m_on_top"]:
        body = [("body", [FOOT_L, SHOULDER_L, VALLEY, SHOULDER_R, FOOT_R],
                 "round", "round")]
        tip = [("tip", [along_leg(SHOULDER_L, lift), APEX,
                        along_leg(SHOULDER_R, lift)], s["cap"], "round")]
        return body + tip + bar

    # M on top: the tip runs down to the shoulders and is painted over.
    tip = [("tip", [SHOULDER_L, APEX, SHOULDER_R], "butt", "round")]
    if join == "miter":
        # each half is one stroke so the shoulder is a real join and can be
        # mitred; they overlap at the valley, which stays round
        body = [("body", [FOOT_L, SHOULDER_L, VALLEY], "round", "miter"),
                ("body", [FOOT_R, SHOULDER_R, VALLEY], "round", "miter")]
    else:
        body = [("body", [FOOT_L, SHOULDER_L, VALLEY, SHOULDER_R, FOOT_R],
                 "round", "round")]
        # stubs carry the M past the shoulder and stop flat there
        body += [("body", [along_leg(s2, -lift), along_leg(s2, lift)], "butt", "round")
                 for s2 in (SHOULDER_L, SHOULDER_R) if lift]
    return tip + body + bar


# name, group, label, background, body, tip, bar
V = lambda name, group, label, bg, body, tip, bar: dict(
    name=name, group=group, label=label, bg=bg, body=body, tip=tip, bar=bar)


def grad(c1, c2, angle=90):
    """A gradient paint spec, valid for the tile or for any stroked part.

    angle: 0 = left-to-right, 90 = top-to-bottom. A bare (c1, c2) tuple is the
    original top-to-bottom form and is still accepted everywhere.
    """
    return ("grad", c1, c2, angle)


W = "#FFFFFF"

VARIANT = V("logo", "", "", "#47A3E2", W, W, W)


# --- svg --------------------------------------------------------------------
def svg(variant, transparent=False, joint=None, box=None, inset=0.0):
    name = variant["name"]
    bg = variant["bg"]
    # the bare mark is cropped to the glyph's bounding box
    box = box or (mark_box() if transparent else ("0 0 1024 1024", 1024, 1024))
    out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s" '
           'width="%d" height="%d">' % box,
           '  <title>%s</title>' % variant["label"]]
    defs = []

    def paint_of(spec, ident, user_space):
        """A fill/stroke value, registering a gradient def when needed.

        Stroke gradients must be userSpaceOnUse: under the default
        objectBoundingBox each path gets its own box, so the ramp would
        restart at every seam between body, tip and bar.
        """
        gr = as_grad(spec)
        if gr is None:
            return spec
        c1, c2, angle = gr
        if user_space:
            _, mw, mh = mark_box()
            p1, p2 = grad_axis(angle, (FOOT_L[0] - HW, BAR_Y - HW,
                                       float(mw), float(mh)))
            coords = ('x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f" '
                      'gradientUnits="userSpaceOnUse"' % (p1 + p2))
        else:
            p1, p2 = grad_axis(angle, (0.0, 0.0, 1.0, 1.0))
            coords = 'x1="%.4f" y1="%.4f" x2="%.4f" y2="%.4f"' % (p1 + p2)
        defs.append('    <linearGradient id="%s" %s>'
                    '<stop offset="0" stop-color="%s"/>'
                    '<stop offset="1" stop-color="%s"/></linearGradient>'
                    % (ident, coords, c1, c2))
        return "url(#%s)" % ident

    paint = paint_of(bg, "bg-" + name, False)
    strokes = {p: paint_of(variant[p], "%s-%s" % (p, name), True)
               for p in ("body", "tip", "bar")}
    if defs:
        out += ['  <defs>'] + defs + ['  </defs>']

    if not transparent:
        if inset:
            out.append('  <g transform="translate(%g %g) scale(%g)">'
                       % (inset * SIZE, inset * SIZE, 1 - 2 * inset))
        out.append('  <rect width="1024" height="1024" rx="229" ry="229" fill="%s"/>' % paint)
        if inset:
            out.append('  </g>')
    if inset:
        out.append('  <g transform="translate(%g %g) scale(%g)">'
                   % (inset * SIZE, inset * SIZE, 1 - 2 * inset))
    out.append('  <g fill="none" stroke-width="70" stroke-miterlimit="8">')
    for part, points, cap, join in parts(joint):
        d = "M " + " L ".join("%.1f %.1f" % p for p in points)
        out.append('    <path d="%s" stroke="%s" stroke-linecap="%s" '
                   'stroke-linejoin="%s"/>' % (d, strokes[part], cap, join))
    out.append('  </g>')
    if inset:
        out.append('  </g>')
    out += ['</svg>', '']
    return "\n".join(out)


# --- png --------------------------------------------------------------------
def rgb(h):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def as_grad(spec):
    """Normalise a paint spec to (c1, c2, angle) or None if it is flat.

    A bare 2-tuple is the original top-to-bottom form and stays valid.
    """
    if isinstance(spec, str):
        return None
    if spec[0] == "grad":
        return (spec[1], spec[2], spec[3] if len(spec) > 3 else 90)
    return (spec[0], spec[1], 90)


def grad_axis(angle, box):
    """The two endpoints of the gradient axis, matching how SVG maps a
    linearGradient onto a box: the unit-square endpoints scaled onto it."""
    x0, y0, w, h = box
    a = math.radians(angle)
    cx, sy = math.cos(a), math.sin(a)
    p1 = (x0 + (0.5 - cx / 2) * w, y0 + (0.5 - sy / 2) * h)
    p2 = (x0 + (0.5 + cx / 2) * w, y0 + (0.5 + sy / 2) * h)
    return p1, p2


def ramp(spec, box):
    """Compile a paint spec into f(x, y) -> (r, g, b)."""
    gr = as_grad(spec)
    if gr is None:
        c = rgb(spec)
        return lambda x, y: c
    ca, cb, angle = rgb(gr[0]), rgb(gr[1]), gr[2]
    (px, py), (qx, qy) = grad_axis(angle, box)
    dx, dy = qx - px, qy - py
    den = dx * dx + dy * dy or 1.0

    def f(x, y):
        t = ((x - px) * dx + (y - py) * dy) / den
        t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
        return (ca[0] + (cb[0] - ca[0]) * t,
                ca[1] + (cb[1] - ca[1]) * t,
                ca[2] + (cb[2] - ca[2]) * t)
    return f


def miter_rhombus(p, v, n):
    """The wedge a miter join fills at vertex `v`, between segments p->v->n.

    Returned as the full rhombus where the two stroke bands' infinite strips
    cross, not just the wedge above the vertex: the extra half sits inside the
    two bands, so this overlaps them instead of merely abutting them. Abutting
    shapes each cover ~50% of the pixels along the shared edge and the union
    would show a hairline of whatever is underneath. Returns None if straight.
    """
    d1 = (v[0] - p[0], v[1] - p[1])
    d2 = (n[0] - v[0], n[1] - v[1])
    l1, l2 = math.hypot(*d1), math.hypot(*d2)
    d1, d2 = (d1[0] / l1, d1[1] / l1), (d2[0] / l2, d2[1] / l2)
    cross = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(cross) < 1e-9:
        return None
    k = HW / cross
    pts = [(v[0] + k * (s1 * d2[0] - s2 * d1[0]),
            v[1] + k * (s1 * d2[1] - s2 * d1[1]))
           for s1 in (1, -1) for s2 in (1, -1)]
    pts.sort(key=lambda q: math.atan2(q[1] - v[1], q[0] - v[0]))
    return pts


def prims(joint=None):
    """Flatten the parts into drawing primitives with bounding boxes."""
    out = []
    for part, points, cap, join in parts(joint):
        for i in range(len(points) - 1):
            (ax, ay), (bx, by) = points[i], points[i + 1]
            ra = cap == "round" if i == 0 else join == "round"
            rb = cap == "round" if i == len(points) - 2 else join == "round"
            out.append((part, "seg", (ax, ay, bx, by, ra, rb),
                        (min(ax, bx) - HW - 2, min(ay, by) - HW - 2,
                         max(ax, bx) + HW + 2, max(ay, by) + HW + 2)))
        if join == "miter":
            for i in range(1, len(points) - 1):
                q = miter_rhombus(points[i - 1], points[i], points[i + 1])
                if q:
                    xs, ys = [p[0] for p in q], [p[1] for p in q]
                    out.append((part, "poly", q,
                                (min(xs) - 2, min(ys) - 2, max(xs) + 2, max(ys) + 2)))
    return out


_PRIMS = {}


def prims_for(joint):
    joint = joint or JOINT
    if joint not in _PRIMS:
        _PRIMS[joint] = prims(joint)
    return _PRIMS[joint]


def seg_sdf(px, py, ax, ay, bx, by, ra, rb):
    vx, vy = bx - ax, by - ay
    length = math.hypot(vx, vy)
    ux, uy = vx / length, vy / length
    wx, wy = px - ax, py - ay
    s = wx * ux + wy * uy                      # axial position, 0..length
    dp = abs(wx * uy - wy * ux)                # perpendicular distance
    d = max(dp - HW, -s, s - length)           # band with butt ends
    if ra:
        d = min(d, math.hypot(wx, wy) - HW)
    if rb:
        d = min(d, math.hypot(px - bx, py - by) - HW)
    return d


def poly_sdf(px, py, pts):
    """Exact distance to a convex polygon, negative inside."""
    best = 1e18
    pos = neg = False
    for i in range(len(pts)):
        ax, ay = pts[i]
        bx, by = pts[(i + 1) % len(pts)]
        vx, vy = bx - ax, by - ay
        wx, wy = px - ax, py - ay
        t = (wx * vx + wy * vy) / (vx * vx + vy * vy)
        t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
        dx, dy = wx - t * vx, wy - t * vy
        best = min(best, math.sqrt(dx * dx + dy * dy))
        if vx * wy - vy * wx > 0.0:            # same side of every edge = inside,
            pos = True                         # whichever way the quad is wound
        else:
            neg = True
    return best if (pos and neg) else -best


def render(variant, size, transparent=False, joint=None, inset=0.0):
    k = 1.0 - 2.0 * inset
    scale = size / SIZE * k                    # pixels per design unit
    aa = 1.0 / scale                           # antialiasing width, design units
    origin = inset * SIZE * (size / SIZE)      # margin, in pixels
    half = SIZE / 2.0
    inner = half - CORNER_R
    prim = prims_for(joint)
    order = list(dict.fromkeys(p for p, _, _, _ in prim))
    # the tile gradient spans the canvas; a stroke gradient spans the glyph's
    # bounding box, so it matches the SVG's userSpaceOnUse ramp exactly
    _, mw, mh = mark_box()
    mbox = (FOOT_L[0] - HW, BAR_Y - HW, float(mw), float(mh))
    bg_paint = ramp(variant["bg"], (0.0, 0.0, SIZE, SIZE))
    part_paint = {p: ramp(variant[p], mbox) for p in order}

    rows = []
    for iy in range(size):
        y = (iy + 0.5 - origin) / scale
        row = bytearray(b"\x00")               # PNG filter: none
        for ix in range(size):
            x = (ix + 0.5 - origin) / scale

            cover = {}
            for part, kind, data, (x0, y0, x1, y1) in prim:
                if x < x0 or x > x1 or y < y0 or y > y1:
                    continue
                d = (seg_sdf(x, y, *data) if kind == "seg"
                     else poly_sdf(x, y, data))
                if d < aa:
                    c = min(1.0, max(0.0, 0.5 - d / aa))
                    if c > cover.get(part, 0.0):
                        cover[part] = c

            if transparent:
                alpha = 0.0
                r = g = b = 0.0
            else:
                qx = max(abs(x - half) - inner, 0.0)
                qy = max(abs(y - half) - inner, 0.0)
                d = math.hypot(qx, qy) - CORNER_R
                alpha = min(1.0, max(0.0, 0.5 - d / aa))
                r, g, b = bg_paint(x, y)

            for part in order:
                c = cover.get(part, 0.0)
                if not c:
                    continue
                if not transparent:
                    c = min(c, alpha)          # never paint outside the tile
                else:
                    alpha = max(alpha, c)
                cr, cg, cb = part_paint[part](x, y)
                r += (cr - r) * c
                g += (cg - g) * c
                b += (cb - b) * c

            px = (r, g, b, alpha * 255)
            row += bytes(0 if c < 0 else (255 if c > 255 else int(c + .5)) for c in px)
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path, size, raw, height=None, rgb=False):
    with open(path, "wb") as handle:
        write_png_stream(handle, size, raw, height=height, rgb=rgb)


def write_png_stream(handle, size, raw, height=None, rgb=False):
    """Write raw scanlines out as a PNG.

    Defaults to the square RGBA image every icon is; `height` and `rgb` exist
    for the contact sheet, which is neither.
    """
    color_type = 2 if rgb else 6           # 2 = RGB, 6 = RGBA
    h = height or size

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    handle.write(b"\x89PNG\r\n\x1a\n")
    handle.write(chunk(b"IHDR",
                       struct.pack(">IIBBBBB", size, h, 8, color_type, 0, 0, 0)))
    handle.write(chunk(b"IDAT", zlib.compress(raw, 9)))
    handle.write(chunk(b"IEND", b""))


def committed_scanlines(png):
    """Scanlines of a PNG this file wrote, or None if its header differs.

    The check compares these to the fresh render rather than file bytes: IDAT
    is whatever the running zlib produced, so a runner-image upgrade would
    otherwise report drift that no one drew.
    """
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    pos, chunks = 8, []
    while pos + 12 <= len(png):
        length, tag = struct.unpack(">I4s", png[pos:pos + 8])
        data = png[pos + 8:pos + 8 + length]
        crc = png[pos + 8 + length:pos + 12 + length]
        if len(data) != length or crc != struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF):
            return None
        chunks.append((tag, data))
        pos += 12 + length
    expected = struct.pack(">IIBBBBB", ART_SIZE, ART_SIZE, 8, 6, 0, 0, 0)
    if (pos != len(png)
            or [tag for tag, _ in chunks] != [b"IHDR", b"IDAT", b"IEND"]
            or chunks[0][1] != expected
            or chunks[2][1] != b""):
        return None
    try:
        decoder = zlib.decompressobj()
        scanlines = decoder.decompress(chunks[1][1]) + decoder.flush()
        if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
            return None
        return scanlines
    except zlib.error:
        return None


MACOS_MARGIN = 100 / 1024.0
ART_SIZE = 1024


def main(argv):
    if argv not in ([], ["--check"]):
        print("usage: generate-logo.py [--check]")
        return 2
    raw = render(VARIANT, ART_SIZE, inset=MACOS_MARGIN)
    path = os.path.join(os.path.dirname(__file__), "..", "assets", "logo.png")
    if argv:
        with open(path, "rb") as handle:
            if committed_scanlines(handle.read()) != raw:
                print("logo is out of date; run python3 scripts/generate-logo.py")
                return 1
        print("logo matches the committed artwork")
    else:
        write_png(path, ART_SIZE, raw)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
