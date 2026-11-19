//! How a keyed list's rows changed: which rows stayed, which moved, which
//! came and which went, from the rows' keys before and after.
//!
//! With it a virtualized list keeps each row's measured size, and each
//! rendered row's cell and content, wherever the row goes: a row that
//! changes place keeps its cell (and the state inside it: a focus, an open
//! menu), and so do the rows it passes. Only rows whose key is new need a
//! cell, and only rows whose key is gone give theirs back.
//!
//! [`ListDiff::new`] pairs rows by key (repeated keys pair up in order, a
//! row without a key pairs with none); of the rows paired, those that kept
//! their order are [`DiffRun::Kept`] and the others [`DiffRun::Moved`].

use std::hash::Hash;

use rustc_hash::FxHashMap;

const NONE: u32 = u32::MAX;

/// A stretch of a list's new rows ([`ListDiff::runs`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffRun {
    /// `len` rows that were at `from..from + len`, in the order the rows
    /// around them kept.
    Kept {
        /// The first row's index before.
        from: u32,
        /// How many rows.
        len: u32,
    },
    /// `len` rows that were at `from..from + len` and changed place among
    /// the kept rows.
    Moved {
        /// The first row's index before.
        from: u32,
        /// How many rows.
        len: u32,
    },
    /// `len` rows whose keys are new.
    Inserted {
        /// How many rows.
        len: u32,
    },
}

impl DiffRun {
    /// How many new rows the run covers.
    pub fn len(&self) -> u32 {
        match *self {
            Self::Kept { len, .. } | Self::Moved { len, .. } | Self::Inserted { len } => len,
        }
    }

    /// Whether the run covers no rows.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The old index of the run's first row, unless the rows are new.
    pub fn from(&self) -> Option<u32> {
        match *self {
            Self::Kept { from, .. } | Self::Moved { from, .. } => Some(from),
            Self::Inserted { .. } => None,
        }
    }
}

/// How a list's rows changed, by key: its new rows in order, as runs of
/// rows kept, moved or inserted. Old rows no run covers were removed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct ListDiff {
    /// How many rows there were.
    pub old_len: u32,
    /// How many rows there are.
    pub new_len: u32,
    /// The new rows in order.
    pub runs: Vec<DiffRun>,
}

impl ListDiff {
    /// How the rows with keys `old` became the rows with keys `new`;
    /// `None` when they are the same.
    pub fn new<K: Copy + Eq + Hash>(old: &[K], new: &[K]) -> Option<Self> {
        Self::diff(old, new, |k| Some(*k))
    }

    /// [`ListDiff::new`] for rows that may have no key (`None`): such a row
    /// matches no other.
    pub fn new_partial<K: Copy + Eq + Hash>(old: &[Option<K>], new: &[Option<K>]) -> Option<Self> {
        Self::diff(old, new, |k| *k)
    }

    fn diff<T, K: Copy + Eq + Hash>(
        old: &[T],
        new: &[T],
        key: impl Fn(&T) -> Option<K> + Copy,
    ) -> Option<Self> {
        let same = |a: &T, b: &T| key(a).is_some_and(|a| Some(a) == key(b));
        let start = old.iter().zip(new).take_while(|(a, b)| same(a, b)).count();
        let end = old[start..]
            .iter()
            .rev()
            .zip(new[start..].iter().rev())
            .take_while(|(a, b)| same(a, b))
            .count();
        if start + end == old.len() && start + end == new.len() {
            return None;
        }
        let (middle_old, middle_new) = (&old[start..old.len() - end], &new[start..new.len() - end]);
        let mut diff = Self {
            old_len: old.len() as u32,
            new_len: new.len() as u32,
            runs: Vec::new(),
        };
        diff.push(DiffRun::Kept {
            from: 0,
            len: start as u32,
        });
        // The old row each new one is (by its key's occurrence), and which
        // of them keep their order: the longest increasing run of old rows.
        let sources = match_keys(middle_old, middle_new, key);
        let kept = longest_increasing(&sources);
        let offset = start as u32;
        for (j, &i) in sources.iter().enumerate() {
            diff.push(if i == NONE {
                DiffRun::Inserted { len: 1 }
            } else if kept[j] {
                DiffRun::Kept {
                    from: offset + i,
                    len: 1,
                }
            } else {
                DiffRun::Moved {
                    from: offset + i,
                    len: 1,
                }
            });
        }
        diff.push(DiffRun::Kept {
            from: (old.len() - end) as u32,
            len: end as u32,
        });
        Some(diff)
    }

    /// A diff that removes `removed` rows at `at` of `old_len` and inserts
    /// `inserted` there.
    pub fn splice(old_len: u32, at: u32, removed: u32, inserted: u32) -> Self {
        let at = at.min(old_len);
        let removed = removed.min(old_len - at);
        let mut diff = Self {
            old_len,
            new_len: old_len - removed + inserted,
            runs: Vec::new(),
        };
        diff.push(DiffRun::Kept { from: 0, len: at });
        diff.push(DiffRun::Inserted { len: inserted });
        diff.push(DiffRun::Kept {
            from: at + removed,
            len: old_len - at - removed,
        });
        diff
    }

    /// The diff of rows inside a list: `before` rows before them and
    /// `after` rows after them stayed as they were.
    pub fn widened(self, before: u32, after: u32) -> Self {
        let mut diff = Self {
            old_len: before + self.old_len + after,
            new_len: before + self.new_len + after,
            runs: Vec::with_capacity(self.runs.len() + 2),
        };
        diff.push(DiffRun::Kept {
            from: 0,
            len: before,
        });
        for run in self.runs {
            diff.push(match run {
                DiffRun::Kept { from, len } => DiffRun::Kept {
                    from: from + before,
                    len,
                },
                DiffRun::Moved { from, len } => DiffRun::Moved {
                    from: from + before,
                    len,
                },
                DiffRun::Inserted { len } => DiffRun::Inserted { len },
            });
        }
        diff.push(DiffRun::Kept {
            from: before + self.old_len,
            len: after,
        });
        diff
    }

    /// Appends `run`, merged into the last one when it continues it.
    fn push(&mut self, run: DiffRun) {
        if run.is_empty() {
            return;
        }
        let merged = match (self.runs.last_mut(), run) {
            (Some(DiffRun::Inserted { len }), DiffRun::Inserted { len: more }) => {
                *len += more;
                true
            }
            (
                Some(DiffRun::Kept { from, len }),
                DiffRun::Kept {
                    from: next,
                    len: more,
                },
            )
            | (
                Some(DiffRun::Moved { from, len }),
                DiffRun::Moved {
                    from: next,
                    len: more,
                },
            ) if *from + *len == next => {
                *len += more;
                true
            }
            _ => false,
        };
        if !merged {
            self.runs.push(run);
        }
    }

    /// The change as one splice, `(at, removed, inserted)`, when it is one
    /// (no row moved, and one stretch of rows changed).
    pub fn as_splice(&self) -> Option<(u32, u32, u32)> {
        let mut runs = self.runs.as_slice();
        let mut at = 0;
        if let [DiffRun::Kept { from: 0, len }, rest @ ..] = runs {
            at = *len;
            runs = rest;
        }
        let mut inserted = 0;
        if let [DiffRun::Inserted { len }, rest @ ..] = runs {
            inserted = *len;
            runs = rest;
        }
        let resume = match runs {
            [] => self.old_len,
            [DiffRun::Kept { from, len }] if from + len == self.old_len => *from,
            _ => return None,
        };
        (resume >= at).then_some((at, resume - at, inserted))
    }

    /// Each old row's new index, `None` for the rows removed.
    pub fn new_indices(&self) -> Vec<Option<u32>> {
        let mut out = vec![None; self.old_len as usize];
        let mut at = 0;
        for run in &self.runs {
            if let Some(from) = run.from() {
                for k in 0..run.len() {
                    if let Some(slot) = out.get_mut((from + k) as usize) {
                        *slot = Some(at + k);
                    }
                }
            }
            at += run.len();
        }
        out
    }

    /// Old row `old`'s new index, and whether it moved; `None` when it was
    /// removed. O(runs): for a few rows (the cells), not every row.
    pub fn new_index(&self, old: u32) -> Option<(u32, bool)> {
        let mut at = 0;
        for run in &self.runs {
            if let Some(from) = run.from()
                && (from..from + run.len()).contains(&old)
            {
                return Some((at + old - from, matches!(run, DiffRun::Moved { .. })));
            }
            at += run.len();
        }
        None
    }
}

/// For each of `new`'s rows, the index in `old` of the row with its key
/// (the n-th occurrence of a key in `new` is its n-th in `old`), or
/// [`NONE`].
fn match_keys<T, K: Copy + Eq + Hash>(
    old: &[T],
    new: &[T],
    key: impl Fn(&T) -> Option<K>,
) -> Vec<u32> {
    // The first unmatched old row of each key, and the next of the same
    // key after each row.
    let mut head: FxHashMap<K, u32> = FxHashMap::default();
    head.reserve(old.len());
    let mut next = vec![NONE; old.len()];
    for (i, row) in old.iter().enumerate().rev() {
        if let Some(k) = key(row) {
            next[i] = head.insert(k, i as u32).unwrap_or(NONE);
        }
    }
    new.iter()
        .map(|row| {
            let Some(first) = key(row).and_then(|k| head.get_mut(&k)) else {
                return NONE;
            };
            let i = *first;
            if i != NONE {
                *first = next[i as usize];
            }
            i
        })
        .collect()
}

/// Which of `sources` (old indices, [`NONE`] skipped) form a longest
/// strictly increasing subsequence: the rows that keep their order.
fn longest_increasing(sources: &[u32]) -> Vec<bool> {
    // `tails[k]`: the position of the smallest last value of an increasing
    // run of length k + 1; `prev`: each position's predecessor in its run.
    let mut tails: Vec<u32> = Vec::new();
    let mut prev = vec![NONE; sources.len()];
    for (j, &value) in sources.iter().enumerate() {
        if value == NONE {
            continue;
        }
        let k = tails.partition_point(|&t| sources[t as usize] < value);
        if k > 0 {
            prev[j] = tails[k - 1];
        }
        if k == tails.len() {
            tails.push(j as u32);
        } else {
            tails[k] = j as u32;
        }
    }
    let mut kept = vec![false; sources.len()];
    let mut at = tails.last().copied().unwrap_or(NONE);
    while at != NONE {
        kept[at as usize] = true;
        at = prev[at as usize];
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::{DiffRun, ListDiff};

    fn diff(old: &[u32], new: &[u32]) -> Option<ListDiff> {
        ListDiff::new(old, new)
    }

    /// The new rows the diff makes of `old`, new rows taken from `new`.
    fn apply(old: &[u32], new: &[u32], diff: &ListDiff) -> Vec<u32> {
        let mut out = Vec::new();
        for run in &diff.runs {
            match run.from() {
                Some(from) => {
                    out.extend_from_slice(&old[from as usize..(from + run.len()) as usize])
                }
                None => out.extend_from_slice(&new[out.len()..out.len() + run.len() as usize]),
            }
        }
        out
    }

    fn moved(diff: &ListDiff) -> u32 {
        diff.runs
            .iter()
            .filter(|r| matches!(r, DiffRun::Moved { .. }))
            .map(DiffRun::len)
            .sum()
    }

    #[test]
    fn the_same_rows_are_no_change() {
        assert_eq!(diff(&[1, 2, 3], &[1, 2, 3]), None);
        assert_eq!(diff(&[], &[]), None);
    }

    #[test]
    fn a_change_in_one_place_is_a_splice() {
        let splice = |old: &[u32], new: &[u32]| diff(old, new).and_then(|d| d.as_splice());
        assert_eq!(splice(&[1, 2, 3], &[0, 1, 2, 3]), Some((0, 0, 1)));
        assert_eq!(splice(&[1, 2, 3], &[1, 3]), Some((1, 1, 0)));
        assert_eq!(splice(&[1, 2, 3], &[1, 2, 3, 4]), Some((3, 0, 1)));
        assert_eq!(splice(&[1, 2, 3], &[1, 9, 3]), Some((1, 1, 1)));
        assert_eq!(splice(&[1, 2, 3], &[]), Some((0, 3, 0)));
        assert_eq!(splice(&[], &[1, 2]), Some((0, 0, 2)));
        // A sliding window is two changes.
        assert_eq!(splice(&[1, 2, 3], &[2, 3, 4]), None);
        for (at, removed, inserted) in [(0, 0, 1), (1, 1, 0), (3, 0, 2), (1, 2, 1)] {
            let d = ListDiff::splice(3, at, removed, inserted);
            assert_eq!(d.as_splice(), Some((at, removed, inserted)), "{d:?}");
        }
    }

    #[test]
    fn repeated_keys_pair_up_in_order() {
        assert_eq!(diff(&[1, 1], &[1]).unwrap().as_splice(), Some((1, 1, 0)));
        let d = diff(&[1, 2, 1], &[1, 1, 2]).unwrap();
        assert_eq!(apply(&[1, 2, 1], &[1, 1, 2], &d), [1, 1, 2]);
        assert_eq!(moved(&d), 1);
        // Rows without a key match nothing.
        let d = ListDiff::new_partial(&[None, Some(1)], &[None, Some(1)]).unwrap();
        assert_eq!(d.as_splice(), Some((0, 1, 1)));
    }

    #[test]
    fn a_row_moved_up_moves_alone() {
        let old: Vec<u32> = (0..12).collect();
        let mut new = old.clone();
        let row = new.remove(10);
        new.insert(2, row);
        let d = diff(&old, &new).unwrap();
        assert_eq!(
            d.runs,
            [
                DiffRun::Kept { from: 0, len: 2 },
                DiffRun::Moved { from: 10, len: 1 },
                DiffRun::Kept { from: 2, len: 8 },
                DiffRun::Kept { from: 11, len: 1 },
            ]
        );
        assert_eq!(d.new_index(10), Some((2, true)));
        assert_eq!(d.new_index(2), Some((3, false)));
        assert_eq!(d.new_index(11), Some((11, false)));
        assert_eq!(d.as_splice(), None);
    }

    #[test]
    fn moves_inserts_and_removes_mix() {
        let old = [1, 2, 3, 4, 5, 6, 7, 8];
        let new = [9, 6, 1, 2, 4, 5, 10, 8, 3];
        let d = diff(&old, &new).unwrap();
        assert_eq!(apply(&old, &new, &d), new);
        assert_eq!(d.new_len, 9);
        // 7 went; 6 and 3 moved; 1, 2, 4, 5, 8 kept their order.
        assert_eq!(moved(&d), 2);
        let indices = d.new_indices();
        assert_eq!(indices[6], None);
        assert_eq!(indices[5], Some(1));
        assert_eq!(indices[2], Some(8));
        for (i, n) in indices.iter().enumerate() {
            assert_eq!(*n, d.new_index(i as u32).map(|(n, _)| n));
        }
    }

    #[test]
    fn a_diff_inside_a_list_widens_to_it() {
        let d = diff(&[3, 4, 5], &[5, 3, 9]).unwrap().widened(2, 1);
        let (old, new) = ([1, 2, 3, 4, 5, 6], [1, 2, 5, 3, 9, 6]);
        assert_eq!(d, diff(&old, &new).unwrap());
        assert_eq!(apply(&old, &new, &d), new);
    }

    #[test]
    fn reversing_keeps_one_row_and_moves_the_rest() {
        let old: Vec<u32> = (0..6).collect();
        let new: Vec<u32> = (0..6).rev().collect();
        let d = diff(&old, &new).unwrap();
        assert_eq!(apply(&old, &new, &d), new);
        assert_eq!(moved(&d), 5);
    }

    #[test]
    fn large_lists_diff_quickly() {
        // 100 000 rows, every other one moved by a rotation of pairs: well
        // within a test's time only if the diff is not quadratic.
        let old: Vec<u32> = (0..100_000).collect();
        let mut new = old.clone();
        new.rotate_left(1);
        for pair in new.chunks_mut(2) {
            pair.swap(0, pair.len() - 1);
        }
        let start = std::time::Instant::now();
        let d = diff(&old, &new).unwrap();
        assert_eq!(apply(&old, &new, &d), new);
        assert!(start.elapsed().as_secs_f32() < 2.0, "{:?}", start.elapsed());
    }
}
