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

"""Maka GPUI icon set, the source for assets/icons/maka/*.svg (16x16, 1.5 round stroke).

Run `python3 scripts/design-icons.py --write` to regenerate the SVG files."""
ICONS = [
 ("compose", '<path d="M13.5 8.5V12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5h3.5"/><path d="M12.1 2.4a1.41 1.41 0 0 1 2 2L9 9.5l-2.5.5.5-2.5z"/>'),
 ("sidebar", '<rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2"/><path d="M6.25 2.75v10.5"/>'),
 ("chevron-left", '<path d="M10 3.5 5.5 8l4.5 4.5"/>'),
 ("chevron-right", '<path d="M6 3.5 10.5 8 6 12.5"/>'),
 ("chevron-down", '<path d="m4.5 6.25 3.5 3.5 3.5-3.5"/>'),
 ("search", '<circle cx="7" cy="7" r="4.5"/><path d="m13.5 13.5-3.25-3.25"/>'),
 ("folder", '<path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2.4L8 4.75h4a1.5 1.5 0 0 1 1.5 1.5v5.25A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z"/>'),
 ("plus", '<path d="M8 3.5v9M3.5 8h9"/>'),
 ("close", '<path d="m4.25 4.25 7.5 7.5M11.75 4.25l-7.5 7.5"/>'),
 ("more", '<circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none"/>'),
 ("send", '<path d="M8 12.75V3.75M4.25 7.5 8 3.75l3.75 3.75" stroke-width="1.75"/>'),
 ("stop", '<rect x="4.5" y="4.5" width="7" height="7" rx="1.75" fill="currentColor" stroke="none"/>'),
 ("tool-terminal", '<rect x="2" y="2.75" width="12" height="10.5" rx="2"/><path d="m5 6.25 2 1.75-2 1.75"/><path d="M8.75 10h2.5"/>'),
 ("tool-read", '<path d="M9.5 2H5a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 5 14h6a1.5 1.5 0 0 0 1.5-1.5V5z"/><path d="M9.5 2v3h3"/><path d="M6 8.5h4M6 11h2.5"/>'),
 ("tool-edit", '<path d="M12.5 6.75V5L9.5 2H5a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 5 14h1.75"/><path d="M9.5 2v3h3"/><path d="M12.65 8.85a1.06 1.06 0 0 1 1.5 1.5L10.5 14l-1.75.5.5-1.75z"/>'),
 ("tool-search", '<path d="M2.5 3.75h6M2.5 7.25h3.5M2.5 10.75h3"/><circle cx="10.25" cy="9.25" r="2.75"/><path d="m12.25 11.25 1.75 1.75"/>'),
 ("tool-web", '<circle cx="8" cy="8" r="5.75"/><path d="M2.25 8h11.5"/><path d="M8 2.25c1.55 1.65 2.35 3.55 2.35 5.75S9.55 12.1 8 13.75C6.45 12.1 5.65 10.2 5.65 8S6.45 3.9 8 2.25z"/>'),
 ("tool-plug", '<path d="M6 2.5v3M10 2.5v3"/><path d="M4.25 5.5h7.5V8a3.75 3.75 0 0 1-7.5 0z"/><path d="M8 11.75v1.75"/>'),
 # The reasoning row's icon is not drawn here: it is the person's thinking
 # face (docs/design/icons/thinking-icon-v4.svg), animated in code by
 # crates/conversation/src/thinking_face.rs.
 ("status-done", '<circle cx="8" cy="8" r="5.75"/><path d="m5.5 8.25 1.75 1.75 3.25-3.5"/>'),
 ("status-failed", '<circle cx="8" cy="8" r="5.75"/><path d="m6.1 6.1 3.8 3.8M9.9 6.1l-3.8 3.8"/>'),
 ("status-running", '<circle cx="8" cy="8" r="5.75" opacity=".25"/><path d="M8 2.25a5.75 5.75 0 0 1 5.75 5.75"/>'),
 ("status-waiting", '<circle cx="8" cy="8" r="5.75"/><path d="M6.35 6.45a1.7 1.7 0 1 1 2.4 1.55c-.45.22-.75.55-.75 1.05v.2"/><path d="M8 10.85h.01" stroke-width="2"/>'),
 ("status-stopped", '<circle cx="8" cy="8" r="5.75"/><rect x="6" y="6" width="4" height="4" rx=".75" fill="currentColor" stroke="none"/>'),
 ("flag", '<path d="M3.5 14V2.75"/><path d="M3.5 3h7.75l-1.75 2.75 1.75 2.75H3.5"/>'),
 ("archive", '<rect x="2" y="2.75" width="12" height="3.25" rx="1"/><path d="M3.25 6v6.25A1.5 1.5 0 0 0 4.75 13.75h6.5a1.5 1.5 0 0 0 1.5-1.5V6"/><path d="M6.5 9h3"/>'),
 ("settings", '<path d="M2.5 4.75h6M11.5 4.75h2M2.5 11.25h2M7.5 11.25h6"/><circle cx="10" cy="4.75" r="1.5"/><circle cx="6" cy="11.25" r="1.5"/>'),
 ("host", '<rect x="2.5" y="2.5" width="11" height="4.75" rx="1.25"/><rect x="2.5" y="8.75" width="11" height="4.75" rx="1.25"/><path d="M5 4.875h.01M5 11.125h.01" stroke-width="2"/>'),
 ("copy", '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>'),
 ("queue", '<path d="M2.75 4h10.5M2.75 8h10.5M2.75 12h6"/><path d="m11.5 10.5 1.75 1.5-1.75 1.5"/>'),
 ("attach", '<path d="m13 7.6-4.95 4.95a3.2 3.2 0 0 1-4.53-4.53l5.3-5.3a2.13 2.13 0 0 1 3.02 3.02L6.6 11a1.07 1.07 0 0 1-1.51-1.51l4.6-4.6"/>'),
 ("file-diff", '<path d="M9.5 2H5a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 5 14h6a1.5 1.5 0 0 0 1.5-1.5V5z"/><path d="M6 6.5h4"/><path d="M8 4.5v4"/><path d="M6 11h4"/>'),
 ("folder-open", '<path d="M2.5 11.5v-7A1.5 1.5 0 0 1 4 3h2.4L8 4.75h3.5A1.5 1.5 0 0 1 13 6.25V7.5"/><path d="M2.5 11.5l1.6-3.17A1.5 1.5 0 0 1 5.44 7.5h8.06a.75.75 0 0 1 .7 1.01l-1.28 3.5a1.5 1.5 0 0 1-1.41.99H4a1.5 1.5 0 0 1-1.5-1.5z"/>'),
]

def svg(inner, size):
    return (f'<svg width="{size}" height="{size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" '
            f'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">{inner}</svg>')

def tile(name, inner):
    return (f'<div style="width:156px;display:flex;flex-direction:column;gap:12px;padding:16px;border-radius:10px;background:var(--color-canvas)">'
            f'<div style="display:flex;align-items:center;justify-content:space-between;color:var(--color-ink)">'
            f'{svg(inner,48)}{svg(inner,16)}</div>'
            f'<div style="font-size:12px;line-height:20px;color:var(--color-ink-muted);font-family:var(--font-mono)">{name}</div></div>')

if __name__ == "__main__":
    import pathlib, sys
    if "--write" in sys.argv:
        out = pathlib.Path(__file__).resolve().parent.parent / "assets/icons/maka"
        out.mkdir(parents=True, exist_ok=True)
        for name, inner in ICONS:
            s = svg(inner, 16).replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ', 1)
            (out / f"{name}.svg").write_text(s + "\n")
        print(f"wrote {len(ICONS)} icons to {out}")
