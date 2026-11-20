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

//! Fuzzy path scoring for composer candidates, in the style of fzf: the query's
//! characters appear in order, and the best alignment rewards word starts,
//! consecutive runs and the file name while penalizing gaps.

const NONE: i32 = i32::MIN / 4;
const MAX_DP_CHARS: usize = 128;

pub(super) struct Query {
    chars: Vec<char>,
    ascii: Option<Vec<u8>>,
    original: Vec<char>,
    folded: Vec<char>,
    prev: Vec<(i32, i32)>,
    curr: Vec<(i32, i32)>,
}

impl Query {
    pub(super) fn new(text: &str) -> Self {
        let chars: Vec<char> = text.chars().map(fold).collect();
        let ascii = chars
            .iter()
            .all(char::is_ascii)
            .then(|| chars.iter().map(|&c| c as u8).collect());
        Self {
            chars,
            ascii,
            original: Vec::new(),
            folded: Vec::new(),
            prev: Vec::new(),
            curr: Vec::new(),
        }
    }

    /// `None` when the query is not a case-insensitive subsequence of `path`.
    pub(super) fn score(&mut self, path: &str) -> Option<i32> {
        if self.chars.is_empty() || path.len() < self.chars.len() || !self.is_subsequence(path) {
            return None;
        }
        self.original.clear();
        self.original.extend(path.chars());
        self.folded.clear();
        self.folded.extend(self.original.iter().copied().map(fold));
        let len = self.folded.len();
        let name = self
            .original
            .iter()
            .rposition(|&c| c == '/' || c == '\\')
            .map_or(0, |i| i + 1);
        // Require the full query as a subsequence above, while bounding DP work
        // on unusually long inputs to the trailing segment where the file name sits.
        let scored = if self.chars.len() > MAX_DP_CHARS {
            &self.chars[self.chars.len() - MAX_DP_CHARS..]
        } else {
            &self.chars[..]
        };
        // fzf's constants: a word start earns 8 (9 after a path separator) and
        // a camel-case hump 7. The first query character's bonus counts twice,
        // a run of consecutive matches keeps its first character's bonus (at
        // least 4, capped at 8 outside the file name so a directory prefix does
        // not outrank a camel-case file name), and a gap costs 3 plus 1 for
        // each further skipped character.
        self.prev.clear();
        self.curr.clear();
        self.curr.resize(len, (NONE, 0));
        for (j, &q) in scored.iter().enumerate() {
            std::mem::swap(&mut self.prev, &mut self.curr);
            self.curr.clear();
            self.curr.resize(len, (NONE, 0));
            // The best earlier score at k <= i - 2, kept as score + k so that
            // the gap penalty 3 + (i - k - 2) is a subtraction of i + 1.
            let mut gapped = NONE;
            for i in 0..len {
                if i >= 2 && self.prev[i - 2].0 > NONE {
                    gapped = gapped.max(self.prev[i - 2].0 + i as i32 - 2);
                }
                if self.folded[i] != q {
                    continue;
                }
                let own = start(&self.original, i);
                let named = if i >= name { 2 } else { 0 };
                if j == 0 {
                    self.curr[i] = (16 + own * 2 + named, own);
                    continue;
                }
                if gapped > NONE {
                    self.curr[i] = (gapped - i as i32 - 1 + 16 + own + named, own);
                }
                if let Some((run, chunk)) = i.checked_sub(1).map(|p| self.prev[p])
                    && run > NONE
                {
                    let mut chunk = chunk.max(own).max(4);
                    if i < name {
                        chunk = chunk.min(8);
                    }
                    let joined = run + 16 + chunk + named;
                    if joined > self.curr[i].0 {
                        self.curr[i] = (joined, chunk);
                    }
                }
            }
        }
        // A match scattered across a long name, averaging under 8 per query
        // character, is noise rather than a candidate.
        let floor = 8 * scored.len() as i32;
        self.curr
            .iter()
            .map(|&(score, _)| score)
            .max()
            .filter(|&score| score >= floor)
    }

    fn is_subsequence(&self, path: &str) -> bool {
        if let Some(needle) = &self.ascii
            && path.is_ascii()
        {
            let mut hay = path.as_bytes().iter();
            return needle
                .iter()
                .all(|&q| hay.any(|&b| b.to_ascii_lowercase() == q));
        }
        let mut hay = path.chars().map(fold);
        self.chars.iter().all(|&q| hay.any(|c| c == q))
    }
}

fn start(original: &[char], i: usize) -> i32 {
    match i.checked_sub(1).map(|p| original[p]) {
        None | Some('/' | '\\') => 9,
        Some('-' | '_' | '.' | ' ') => 8,
        Some(p) if p.is_lowercase() && original[i].is_uppercase() => 7,
        Some(_) => 0,
    }
}

fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_starts_runs_and_file_names_outrank_scattered_matches() {
        let rank = |query: &str, paths: &[&str]| {
            let mut query = Query::new(query);
            let mut scored: Vec<_> = paths
                .iter()
                .filter_map(|path| Some((query.score(path)?, *path)))
                .collect();
            scored.sort_by_key(|entry| (std::cmp::Reverse(entry.0), entry.1.len(), entry.1));
            scored
                .into_iter()
                .map(|(_, path)| path.to_owned())
                .collect::<Vec<String>>()
        };
        assert_eq!(
            rank(
                "down",
                &[
                    "Documents/old/won.txt",
                    "Documents/file-download.pdf",
                    "Downloads",
                    "x.rs"
                ]
            ),
            [
                "Downloads",
                "Documents/file-download.pdf",
                "Documents/old/won.txt"
            ]
        );
        assert_eq!(
            rank("wfc", &["wolfcamp", "work/flow/cache.rs"]),
            ["work/flow/cache.rs", "wolfcamp"]
        );
        assert_eq!(
            rank("客服", &["Documents/客服AI质检/a.md", "客户/服务"]),
            ["Documents/客服AI质检/a.md", "客户/服务"]
        );
        assert_eq!(
            rank("down", &["Downloads/unrelated.txt", "myDownload.rs"]),
            ["myDownload.rs", "Downloads/unrelated.txt"]
        );
        // Backslash separators mark the file name just like forward slashes on Windows.
        assert_eq!(
            rank(
                "down",
                &["Downloads\\a.txt", "open\\download.rs", "Downloads"]
            ),
            ["Downloads", "open\\download.rs", "Downloads\\a.txt"]
        );
        // Multi-char lowercase expansions fold identically on query and path.
        assert!(Query::new("İzmir").score("src/İzmir.txt").is_some());
        // Queries longer than 64 characters still require the full subsequence.
        let prefix = "a".repeat(70);
        let target = format!("{prefix}_v2.rs");
        let wrong = format!("{prefix}_v1.rs");
        let mut long_query = Query::new(&target);
        assert!(long_query.score(&target).is_some());
        assert_eq!(long_query.score(&wrong), None);

        let scattered = format!("a{}z{}z{}q", "x".repeat(40), "y".repeat(40), "w".repeat(40));
        assert_eq!(Query::new("zzq").score(&scattered), None);
    }
}
