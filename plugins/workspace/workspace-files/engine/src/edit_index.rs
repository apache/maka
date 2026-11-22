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

// Match ECMAScript whitespace when comparing model-supplied edits.

pub(super) fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// KMP records every start, including overlaps, in linear time.
pub(super) fn starts<T: Eq>(text: &[T], pattern: &[T]) -> Vec<bool> {
    let mut found = vec![false; text.len() + 1];
    if pattern.is_empty() {
        found.fill(true);
        return found;
    }
    let mut prefix = vec![0; pattern.len()];
    let mut matched = 0;
    for i in 1..pattern.len() {
        while matched > 0 && pattern[i] != pattern[matched] {
            matched = prefix[matched - 1];
        }
        if pattern[i] == pattern[matched] {
            matched += 1;
        }
        prefix[i] = matched;
    }
    matched = 0;
    for (i, item) in text.iter().enumerate() {
        while matched > 0 && *item != pattern[matched] {
            matched = prefix[matched - 1];
        }
        if *item == pattern[matched] {
            matched += 1;
        }
        if matched == pattern.len() {
            found[i + 1 - matched] = true;
            matched = prefix[matched - 1];
        }
    }
    found
}

pub(super) struct Index {
    pub text: String,
    offsets: Vec<usize>,
    // A block ending between a backslash and newline retains the backslash.
    dangling: Vec<bool>,
}

impl Index {
    pub fn new(source: &str, escape: bool) -> Self {
        let mut text = String::new();
        let mut offsets = vec![0; source.len() + 1];
        let mut dangling = vec![false; source.len() + 1];
        let mut chars = source.char_indices().peekable();
        while let Some((i, c)) = chars.next() {
            offsets[i] = text.len();
            let mut end = i + c.len_utf8();
            let mut output = c;
            if escape
                && c == '\\'
                && let Some(&(j, next)) = chars.peek()
            {
                let decoded = match next {
                    'n' => Some('\n'),
                    't' => Some('\t'),
                    'r' => Some('\r'),
                    '\'' | '"' | '`' | '\\' | '\n' | '$' => Some(next),
                    _ => None,
                };
                if let Some(decoded) = decoded {
                    offsets[j] = text.len();
                    dangling[j] = next == '\n';
                    output = decoded;
                    end = j + next.len_utf8();
                    chars.next();
                }
            }
            if escape || !js_space(output) {
                text.push(output);
            } else if !text.ends_with(' ') {
                text.push(' ');
            }
            offsets[end] = text.len();
        }
        Self {
            text,
            offsets,
            dangling,
        }
    }

    pub fn window(&self, start: usize, end: usize, escape: bool) -> (usize, usize, bool) {
        let mut a = self.offsets[start];
        let mut b = self.offsets[end];
        if !escape {
            if a < b && self.text.as_bytes()[a] == b' ' {
                a += 1;
            }
            if a < b && self.text.as_bytes()[b - 1] == b' ' {
                b -= 1;
            }
        }
        (a, b, escape && self.dangling[end])
    }
}
