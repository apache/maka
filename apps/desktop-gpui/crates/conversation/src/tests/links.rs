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

//! Links in a reply open only web and mail addresses (Desktop's rule,
//! `shared::links`): the kit would hand any address to the platform, and a
//! `file:` link can start an application.

use gpui_kit::{point, px};

use super::find::{open_tail, page_of, reply, turn};
use super::*;

#[gpui_kit::test]
fn a_link_in_a_reply_opens_only_a_web_or_mail_address(cx: &mut TestAppContext) {
    for href in [
        "file:///System/Applications/Calculator.app",
        "javascript:alert(1)",
        "notes/plan.md",
        "https://example.com/report",
    ] {
        let text = format!("[Follow this link to the report page]({href})");
        let rows = turn("t1", 1, "Ask", None, &text);
        let harness = open_tail(page_of(&rows, None), false, cx);
        let row = reply("t1").element_id();
        harness.with_window(cx, |window, cx| window.click_at(row, point(px(40.), px(10.)), cx));
        let expected = href.starts_with("https:").then(|| href.to_owned());
        assert_eq!(cx.opened_url(), expected, "{href}");
    }
}
