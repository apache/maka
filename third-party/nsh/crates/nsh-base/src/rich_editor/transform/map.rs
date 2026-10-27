//! Position maps: how positions in a document before a change correspond
//! to positions after it (prosemirror-transform's `map.ts`).

const DEL_BEFORE: u8 = 1;
const DEL_AFTER: u8 = 2;
const DEL_ACROSS: u8 = 4;
const DEL_SIDE: u8 = 8;

/// Something positions can be mapped through: a [`StepMap`] or a
/// [`Mapping`].
pub trait Mappable {
    /// Maps a position. `assoc` (-1 or 1) says which side the position
    /// sticks to when content is inserted right at it.
    fn map(&self, pos: usize, assoc: i8) -> usize;
    /// Maps a position and tells what was deleted around it.
    fn map_result(&self, pos: usize, assoc: i8) -> MapResult;
}

/// A mapped position with what the mapping deleted around it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct MapResult {
    /// The mapped position.
    pub pos: usize,
    /// The token on the side `assoc` points to was deleted.
    pub deleted: bool,
    /// The token before the position was deleted.
    pub deleted_before: bool,
    /// The token after the position was deleted.
    pub deleted_after: bool,
    /// A deletion spanned the position (the tokens on both sides).
    pub deleted_across: bool,
    pub(crate) del_info: u8,
    /// The range index and offset into it, kept to recover the position
    /// through a mirroring map; `None` when the position sits on the
    /// range's edge on its `assoc` side.
    pub(crate) recover: Option<(usize, usize)>,
}

impl MapResult {
    fn new(pos: usize, del_info: u8, recover: Option<(usize, usize)>) -> Self {
        Self {
            pos,
            deleted: del_info & DEL_SIDE != 0,
            deleted_before: del_info & (DEL_BEFORE | DEL_ACROSS) != 0,
            deleted_after: del_info & (DEL_AFTER | DEL_ACROSS) != 0,
            deleted_across: del_info & DEL_ACROSS != 0,
            del_info,
            recover,
        }
    }
}

/// The changed ranges of one step, as `[start, old_size, new_size]`
/// triples in `ranges`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct StepMap {
    /// Triples of start, old size and new size, in increasing order.
    pub ranges: Vec<usize>,
    /// Maps from the new document to the old one.
    pub inverted: bool,
}

impl StepMap {
    /// A map with the given ranges.
    pub fn new(ranges: Vec<usize>, inverted: bool) -> Self {
        Self { ranges, inverted }
    }

    /// A map that changes nothing.
    pub fn empty() -> Self {
        Self::default()
    }

    /// A map that moves every position by `n` (negative: deletes `-n`
    /// at the start), for steps of a sub-document applied to a larger
    /// one or the other way around.
    pub fn offset(n: isize) -> Self {
        match n {
            0 => Self::empty(),
            n if n < 0 => Self::new(vec![0, n.unsigned_abs(), 0], false),
            n => Self::new(vec![0, 0, n as usize], false),
        }
    }

    fn indices(&self) -> (usize, usize) {
        if self.inverted { (2, 1) } else { (1, 2) }
    }

    pub(crate) fn recover(&self, (index, offset): (usize, usize)) -> usize {
        let mut diff: isize = 0;
        if !self.inverted {
            for i in 0..index {
                diff += self.ranges[i * 3 + 2] as isize - self.ranges[i * 3 + 1] as isize;
            }
        }
        (self.ranges[index * 3] as isize + diff) as usize + offset
    }

    fn map_inner(&self, pos: usize, assoc: i8) -> MapResult {
        let mut diff: isize = 0;
        let (old_index, new_index) = self.indices();
        let mut i = 0;
        while i < self.ranges.len() {
            let start = self.ranges[i] as isize - if self.inverted { diff } else { 0 };
            let start = start as usize;
            if start > pos {
                break;
            }
            let old_size = self.ranges[i + old_index];
            let new_size = self.ranges[i + new_index];
            let end = start + old_size;
            if pos <= end {
                let side = if old_size == 0 {
                    assoc
                } else if pos == start {
                    -1
                } else if pos == end {
                    1
                } else {
                    assoc
                };
                let result = (start as isize + diff) as usize + if side < 0 { 0 } else { new_size };
                let edge = if assoc < 0 { start } else { end };
                let recover = if pos == edge {
                    None
                } else {
                    Some((i / 3, pos - start))
                };
                let mut del = 0;
                if old_size != 0 {
                    del |= if pos == start {
                        DEL_AFTER
                    } else if pos == end {
                        DEL_BEFORE
                    } else {
                        DEL_ACROSS
                    };
                    if if assoc < 0 { pos != start } else { pos != end } {
                        del |= DEL_SIDE;
                    }
                }
                return MapResult::new(result, del, recover);
            }
            diff += new_size as isize - old_size as isize;
            i += 3;
        }
        MapResult::new((pos as isize + diff) as usize, 0, None)
    }

    /// Calls `f(old_start, old_end, new_start, new_end)` for every
    /// changed range.
    pub fn for_each(&self, mut f: impl FnMut(usize, usize, usize, usize)) {
        let (old_index, new_index) = self.indices();
        let mut diff: isize = 0;
        let mut i = 0;
        while i < self.ranges.len() {
            let start = self.ranges[i] as isize;
            let old_start = (start - if self.inverted { diff } else { 0 }) as usize;
            let new_start = (start + if self.inverted { 0 } else { diff }) as usize;
            let old_size = self.ranges[i + old_index];
            let new_size = self.ranges[i + new_index];
            f(
                old_start,
                old_start + old_size,
                new_start,
                new_start + new_size,
            );
            diff += new_size as isize - old_size as isize;
            i += 3;
        }
    }

    /// Maps a position ([`Mappable::map`], without importing the trait).
    pub fn map(&self, pos: usize, assoc: i8) -> usize {
        self.map_inner(pos, assoc).pos
    }

    /// Maps a position with what was deleted around it.
    pub fn map_result(&self, pos: usize, assoc: i8) -> MapResult {
        self.map_inner(pos, assoc)
    }

    /// The map from the document after the step to the one before it.
    pub fn invert(&self) -> StepMap {
        StepMap::new(self.ranges.clone(), !self.inverted)
    }
}

impl Mappable for StepMap {
    fn map(&self, pos: usize, assoc: i8) -> usize {
        StepMap::map(self, pos, assoc)
    }

    fn map_result(&self, pos: usize, assoc: i8) -> MapResult {
        self.map_inner(pos, assoc)
    }
}

/// A pipeline of step maps, which maps losslessly through steps followed
/// by their inverses (`mirror` pairs), as rebasing for collaboration and
/// history does.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Mapping {
    /// The step maps, in order.
    pub maps: Vec<StepMap>,
    /// Pairs of indices of maps that mirror each other.
    pub mirror: Vec<(usize, usize)>,
    /// The first map `map` uses.
    pub from: usize,
    /// The end of the maps `map` uses.
    pub to: usize,
}

impl Mapping {
    /// An empty mapping.
    pub fn new() -> Self {
        Self::default()
    }

    /// A mapping through the given maps.
    pub fn from_maps(maps: Vec<StepMap>) -> Self {
        let to = maps.len();
        Self {
            maps,
            mirror: Vec::new(),
            from: 0,
            to,
        }
    }

    /// A mapping through the maps `from..to` of this one only.
    pub fn slice(&self, from: usize, to: usize) -> Mapping {
        Mapping {
            maps: self.maps.clone(),
            mirror: self.mirror.clone(),
            from,
            to,
        }
    }

    /// A mapping through the maps from `from` on.
    pub fn slice_from(&self, from: usize) -> Mapping {
        self.slice(from, self.maps.len())
    }

    /// Appends a map; `mirror` is the index of the map it mirrors.
    pub fn append_map(&mut self, map: StepMap, mirror: Option<usize>) {
        self.maps.push(map);
        self.to = self.maps.len();
        if let Some(m) = mirror {
            self.mirror.push((self.maps.len() - 1, m));
        }
    }

    /// Appends all the maps of `mapping`, with their mirrors.
    pub fn append_mapping(&mut self, mapping: &Mapping) {
        let start_size = self.maps.len();
        for (i, map) in mapping.maps.iter().enumerate() {
            let mirror = mapping
                .get_mirror(i)
                .filter(|&m| m < i)
                .map(|m| start_size + m);
            self.append_map(map.clone(), mirror);
        }
    }

    /// The index of the map mirroring the map at `n`.
    pub fn get_mirror(&self, n: usize) -> Option<usize> {
        self.mirror.iter().find_map(|&(a, b)| {
            if a == n {
                Some(b)
            } else if b == n {
                Some(a)
            } else {
                None
            }
        })
    }

    /// Appends the inverse of `mapping`.
    pub fn append_mapping_inverted(&mut self, mapping: &Mapping) {
        let total = self.maps.len() + mapping.maps.len();
        for i in (0..mapping.maps.len()).rev() {
            let mirror = mapping
                .get_mirror(i)
                .filter(|&m| m > i)
                .map(|m| total - m - 1);
            self.append_map(mapping.maps[i].invert(), mirror);
        }
    }

    /// The inverse of this mapping.
    pub fn invert(&self) -> Mapping {
        let mut inverse = Mapping::new();
        inverse.append_mapping_inverted(self);
        inverse
    }

    /// Drops the maps from `len` on (and mirrors naming them), undoing
    /// appends.
    pub(crate) fn truncate(&mut self, len: usize) {
        self.maps.truncate(len);
        self.mirror.retain(|&(a, b)| a < len && b < len);
        self.to = self.to.min(len);
        self.from = self.from.min(len);
    }

    /// Maps a position ([`Mappable::map`], without importing the trait).
    pub fn map(&self, pos: usize, assoc: i8) -> usize {
        if !self.mirror.is_empty() {
            return self.map_inner(pos, assoc).pos;
        }
        self.maps[self.from..self.to]
            .iter()
            .fold(pos, |pos, map| map.map(pos, assoc))
    }

    /// Maps a position with what was deleted around it.
    pub fn map_result(&self, pos: usize, assoc: i8) -> MapResult {
        self.map_inner(pos, assoc)
    }

    fn map_inner(&self, mut pos: usize, assoc: i8) -> MapResult {
        let mut del_info = 0;
        let mut i = self.from;
        while i < self.to {
            let map = &self.maps[i];
            let result = map.map_result(pos, assoc);
            if let Some(recover) = result.recover
                && let Some(corr) = self.get_mirror(i)
                && corr > i
                && corr < self.to
            {
                i = corr;
                pos = self.maps[corr].recover(recover);
                i += 1;
                continue;
            }
            del_info |= result.del_info;
            pos = result.pos;
            i += 1;
        }
        MapResult::new(pos, del_info, None)
    }
}

impl Mappable for Mapping {
    fn map(&self, pos: usize, assoc: i8) -> usize {
        Mapping::map(self, pos, assoc)
    }

    fn map_result(&self, pos: usize, assoc: i8) -> MapResult {
        self.map_inner(pos, assoc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(ranges: &[usize]) -> StepMap {
        StepMap::new(ranges.to_vec(), false)
    }

    #[test]
    fn maps_around_an_insertion() {
        let map = mk(&[2, 0, 4]);
        assert_eq!(map.map(0, 1), 0);
        assert_eq!(map.map(2, 1), 6);
        assert_eq!(map.map(2, -1), 2);
        assert_eq!(map.map(3, 1), 7);
        assert!(!map.map_result(2, 1).deleted);
    }

    #[test]
    fn maps_through_a_deletion() {
        let map = mk(&[2, 4, 0]);
        let r = map.map_result(4, 1);
        assert_eq!(r.pos, 2);
        assert!(r.deleted && r.deleted_across && r.deleted_before && r.deleted_after);
        let start = map.map_result(2, 1);
        assert_eq!(start.pos, 2);
        assert!(start.deleted && start.deleted_after && !start.deleted_before);
        let start_left = map.map_result(2, -1);
        assert!(!start_left.deleted);
        let end = map.map_result(6, -1);
        assert!(end.deleted && end.deleted_before && !end.deleted_after);
        assert!(!map.map_result(6, 1).deleted);
        assert_eq!(map.map(8, 1), 4);
    }

    #[test]
    fn maps_a_replacement() {
        let map = mk(&[2, 4, 2]);
        assert_eq!(map.map(2, 1), 2);
        assert_eq!(map.map(6, -1), 4);
        assert_eq!(map.map(4, -1), 2);
        assert_eq!(map.map(4, 1), 4);
        assert_eq!(map.map(10, 1), 8);
    }

    #[test]
    fn inverts() {
        let map = mk(&[2, 0, 4]);
        let inv = map.invert();
        assert_eq!(inv.map(6, 1), 2);
        assert_eq!(inv.map(8, 1), 4);
        let mut seen = vec![];
        map.for_each(|a, b, c, d| seen.push((a, b, c, d)));
        assert_eq!(seen, vec![(2, 2, 2, 6)]);
        let mut seen = vec![];
        inv.for_each(|a, b, c, d| seen.push((a, b, c, d)));
        assert_eq!(seen, vec![(2, 6, 2, 2)]);
    }

    #[test]
    fn offsets() {
        assert_eq!(StepMap::offset(3).map(1, 1), 4);
        assert_eq!(StepMap::offset(-2).map(5, 1), 3);
        assert_eq!(StepMap::offset(0), StepMap::empty());
    }

    #[test]
    fn mirrors_recover_deleted_positions() {
        // A deletion followed by its inverse: positions inside the
        // deleted range come back where they were.
        let del = mk(&[2, 4, 0]);
        let mut mapping = Mapping::new();
        mapping.append_map(del.clone(), None);
        mapping.append_map(del.invert(), Some(0));
        assert_eq!(mapping.map(4, 1), 4);
        assert_eq!(mapping.map(3, -1), 3);
        assert_eq!(mapping.map(8, 1), 8);
        // Without the mirror, the position collapses.
        let plain = Mapping::from_maps(vec![del.clone(), del.invert()]);
        assert_ne!(plain.map(4, 1), 4);
    }

    #[test]
    fn mapping_inverts_and_slices() {
        let mut mapping = Mapping::new();
        mapping.append_map(mk(&[0, 0, 2]), None);
        mapping.append_map(mk(&[4, 0, 3]), None);
        assert_eq!(mapping.map(5, 1), 10);
        assert_eq!(mapping.invert().map(10, 1), 5);
        assert_eq!(mapping.slice(1, 2).map(5, 1), 8);
        let mut appended = Mapping::new();
        appended.append_mapping(&mapping);
        assert_eq!(appended.map(5, 1), 10);
        mapping.truncate(1);
        assert_eq!(mapping.map(5, 1), 7);
    }
}
