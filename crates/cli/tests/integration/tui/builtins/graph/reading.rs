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

use super::*;

pub(super) fn reveal(tui: &mut Pty, label: &str) {
    eprintln!("Graph reading: reveal {label:?}");
    // The Graph's reading pane scrolls inside the inspector. Point at its
    // content, not the outer inspector's rightmost scrollbar.
    for _ in 0..128 {
        tui.wait_until(|screen| {
            screen.contains(label) || screen.contains("中🦀") || screen.contains("答😀")
        });
        let screen = tui.screen.snapshot().unwrap().screen;
        if screen.contains(label) {
            position(&screen, "found", label);
            return;
        }
        let (row, column) = screen
            .lines()
            .enumerate()
            .find_map(|(row, line)| {
                line.find("中🦀")
                    .or_else(|| line.find("答😀"))
                    .map(|byte| (row, line[..byte].width()))
            })
            .unwrap_or_else(|| panic!("No Graph reading content for {label}:\n{screen}"));
        tui.output.clear();
        tui.send(format!("\x1b[<65;{};{}M", column + 1, row + 1).as_bytes());
        // Repeated Unicode rows can produce identical pixels after a scroll.
        // Await the completed draw instead of requiring different text.
        tui.wait_output(b"\x1b[?2026l");
        tui.wait_until(|_| true);
    }
    eprintln!("Graph reading: {label:?} absent after 128 wheel events");
    tui.wait_for(label);
}

pub(super) fn click(tui: &mut Pty, label: &str) {
    position(&tui.screen.snapshot().unwrap().screen, "click", label);
    tui.click_page_text(label);
}

fn position(screen: &str, action: &str, label: &str) {
    let (row, column) = screen
        .lines()
        .enumerate()
        .find_map(|(row, line)| {
            line.find(label)
                .map(|byte| (row + 1, line[..byte].width() + 1))
        })
        .unwrap_or_else(|| panic!("No Graph reading label {label:?}:\n{screen}"));
    eprintln!("Graph reading: {action} {label:?} at row {row}, column {column}");
}
