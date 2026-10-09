#!/usr/bin/env python3
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

"""Draws crates/pet/fixtures/demo-pet: a maka.pet/v1 pack for tests and
screenshots of the companion (Maka ships no pet). A round blob, 64 px
frames, four columns by three rows: idle (0-1), working (2-5, with a spark),
needs input (6-7, with a "!" bubble), ready (8-9, once), blocked (10-11,
red). Standard library only.

    scripts/demo-pet.py
"""
import json
import math
import os
import struct
import zlib

FRAME, COLUMNS, ROWS, SAMPLES = 64, 4, 3, 4
HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "..", "crates", "pet", "fixtures", "demo-pet")

BLUE, RED, INK, WHITE, AMBER = (95, 182, 255), (255, 110, 110), (24, 28, 36), (255, 255, 255), (255, 196, 64)


def frame_shapes(index):
    """(body centre y, body radius x, radius y, colour, extras) for a frame."""
    colour, dy, sx, sy, extras = BLUE, 0.0, 1.0, 1.0, []
    if index in (0, 1):  # idle: breathing
        sy, sx = (1.0, 1.0) if index == 0 else (0.94, 1.04)
    elif 2 <= index <= 5:  # working: a hop and a spark
        dy = [-2, -7, -2, 2][index - 2]
        extras.append(("spark", index - 2))
    elif index in (6, 7):  # needs input: a question bubble
        extras.append(("bubble", index - 6))
    elif index in (8, 9):  # ready: a jump
        dy, extras = (-10 if index == 8 else -4), [("smile", 0)]
    else:  # blocked: red, shaking
        colour, extras = RED, [("shake", index - 10)]
    return dy, sx, sy, colour, extras


def pixel(index, x, y):
    dy, sx, sy, colour, extras = frame_shapes(index)
    shake = next((2 if n == 0 else -2 for kind, n in extras if kind == "shake"), 0)
    cx, cy, rx, ry = 32 + shake, 38 + dy, 20 * sx, 18 * sy
    # Shadow on the ground.
    if ((x - 32) / 16) ** 2 + ((y - 58) / 3) ** 2 <= 1:
        base = (0, 0, 0, 60)
    else:
        base = (0, 0, 0, 0)
    inside = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
    if inside:
        base = colour + (255,)
        for ex in (-7, 7):  # eyes
            if (x - (cx + ex)) ** 2 + (y - (cy - 3)) ** 2 <= 6:
                base = INK + (255,)
        if any(kind == "smile" for kind, _ in extras):
            if 20 <= (x - cx) ** 2 + (y - (cy + 1)) ** 2 <= 36 and y > cy + 3:
                base = INK + (255,)
    for kind, n in extras:
        if kind == "spark":
            sx0, sy0 = 50, 14 + (n % 2) * 4
            if abs(x - sx0) + abs(y - sy0) <= (4 if n % 2 == 0 else 2):
                base = AMBER + (255,)
        if kind == "bubble":
            bx, by = 50, 12 - n
            if (x - bx) ** 2 + (y - by) ** 2 <= 64:
                inner = (x - bx) ** 2 + (y - by) ** 2 <= 46
                base = (WHITE if inner else INK) + (255,)
                if abs(x - bx) <= 1 and by - 4 <= y <= by + 1 or abs(x - bx) <= 1 and y == by + 3:
                    base = INK + (255,)
    return base


def render():
    width, height = FRAME * COLUMNS, FRAME * ROWS
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            index = (y // FRAME) * COLUMNS + x // FRAME
            fx, fy = x % FRAME, y % FRAME
            acc = [0, 0, 0, 0]
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    r, g, b, a = pixel(index, fx + (sx + 0.5) / SAMPLES, fy + (sy + 0.5) / SAMPLES)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            n = SAMPLES * SAMPLES
            alpha = acc[3] / n
            if acc[3]:
                row += bytes([round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(alpha)])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    os.makedirs(TARGET, exist_ok=True)
    with open(os.path.join(TARGET, "sheet.png"), "wb") as out:
        out.write(render())
    manifest = {
        "schema": "maka.pet/v1",
        "id": "demo-blob",
        "displayName": "Blob",
        "description": "A test pet for maka-gpui's screenshots",
        "spriteSheet": {"path": "sheet.png", "format": "png", "frameWidth": FRAME,
                        "frameHeight": FRAME, "columns": COLUMNS, "rows": ROWS, "frameCount": 12},
        "animations": {
            "idle": {"frames": [0, 1], "fps": 2, "loop": True},
            "working": {"frames": [2, 3, 4, 5], "fps": 8, "loop": True},
            "needs-input": {"frames": [6, 7], "fps": 3, "loop": True},
            "ready": {"frames": [8, 9, 8, 9], "fps": 6, "loop": False, "fallback": "idle"},
            "blocked": {"frames": [10, 11], "fps": 6, "loop": True},
        },
    }
    with open(os.path.join(TARGET, "pet.json"), "w") as out:
        json.dump(manifest, out, indent=2)
        out.write("\n")


if __name__ == "__main__":
    main()
