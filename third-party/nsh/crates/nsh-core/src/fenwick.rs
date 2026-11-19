/// Prefix sums of item sizes with O(log n) update and search: the list
/// needs "offset of item i" and "item at offset y" on every scroll frame.
///
/// Sums are `f64` so thousands of updates do not accumulate float error.
#[derive(Debug, Default, Clone)]
pub(crate) struct Fenwick {
    tree: Vec<f64>,
}

impl Fenwick {
    /// Builds from item sizes in O(n).
    pub(crate) fn from_sizes(sizes: impl ExactSizeIterator<Item = f64>) -> Self {
        let n = sizes.len();
        let mut tree = vec![0.0; n + 1];
        for (i, size) in sizes.enumerate() {
            tree[i + 1] += size;
            let parent = (i + 1) + (i + 1).isolate_lowest_one();
            if parent <= n {
                tree[parent] += tree[i + 1];
            }
        }
        Self { tree }
    }

    pub(crate) fn len(&self) -> usize {
        self.tree.len().saturating_sub(1)
    }

    /// Adds `delta` to item `i`.
    pub(crate) fn add(&mut self, i: usize, delta: f64) {
        let mut i = i + 1;
        while i < self.tree.len() {
            self.tree[i] += delta;
            i += i.isolate_lowest_one();
        }
    }

    /// Appends an item of `size` in O(log n): node `j` covers
    /// `(j - lowbit(j), j]`, whose earlier items are already summed.
    pub(crate) fn push(&mut self, size: f64) {
        if self.tree.is_empty() {
            self.tree.push(0.0);
        }
        let j = self.tree.len();
        let low = j - j.isolate_lowest_one();
        let covered = self.prefix(j - 1) - self.prefix(low);
        self.tree.push(size + covered);
    }

    /// Drops the items past the first `len` in O(1): no node of the
    /// kept prefix covers a dropped item.
    pub(crate) fn truncate(&mut self, len: usize) {
        if len < self.len() {
            self.tree.truncate(len + 1);
        }
    }

    /// Sum of items `[0, i)`: the offset of item `i`.
    pub(crate) fn prefix(&self, i: usize) -> f64 {
        let mut i = i.min(self.len());
        let mut sum = 0.0;
        while i > 0 {
            sum += self.tree[i];
            i &= i - 1;
        }
        sum
    }

    /// Sum of all items.
    pub(crate) fn total(&self) -> f64 {
        self.prefix(self.len())
    }

    /// The item containing offset `y`: the largest `i` with
    /// `prefix(i) <= y`, clamped to the last item.
    pub(crate) fn find(&self, y: f64) -> usize {
        let n = self.len();
        if n == 0 {
            return 0;
        }
        let mut pos = 0;
        let mut rest = y;
        let mut step = n.next_power_of_two();
        while step > 0 {
            let next = pos + step;
            if next <= n && self.tree[next] <= rest {
                pos = next;
                rest -= self.tree[next];
            }
            step >>= 1;
        }
        pos.min(n - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_find_and_update() {
        let sizes = [10.0, 20.0, 30.0, 40.0, 50.0];
        let mut f = Fenwick::from_sizes(sizes.iter().copied());
        assert_eq!(f.prefix(0), 0.0);
        assert_eq!(f.prefix(3), 60.0);
        assert_eq!(f.total(), 150.0);
        assert_eq!(f.find(0.0), 0);
        assert_eq!(f.find(9.9), 0);
        assert_eq!(f.find(10.0), 1);
        assert_eq!(f.find(59.0), 2);
        assert_eq!(f.find(1e9), 4);
        f.add(1, 5.0);
        assert_eq!(f.prefix(2), 35.0);
        assert_eq!(f.find(34.0), 1);
        // Against a naive scan on many sizes.
        let sizes: Vec<f64> = (0..1000).map(|i| (i % 7 + 1) as f64 * 3.5).collect();
        let f = Fenwick::from_sizes(sizes.iter().copied());
        let mut acc = 0.0;
        for (i, s) in sizes.iter().enumerate() {
            assert!((f.prefix(i) - acc).abs() < 1e-9);
            assert_eq!(f.find(acc + s / 2.0), i);
            acc += s;
        }
    }

    #[test]
    fn push_and_truncate_match_a_rebuild() {
        let sizes: Vec<f64> = (0..777).map(|i| (i % 11 + 1) as f64 * 2.5).collect();
        let mut f = Fenwick::default();
        for (i, &s) in sizes.iter().enumerate() {
            f.push(s);
            let built = Fenwick::from_sizes(sizes[..=i].iter().copied());
            assert_eq!(f.tree, built.tree, "after {i}");
        }
        for len in [500, 333, 64, 63, 1, 0] {
            f.truncate(len);
            let built = Fenwick::from_sizes(sizes[..len].iter().copied());
            assert_eq!(f.len(), len);
            for i in 0..=len {
                assert!((f.prefix(i) - built.prefix(i)).abs() < 1e-9);
            }
        }
    }
}
