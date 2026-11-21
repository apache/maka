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
use maka_plugin_core::terminal::TerminalSize;

fn text(viewport: &Viewport) -> String {
    viewport
        .rows
        .iter()
        .flat_map(|row| row.iter().map(|run| run.text.as_str()))
        .collect()
}

#[test]
fn numeric_viewports_preserve_original_rows_and_retained_history() {
    let mut screen = Screen::new(TerminalSize::new(80, 24).unwrap());
    screen.write("READY\r\n").unwrap();

    let following = screen.viewport(6, 18).unwrap();
    assert!(text(&following).contains("READY"));
    assert_eq!(following.first_line, 0);
    assert!(!text(&screen.viewport(0, 18).unwrap()).contains("READY"));
    assert_eq!(
        Viewport::from_display(&screen.display(), 6, 18).unwrap(),
        following
    );

    for line in 0..40 {
        screen.write(&format!("line-{line}\r\n")).unwrap();
    }
    let following = screen.viewport(0, 18).unwrap();
    assert!(text(&following).contains("line-39"));

    let history = screen.viewport(usize::MAX, 18).unwrap();
    assert!(text(&history).contains("READY"));
    assert_eq!(
        Viewport::from_display(&screen.display(), usize::MAX, 18).unwrap(),
        history
    );
}
