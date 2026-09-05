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

"""Regenerate the shipped app-icon artwork.

Every PNG under apps/desktop/assets/app-icons/ except `mono.png` comes out of
this file. The mark is not traced, not drawn over stock art, and not generated
by a model: it is a handful of stroked polylines defined by the constants
below, so the provenance of the artwork is the source you are reading.

    python3 scripts/generate-app-icons.py            # rewrite every icon
    python3 scripts/generate-app-icons.py --check    # verify, write nothing

`--check` is what the test harness uses: it re-renders and compares bytes, so
a change to the geometry that is not reflected in the committed PNGs fails.
The harness passes no names, so every shipped tile is compared, and rendering
is spread across all cores to keep that affordable.

There is no SVG rasteriser available in CI, so the PNGs are rendered here by
evaluating the same geometry as signed distance fields — including the miter
wedge a sharp join adds, which a plain capsule union would miss.

Artwork is written at 1024x1024 with a 100px transparent margin on all four
sides. That is the macOS icon grid: the solid block occupies 824/1024 (80.5%)
and the dock scales the canvas without adding padding of its own, so a
full-bleed tile would sit 24% wider than every neighbour.
"""

import io
import math
import os
import sys
from multiprocessing import Pool
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

VARIANTS = [
    # --- 浅蓝系 ---------------------------------------------------------
    V("sky", "蓝", "原色 sky", "#47A3E2", W, W, W),
    V("cyan", "蓝", "青蓝", "#4FC3D9", W, W, W),
    V("ice", "蓝", "冰蓝渐变", ("#9BDCFB", "#4A9FE0"), W, W, W),
    V("pale-inverted", "蓝", "淡底深标", "#DCEEFB", "#2E86D6", "#2E86D6", "#2E86D6"),
    # --- 黑白 -----------------------------------------------------------
    V("ink", "黑白", "墨黑底", "#111315", W, W, W),
    V("paper", "黑白", "纸白底", "#FFFFFF", "#14161A", "#14161A", "#14161A"),
    V("graphite", "黑白", "白底灰尖", "#FFFFFF", "#14161A", "#8A9199", "#14161A"),
    # --- 铅笔 -----------------------------------------------------------
    V("pencil-kraft", "铅笔", "牛皮纸底", "#D9C7A4", "#F5B301", "#14110F", W),
    V("pencil-sky", "铅笔", "天蓝底", "#47A3E2", "#FFC531", "#17191B", W),
    V("pencil-navy", "铅笔", "深蓝底", "#1F3A5F", "#F7C948", "#0B0D10", W),
    # --- 高山 -----------------------------------------------------------
    V("alpine", "高山", "晴空雪山", ("#C8E9FF", "#79C3F0"), "#3E5C76", W, W),
    V("dusk", "高山", "黄昏", ("#FFC48C", "#F4886B"), "#35314C", "#FFF3E4", W),
    V("night", "高山", "夜山", ("#16233A", "#31527A"), "#0C1422", "#E8F1FF", "#DCE8FF"),
    V("forest", "高山", "苍绿", ("#D6ECDD", "#8FC7A8"), "#2C4A3B", W, W),
    # --- 深色 -----------------------------------------------------------
    # ink was the only true dark tile; a mid-tone one glows like a light leak
    # in a dark dock or a dark UI shell.
    V("midnight", "深色", "午夜蓝", "#0A1220", "#9EC7F0", "#E8F2FF", "#5B8DEF"),
    V("carbon", "深色", "纯黑 OLED", "#000000", "#3FA9F5", "#7FD4FF", "#3FA9F5"),
    V("slate", "深色", "石板", "#1E242C", "#8FA6BC", "#DDE7F0", "#6B8299"),
    V("obsidian", "深色", "曜石", grad("#1A1030", "#0A0616", 135),
      "#A78BFA", "#E9E2FF", "#7C5CE0"),
    # --- 霓虹 -----------------------------------------------------------
    # Amber CRT and phosphor green are the terminal's own history, not styling.
    V("neon-cyan", "霓虹", "荧光青", "#0B0F14", "#00E5FF", "#B8FBFF", "#00A8CC"),
    V("matrix", "霓虹", "磷绿", "#050A06", "#39FF14", "#C8FFB8", "#1F9E0A"),
    V("magenta", "霓虹", "品红", "#14091F", "#FF3DCE", "#FFD6F5", "#B01E8E"),
    V("amber-crt", "霓虹", "琥珀 CRT", "#0D0A05", "#FFB000", "#FFE7B0", "#C77A00"),
    # --- 莫兰迪 ---------------------------------------------------------
    V("clay", "莫兰迪", "陶土", "#C97B63", "#FFF6F0", W, "#8E4A36"),
    V("sage", "莫兰迪", "鼠尾草", "#9CAF88", "#2F3D28", "#F4F8EF", "#2F3D28"),
    V("dust", "莫兰迪", "灰粉", "#C4A69C", "#4A362F", "#FBF4F1", "#4A362F"),
    V("fog", "莫兰迪", "雾蓝", "#A8B5BF", "#2B3742", "#F2F6F9", "#2B3742"),
    # --- 暖色 -----------------------------------------------------------
    V("sunset", "暖色", "日落", grad("#FF9A5A", "#FF5E7E", 135), W, "#FFF0E8", W),
    V("amber", "暖色", "琥珀", "#F5A623", "#3D2A08", "#FFF6E2", "#3D2A08"),
    V("terracotta", "暖色", "赤陶", grad("#E2825A", "#C4553C", 135),
      "#FFF2EA", W, "#8E3A26"),
    # --- 自然 -----------------------------------------------------------
    V("ocean", "自然", "深海", grad("#0E4D64", "#1B7A8C", 160), "#DFF6F8", W, W),
    V("moss", "自然", "苔原", grad("#2F4A34", "#1C2E20", 135), "#9FD4A8", W, "#6FA97A"),
    V("desert", "自然", "沙漠", grad("#EBCF9C", "#D89A55", 135),
      "#4A2E16", "#FFF8EC", "#4A2E16"),
    V("glacier", "自然", "冰川", grad("#F0FAFF", "#BFE4F5", 135),
      "#2C5F7C", "#6FB5D8", "#2C5F7C"),
    # --- 金属(描边渐变)------------------------------------------------
    V("gold", "金属", "鎏金", "#141210", grad("#F7E7A0", "#B8860B", 120),
      grad("#FFF8D8", "#D4AF37", 120), grad("#F7E7A0", "#B8860B", 120)),
    V("chrome", "金属", "铬", "#16181C", grad("#F4F7FA", "#8A97A6", 120),
      grad("#FFFFFF", "#B8C4D0", 120), grad("#F4F7FA", "#8A97A6", 120)),
    # --- 高对比 ---------------------------------------------------------
    # Not a style but an obligation: one-colour printing, and 7:1 contrast.
    V("mono-black", "高对比", "纯黑", W, "#000000", "#000000", "#000000"),
    V("mono-white", "高对比", "纯白", "#000000", W, W, W),
    V("hazard", "高对比", "黑黄", "#111111", "#FFD400", "#FFD400", "#FFD400"),
]


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
    fh = handle
    if True:
        fh.write(b"\x89PNG\r\n\x1a\n")
        fh.write(chunk(b"IHDR",
                       struct.pack(">IIBBBBB", size, h, 8, color_type, 0, 0, 0)))
        fh.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        fh.write(chunk(b"IEND", b""))


MACOS_MARGIN = 100 / 1024.0
ART_SIZE = 1024


def art_directory():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "..", "apps", "desktop", "assets", "app-icons")


def _render_one(variant):
    """Render one icon. Top-level so it survives the pickling a Pool does."""
    return variant["name"], render(variant, ART_SIZE, inset=MACOS_MARGIN)


def main(argv):
    check = "--check" in argv
    # Positional names limit the run to a subset. This is a convenience for
    # working on one colourway by hand — the test deliberately passes none, so
    # CI always compares the whole catalogue.
    wanted = {a for a in argv if not a.startswith("-")}
    selected = [v for v in VARIANTS if not wanted or v["name"] in wanted]
    unknown = wanted - {v["name"] for v in VARIANTS}
    if unknown:
        print("unknown icon(s): %s" % ", ".join(sorted(unknown)))
        return 2
    dest = art_directory()
    stale = []
    # Rasterising 38 tiles at 1024px is ~90s of single-threaded signed-distance
    # evaluation, which is the difference between checking the whole catalogue
    # in CI and checking a sample of it. The work is per-icon and pure, so it
    # parallelises exactly.
    workers = min(len(selected), os.cpu_count() or 1)
    if workers > 1:
        with Pool(workers) as pool:
            rendered = pool.map(_render_one, selected)
    else:
        rendered = [_render_one(v) for v in selected]

    for name, raw in rendered:
        path = os.path.join(dest, name + ".png")
        if check:
            buffer = io.BytesIO()
            write_png_stream(buffer, ART_SIZE, raw)
            with open(path, "rb") as handle:
                if handle.read() != buffer.getvalue():
                    stale.append(name)
        else:
            write_png(path, ART_SIZE, raw)
    if not check:
        print("wrote %d icons to %s" % (len(selected), dest))
        return 0
    if stale:
        print("out of date: %s" % ", ".join(stale))
        print("run: python3 scripts/generate-app-icons.py")
        return 1
    print("all %d icons match the committed artwork" % len(selected))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
