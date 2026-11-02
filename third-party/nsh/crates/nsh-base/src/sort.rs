//! Stable sorts of the components' short lists (folds, marks, columns,
//! extensions, ...) with one instance of the standard library's sort: a
//! `sort_by` per element type and comparator is some kilobytes of code
//! each, and these lists are not on a hot path. The sort orders indices
//! with a comparator behind a reference, then moves the elements into that
//! order.

use std::cmp::Ordering;

/// `v` sorted by `compare`, stably (as `<[T]>::sort_by`).
pub(crate) fn sort_by<T>(v: &mut [T], mut compare: impl FnMut(&T, &T) -> Ordering) {
    if v.len() < 2 {
        return;
    }
    let order = sorted_order(v.len(), &mut |a, b| compare(&v[a], &v[b]));
    permute(order, &mut |a, b| v.swap(a, b));
}

/// `v` sorted by the key `key` makes of each element, stably (as
/// `<[T]>::sort_by_key`).
pub(crate) fn sort_by_key<T, K: Ord>(v: &mut [T], mut key: impl FnMut(&T) -> K) {
    sort_by(v, |a, b| key(a).cmp(&key(b)));
}

/// The indices `0..len` in the order `compare` sorts them.
#[inline(never)]
fn sorted_order(len: usize, compare: &mut dyn FnMut(usize, usize) -> Ordering) -> Vec<usize> {
    let mut order: Vec<usize> = (0..len).collect();
    order.sort_by(|&a, &b| compare(a, b));
    order
}

/// Moves the elements so that the one at `order[i]` ends at `i`, with
/// `swap`, cycle by cycle.
#[inline(never)]
fn permute(mut order: Vec<usize>, swap: &mut dyn FnMut(usize, usize)) {
    for start in 0..order.len() {
        let mut at = start;
        // An index in place (or a cycle done) names itself.
        while order[at] != start {
            let next = order[at];
            order[at] = at;
            swap(at, next);
            at = next;
        }
        order[at] = at;
    }
}

#[cfg(test)]
mod tests {
    use super::{sort_by, sort_by_key};

    #[test]
    fn sorts_stably_as_the_standard_sort() {
        let mut seed = 7u32;
        for len in 0..40 {
            let mut v: Vec<(u32, usize)> = (0..len)
                .map(|i| {
                    seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                    ((seed >> 16) % 5, i)
                })
                .collect();
            let mut expected = v.clone();
            expected.sort_by_key(|e| e.0);
            sort_by_key(&mut v, |e| e.0);
            assert_eq!(v, expected);
        }
        let mut words = vec!["pear", "fig", "apple", "kiwi", "date"];
        sort_by(&mut words, |a, b| b.len().cmp(&a.len()));
        assert_eq!(words, ["apple", "pear", "kiwi", "date", "fig"]);
    }
}
