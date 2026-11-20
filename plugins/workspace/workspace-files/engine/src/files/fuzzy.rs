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

pub(super) struct Query(Vec<char>);

impl Query {
    pub(super) fn new(text: &str) -> Self {
        Self(text.chars().take(64).map(fold).collect())
    }

    /// `None` when the query is not a case-insensitive subsequence of `path`.
    pub(super) fn score(&self, path: &str) -> Option<i32> {
        let original: Vec<char> = path.chars().collect();
        let text: Vec<char> = original.iter().copied().map(fold).collect();
        let mut rest = text.iter();
        if !self.0.iter().all(|q| rest.any(|c| c == q)) {
            return None;
        }
        let name = original
            .iter()
            .rposition(|&c| c == '/')
            .map_or(0, |i| i + 1);
        // fzf's constants: a word start earns 8 (9 after a path separator) and
        // a camel-case hump 7. The first query character's bonus counts twice,
        // a run of consecutive matches keeps its first character's bonus (at
        // least 4), and a gap costs 3 plus 1 for each further skipped character.
        let start = |i: usize| match i.checked_sub(1).map(|p| original[p]) {
            None | Some('/' | '\\') => 9,
            Some('-' | '_' | '.' | ' ') => 8,
            Some(p) if p.is_lowercase() && original[i].is_uppercase() => 7,
            Some(_) => 0,
        };
        let named = |i: usize| if i >= name { 2 } else { 0 };
        // At text[i] for the current query character: the best score, and the
        // bonus of the consecutive run that ends there.
        let mut best = vec![(NONE, 0); text.len()];
        for (j, &q) in self.0.iter().enumerate() {
            let previous = std::mem::replace(&mut best, vec![(NONE, 0); text.len()]);
            // The best earlier score at k <= i - 2, kept as score + k so that
            // the gap penalty 3 + (i - k - 2) is a subtraction of i + 1.
            let mut gapped = NONE;
            for i in 0..text.len() {
                if i >= 2 && previous[i - 2].0 > NONE {
                    gapped = gapped.max(previous[i - 2].0 + i as i32 - 2);
                }
                if text[i] != q {
                    continue;
                }
                let own = start(i);
                if j == 0 {
                    best[i] = (16 + own * 2 + named(i), own);
                    continue;
                }
                if gapped > NONE {
                    best[i] = (gapped - i as i32 - 1 + 16 + own + named(i), own);
                }
                if let Some((run, chunk)) = i.checked_sub(1).map(|p| previous[p])
                    && run > NONE
                {
                    let chunk = chunk.max(own).max(4);
                    let joined = run + 16 + chunk + named(i);
                    if joined > best[i].0 {
                        best[i] = (joined, chunk);
                    }
                }
            }
        }
        // A match scattered across a long name, averaging under 8 per query
        // character, is noise rather than a candidate.
        let floor = 8 * self.0.len() as i32;
        best.into_iter()
            .map(|(score, _)| score)
            .max()
            .filter(|&score| score >= floor)
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
            let query = Query::new(query);
            let mut scored: Vec<_> = paths
                .iter()
                .filter_map(|path| Some((query.score(path)?, *path)))
                .collect();
            scored.sort_by_key(|entry| std::cmp::Reverse(entry.0));
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
        let scattered = format!("a{}z{}z{}q", "x".repeat(40), "y".repeat(40), "w".repeat(40));
        assert_eq!(Query::new("zzq").score(&scattered), None);
    }
}
