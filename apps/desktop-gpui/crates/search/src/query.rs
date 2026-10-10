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

//! What a find looks for: the query's text and its options.

use std::sync::Arc;

/// How a query matches text. Plain text only: no regular expressions.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct SearchOptions {
    case_sensitive: bool,
    whole_word: bool,
}

impl SearchOptions {
    /// Case-insensitive, matching inside words: the bar's default.
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether letters must match in case (Match case).
    pub fn case_sensitive(mut self, case_sensitive: bool) -> Self {
        self.case_sensitive = case_sensitive;
        self
    }

    /// Whether a match must stand as a word of its own (Match whole word):
    /// no word character, of any script, touches either end of it.
    pub fn whole_word(mut self, whole_word: bool) -> Self {
        self.whole_word = whole_word;
        self
    }

    pub fn is_case_sensitive(&self) -> bool {
        self.case_sensitive
    }

    pub fn is_whole_word(&self) -> bool {
        self.whole_word
    }
}

/// A query and its options, cheap to clone and to send to a background
/// search.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SearchQuery {
    text: Arc<str>,
    options: SearchOptions,
}

impl SearchQuery {
    pub fn new(text: impl Into<Arc<str>>, options: SearchOptions) -> Self {
        Self { text: text.into(), options }
    }

    /// The text looked for, as typed.
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn options(&self) -> SearchOptions {
        self.options
    }

    /// Whether there is nothing to look for: an empty query matches nothing.
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }
}
