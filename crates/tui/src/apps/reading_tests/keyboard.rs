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
use crossterm::event::{KeyCode, KeyEvent};

#[test]
fn narrow_readonly_split_keeps_its_outer_scroll_keyboard_accessible() {
    let mut app = tests::app();
    tests::instance_mut(&mut app).install(view(
        "Read-only split",
        scroll(
            "root",
            12,
            split(
                "columns",
                50,
                text(
                    "left",
                    (0..30)
                        .map(|row| format!("Left {row:02}\n"))
                        .collect::<String>(),
                    Tone::Normal,
                ),
                markdown(
                    "right",
                    (0..30)
                        .map(|row| format!("Right {row:02}\n\n"))
                        .collect::<String>(),
                ),
            ),
        ),
    ));
    let screen = tests::draw(&mut app, 60, 28);
    assert!(screen.contains("Left 00"));
    assert_eq!(
        tests::instance(&app).surface.focused(),
        Some("app/body/frame/content/root")
    );
    app.input(Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)));
    assert!(tests::draw(&mut app, 60, 28).contains("Right 29"));
    app.input(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)));
    assert!(tests::draw(&mut app, 60, 28).contains("Left 00"));
}
