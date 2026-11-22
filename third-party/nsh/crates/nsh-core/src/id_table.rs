//! A table indexed by node id whose memory follows the ids in use.
//!
//! Node ids only grow (a node's id is never given to another), so a `Vec`
//! indexed by id grows with every node an app ever made, not with the
//! nodes alive: a chat that streams for a day makes tens of millions. An
//! [`IdTable`] keeps its entries in pages of [`PAGE`] ids and frees a page
//! once its last entry is removed, so what it holds is about the live
//! entries, plus one pointer per page of ids ever used.

/// Ids per page.
pub const PAGE: usize = 1024;

struct Page<T> {
    entries: Box<[Option<T>]>,
    used: usize,
}

/// Entries by id (a `usize` index), in pages freed when they empty.
pub struct IdTable<T> {
    pages: Vec<Option<Page<T>>>,
    len: usize,
}

impl<T> Default for IdTable<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> IdTable<T> {
    /// An empty table.
    pub const fn new() -> Self {
        IdTable {
            pages: Vec::new(),
            len: 0,
        }
    }

    /// How many entries it holds.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Whether it holds none.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// One past the highest id whose page is in use: a bound on the ids
    /// it holds.
    pub fn extent(&self) -> usize {
        self.pages.len() * PAGE
    }

    /// How many pages hold entries (what it keeps beyond one pointer per
    /// page of ids up to [`Self::extent`]).
    pub fn pages(&self) -> usize {
        self.pages.iter().filter(|p| p.is_some()).count()
    }

    /// The entry of `id`.
    #[inline]
    pub fn get(&self, id: usize) -> Option<&T> {
        self.pages.get(id / PAGE)?.as_ref()?.entries[id % PAGE].as_ref()
    }

    /// The entry of `id`, to change.
    #[inline]
    pub fn get_mut(&mut self, id: usize) -> Option<&mut T> {
        self.pages.get_mut(id / PAGE)?.as_mut()?.entries[id % PAGE].as_mut()
    }

    /// Whether `id` has an entry.
    #[inline]
    pub fn contains(&self, id: usize) -> bool {
        self.get(id).is_some()
    }

    /// Sets the entry of `id`; returns the one it replaced.
    pub fn insert(&mut self, id: usize, value: T) -> Option<T> {
        let at = id / PAGE;
        if at >= self.pages.len() {
            self.pages.resize_with(at + 1, || None);
        }
        let page = self.pages[at].get_or_insert_with(|| Page {
            entries: std::iter::repeat_with(|| None).take(PAGE).collect(),
            used: 0,
        });
        let old = page.entries[id % PAGE].replace(value);
        if old.is_none() {
            page.used += 1;
            self.len += 1;
        }
        old
    }

    /// Removes the entry of `id`, freeing its page when it was the last.
    pub fn remove(&mut self, id: usize) -> Option<T> {
        let at = id / PAGE;
        let page = self.pages.get_mut(at)?.as_mut()?;
        let old = page.entries[id % PAGE].take()?;
        page.used -= 1;
        self.len -= 1;
        if page.used == 0 {
            self.pages[at] = None;
            while matches!(self.pages.last(), Some(None)) {
                self.pages.pop();
            }
            if self.pages.capacity() > 2 * self.pages.len() + 64 {
                self.pages.shrink_to_fit();
            }
        }
        Some(old)
    }

    /// Removes every entry.
    pub fn clear(&mut self) {
        self.pages = Vec::new();
        self.len = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::{IdTable, PAGE};

    #[test]
    fn entries_go_in_and_out_by_id() {
        let mut t = IdTable::new();
        assert_eq!(t.get(3), None);
        assert_eq!(t.insert(3, "a"), None);
        assert_eq!(t.insert(3, "b"), Some("a"));
        assert_eq!(t.get(3), Some(&"b"));
        *t.get_mut(3).unwrap() = "c";
        assert_eq!(t.len(), 1);
        assert_eq!(t.remove(3), Some("c"));
        assert_eq!(t.remove(3), None);
        assert!(t.is_empty());
    }

    #[test]
    fn memory_follows_the_ids_in_use_not_every_id_made() {
        let mut t = IdTable::new();
        // A long-lived entry, then a stream of short-lived ones with ever
        // higher ids, as an app makes and drops nodes.
        t.insert(1, 1u32);
        let mut live = std::collections::VecDeque::new();
        for id in 2..2_000_000usize {
            t.insert(id, id as u32);
            live.push_back(id);
            if live.len() > 500 {
                let old = live.pop_front().unwrap();
                assert_eq!(t.remove(old), Some(old as u32));
            }
        }
        assert_eq!(t.len(), 501);
        let pages = t.pages();
        assert!(pages <= 3, "{pages} pages hold 501 entries");
        assert_eq!(t.get(1), Some(&1));
        // The newest ids are all still there.
        for &id in &live {
            assert_eq!(t.get(id), Some(&(id as u32)));
        }
    }

    #[test]
    fn the_last_pages_go_when_they_empty() {
        let mut t = IdTable::new();
        t.insert(5, ());
        t.insert(10 * PAGE, ());
        assert_eq!(t.extent(), 11 * PAGE);
        t.remove(10 * PAGE);
        assert_eq!(t.extent(), PAGE);
        t.remove(5);
        assert_eq!(t.extent(), 0);
    }
}
