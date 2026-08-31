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
 * fire-and-forget: the protocol has no acknowledgement, so we cannot detect a
 * terminal that ignores it (e.g. macOS Terminal.app). We therefore never
 * truncate silently — an oversized payload that a terminal drops is a clearer
 * failure than half a copy.
 *
 * Under tmux, the bare sequence is the right thing to emit: with
 * `set-clipboard on` tmux intercepts OSC 52 and forwards it to the outer
 * terminal. Wrapping it in tmux's DCS passthrough is deliberately avoided —
 * passthrough needs `allow-passthrough on` (off by default in modern tmux) and
 * bypasses tmux's own clipboard handling, so it would silently drop the copy on
 * a default configuration.
 */

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
 * Copy `text` to the system clipboard via OSC 52. Fire-and-forget: see the file
 * header for why there is no result.
 */
export function copyToClipboard(terminal: ClipboardTerminal, text: string): void {
  terminal.write(osc52ClipboardSequence(text));
}
