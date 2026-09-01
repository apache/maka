/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * OSC 52 clipboard writes for the terminal TUI.
 *
 * OSC 52 asks the *terminal emulator* to set the system clipboard, so it works
 * across SSH (the sequence rides the same stream as the rendered UI) and needs
 * no `pbcopy`/`xclip`/`wl-copy` binary. The trade-off is that the write is
 * fire-and-forget: the protocol has no acknowledgement, so we cannot tell
 * whether the terminal honoured it, ignored it (e.g. macOS Terminal.app), or
 * silently dropped it.
 *
 * Payload size is the sharp edge. A terminal whose OSC-string buffer is smaller
 * than the sequence does not echo the overflow to the screen — it *discards*
 * silently: kitty logs `OSC sequence too long, truncating` and keeps a prefix,
 * st (pre-0.8.3) returns once its buffer fills. Those limits vary widely (kitty
 * a few KB, Tabby ~1 KB, xterm ~1 MB) and are undetectable from here, so a large
 * payload is copied only in part with nothing to signal the cut. We do two
 * things about it: refuse above {@link MAX_CLIPBOARD_TEXT_BYTES} so an oversized
 * `/copy all` fails with a readable error instead of a half-written clipboard,
 * and — because even a below-limit copy can be dropped by an unusually small
 * buffer — word the confirmation as best-effort rather than a promise of
 * success (see `tui-copy-catalog.ts`).
 *
 * Under tmux the bare sequence is still the right primitive to emit, but note
 * it does not land on a default tmux: `set-clipboard` has defaulted to
 * `external` since tmux 2.6, which *ignores* an application's attempt to set a
 * tmux buffer, so forwarding needs `set-clipboard on`. Forwarding also requires
 * an `Ms` capability in the outer terminfo, which nested tmux and the inner side
 * of GNU screen lack (screen itself only recognises OSC 52 wrapped in DCS).
 * Wrapping in tmux's DCS passthrough is deliberately avoided anyway: it needs
 * `allow-passthrough on` (off by default in modern tmux) and bypasses tmux's own
 * clipboard handling, so it would drop the copy on a default configuration too.
 */

/**
 * Upper bound on the source text of a single OSC 52 write, in UTF-8 bytes. The
 * base64 payload the terminal parses is ~4/3 of this; the ceiling sits above any
 * plausible single reply yet bounds a whole-transcript `/copy all` so it cannot
 * emit an unbounded sequence. It is deliberately not tuned to the smallest known
 * terminal buffer — that would refuse ordinary replies — so a copy at or below
 * it is likely, not guaranteed, to land.
 */
export const MAX_CLIPBOARD_TEXT_BYTES = 16_384;

/** OSC 52 targets the system clipboard selection (`c`). */
const CLIPBOARD_SELECTION = 'c';

/**
 * Build the OSC 52 escape sequence that sets the system clipboard to `text`:
 * `ESC ] 52 ; c ; <base64> BEL`. The BEL (`\x07`) terminator is accepted more
 * widely than the ST (`ESC \`) form.
 */
export function osc52ClipboardSequence(text: string): string {
  const base64 = Buffer.from(text, 'utf8').toString('base64');
  return `\x1b]52;${CLIPBOARD_SELECTION};${base64}\x07`;
}

/** The subset of the pi-tui Terminal this module writes to. */
export interface ClipboardTerminal {
  write(data: string): void;
}

/**
 * Outcome of a clipboard write. `ok: false` means nothing was emitted because
 * the payload exceeded {@link MAX_CLIPBOARD_TEXT_BYTES}; `bytes`/`limit` let the
 * caller word a readable refusal. `ok: true` is best-effort: see the file
 * header for why there is no delivery confirmation.
 */
export type ClipboardWriteResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: 'too_large'; bytes: number; limit: number };

/**
 * Copy `text` to the system clipboard via OSC 52, refusing an oversized payload
 * rather than emitting a sequence a terminal would silently truncate. On
 * success the write is fire-and-forget — see the file header for why there is
 * no delivery result.
 */
export function copyToClipboard(terminal: ClipboardTerminal, text: string): ClipboardWriteResult {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_CLIPBOARD_TEXT_BYTES) {
    return { ok: false, reason: 'too_large', bytes, limit: MAX_CLIPBOARD_TEXT_BYTES };
  }
  terminal.write(osc52ClipboardSequence(text));
  return { ok: true, bytes };
}
