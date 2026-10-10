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

//! Finding text: in what a view shows, after Zed's buffer search, and in
//! every task, after Zed's project search (their practices, not their
//! code).
//!
//! - [`Searchable`] is the seam: an item finds a query's matches in its
//!   whole content off the main thread, paints the matches it is handed,
//!   brings one into view, and says when its content changed
//!   ([`SearchEvent`]). The conversation's transcript implements it, and
//!   the terminal will.
//! - [`SearchOptions`] and [`SearchQuery`]: plain text, Match case and
//!   Match whole word ([`matching`] holds the matching itself).
//! - [`FindBar`] is the bar a person types into: the query, the two
//!   options, "3/12" or "No results", previous, next and close.
//!
//! Key contexts: the bar's keys apply in [`FIND_BAR_CONTEXT`]; the view
//! that owns a bar binds the key that opens it (⌘F) in its own context, so
//! the transcript and a terminal can each take ⌘F for their own bar.
//!
//! - [`SearchView`] is the Search page (⇧⌘F): every task's messages
//!   through the Host's `recall.query`, grouped by task ([`recall`] holds
//!   the answer's model), its keys in [`SEARCH_PAGE_CONTEXT`]. Opening a
//!   result hands the window a [`PassageTarget`]; the conversation shows
//!   it with the find bar on its term.

mod find_bar;
pub mod matching;
mod page;
mod query;
pub mod recall;
mod searchable;

use gpui_kit::{App, KeyBinding};

pub use find_bar::{FindBar, FindBarEvent, REFRESH_DELAY};
pub use page::{
    DismissSearch, OpenResult, SEARCH_DEBOUNCE, SEARCH_PAGE_CONTEXT, SearchPageEvent, SearchView,
    SelectNextResult, SelectPreviousResult, passage_element_id, title_element_id,
};
pub use query::{SearchOptions, SearchQuery};
pub use recall::{PassageTarget, TaskEntry};
pub use searchable::{SearchEvent, Searchable};

/// Key context of a find bar, while anything in it has focus.
pub const FIND_BAR_CONTEXT: &str = "FindBar";

gpui_kit::actions!(
    search,
    [
        /// Move to the next match, after the last back to the first.
        SelectNextMatch,
        /// Move to the previous match, before the first on to the last.
        SelectPreviousMatch,
        /// Close the find bar and clear its highlights.
        Dismiss,
    ]
);

/// Binds the find bar's and the Search page's keys. Call once at startup,
/// before building menus.
/// Enter and Shift-Enter in the query need no binding: the bar takes them
/// from its field.
pub fn init(cx: &mut App) {
    let context = Some(FIND_BAR_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("secondary-g", SelectNextMatch, context),
        KeyBinding::new("secondary-shift-g", SelectPreviousMatch, context),
        KeyBinding::new("escape", Dismiss, context),
    ]);
    page::bind_keys(cx);
}

#[cfg(test)]
mod tests;
