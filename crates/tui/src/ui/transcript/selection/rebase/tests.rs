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

fn selection(key: &MessageKey, text: &str, range: Range<usize>) -> Selection {
    Selection {
        ranges: vec![Segment {
            key: key.clone(),
            range: range.clone(),
            text: text[range.clone()].to_owned(),
        }],
        extent: Some(Extent {
            anchor: Caret {
                key: key.clone(),
                offset: range.start,
                trailing: false,
            },
            head: Caret {
                key: key.clone(),
                offset: range.end,
                trailing: true,
            },
            column: Some(7),
        }),
        drag: Some(Drag {
            anchor: Point {
                key: key.clone(),
                range,
            },
            position: (2, 1),
            click: None,
            moved: true,
            pointer: (5, 1),
            edge: None,
        }),
        ..Selection::default()
    }
}

#[test]
fn computed_mapping_keeps_prefix_suffix_and_grapheme_invalidation_semantics() {
    let key = MessageKey::new("t", "m", Part::Text);
    for (old, new, selected, expected) in [
        ("e\u{301}中🦀", "e\u{301}中🦀", 0..6, Some(0..6)),
        ("ab中", "ab中tail", 2..5, Some(2..5)),
        ("e\u{301}🦀tail", "前e\u{301}🦀tail", 0..3, Some(3..6)),
        (
            "left e\u{301} 中🦀",
            "left NEW e\u{301} 中🦀",
            5..8,
            Some(9..12),
        ),
        ("ab中cd", "ab🦀cd", 2..5, None),
        ("e", "e\u{301}", 0..1, None),
        ("🇨🇳ab", "🇨🇳xb", 0..8, Some(0..8)),
        ("👩‍💻 tail", "👩‍🔬 tail", 12..16, Some(12..16)),
    ] {
        let mut direct = selection(&key, old, selected.clone());
        let mut prepared = selection(&key, old, selected.clone());
        direct.rebase(&key, old, new);
        let mapping = compute(old, new);
        prepared.apply_rebase(&key, &mapping);
        assert!(direct.extent == prepared.extent);
        assert_eq!(direct.active(), prepared.active());
        match expected {
            Some(range) => {
                for state in [&direct, &prepared] {
                    let segment = &state.ranges[0];
                    assert_eq!(segment.range, range);
                    assert_eq!(segment.text, &old[selected.clone()]);
                    assert_eq!(segment.text, &new[range.clone()]);
                    assert_eq!(state.drag.as_ref().unwrap().anchor.range, range);
                    let extent = state.extent.as_ref().unwrap();
                    assert_eq!(extent.anchor.offset, range.start);
                    assert_eq!(extent.head.offset, range.end);
                    assert_eq!(extent.column, (old == new).then_some(7));
                }
            }
            None => {
                assert!(direct.ranges.is_empty() && prepared.ranges.is_empty());
                assert!(direct.extent.is_none() && prepared.extent.is_none());
                assert!(direct.drag.is_none() && prepared.drag.is_none());
            }
        }
    }
}

#[test]
fn computed_insertion_mapping_preserves_caret_affinity_without_retaining_text() {
    let key = MessageKey::new("t", "m", Part::Text);
    let mapping = {
        let old = String::from("ab");
        let new = String::from("aXb");
        compute(&old, &new)
    };
    assert_eq!(
        mapping,
        Rebase::Changed {
            prefix: 1,
            old_end: 1,
            new_end: 2
        }
    );
    for (trailing, expected) in [(true, 1), (false, 2)] {
        let caret = Caret {
            key: key.clone(),
            offset: 1,
            trailing,
        };
        let mut selected = Selection {
            extent: Some(Extent {
                anchor: caret.clone(),
                head: caret,
                column: Some(3),
            }),
            ..Selection::default()
        };
        selected.apply_rebase(&key, &mapping);
        let extent = selected.extent.unwrap();
        assert_eq!(extent.anchor.offset, expected);
        assert_eq!(extent.head.offset, expected);
        assert_eq!(extent.column, None);
    }
    assert_eq!(compute("", ""), Rebase::Unchanged);
}
