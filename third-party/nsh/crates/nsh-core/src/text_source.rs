//! Canonical source positions carried by rendered text, independent of nodes.

use std::{collections::BTreeMap, sync::Arc};

use crate::TextLine;

/// Canonical source coverage of a native virtual list's current projection.
/// Rows may own disjoint ranges, including footnotes placed after the body.
/// This describes source addressing, independently of which cells are mounted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ListSourceRows {
    /// Stable identity of the current complete source.
    pub id: Arc<str>,
    /// UTF-8 length of the current complete source.
    pub source_len: u64,
    /// UTF-8 length captured by the projection that produced these rows.
    pub projection_len: u64,
    /// Canonical UTF-8 ranges for each logical row, in row order.
    pub rows: Arc<[Vec<std::ops::Range<u64>>]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SourceRow {
    Pending,
    Row(u32),
    Closed,
}

impl ListSourceRows {
    pub(crate) fn row(&self, byte: u64) -> SourceRow {
        let byte = byte.min(self.source_len);
        if self.projection_len < self.source_len && byte >= self.projection_len {
            return SourceRow::Pending;
        }
        let mut forward = None::<(u64, u32)>;
        let mut tail = None::<(u64, u32)>;
        for (index, ranges) in self.rows.iter().enumerate() {
            for range in ranges {
                if range.start <= byte && byte < range.end {
                    return SourceRow::Row(index as u32);
                }
                if range.start > byte && forward.is_none_or(|(start, _)| range.start < start) {
                    forward = Some((range.start, index as u32));
                }
                if tail.is_none_or(|(end, _)| range.end > end) {
                    tail = Some((range.end, index as u32));
                }
            }
        }
        forward
            .or(tail)
            .map_or(SourceRow::Closed, |(_, row)| SourceRow::Row(row))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum SourcePosition {
    Ready(f32),
    Pending,
    Closed,
}

/// The canonical source represented by a text span.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextSource {
    /// The span is verbatim UTF-8 source, beginning at `offset`.
    Literal {
        /// Stable document identity, shared across alternative renderings.
        id: Arc<str>,
        /// Absolute UTF-8 byte offset in that document.
        offset: u64,
    },
    /// Explicit mappings for text transformed by a document parser.
    Mapped {
        /// Stable document identity, shared across alternative renderings.
        id: Arc<str>,
        /// Nonoverlapping mappings in this span's local UTF-16 coordinates.
        segments: Vec<TextSourceSegment>,
    },
}

/// One rendered source segment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TextSourceSegment {
    /// Inclusive local UTF-16 start.
    pub start: u32,
    /// Exclusive local UTF-16 end.
    pub end: u32,
    /// Inclusive canonical UTF-8 byte start.
    pub source_start: u64,
    /// Exclusive canonical UTF-8 byte end.
    pub source_end: u64,
    /// Whether the source was copied or replaced as one lexical unit.
    pub kind: TextSourceKind,
}

/// How a parser rendered a source segment.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TextSourceKind {
    /// Verbatim text; UTF-8/UTF-16 conversion uses the actual rendered text.
    #[default]
    Literal,
    /// One indivisible conversion, such as an entity or an escaped character.
    Replacement,
}

/// A reading position has source identity, never a recyclable node identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SourcePoint {
    pub id: Arc<str>,
    pub byte: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MappedRange {
    id: Arc<str>,
    start: u32,
    end: u32,
    byte_start: usize,
    source_start: u64,
    source_end: u64,
    kind: TextSourceKind,
}

/// Derived from text flattening; it neither changes glyphs nor owns scrolling.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SourceMap(Vec<MappedRange>);

struct Scope {
    source: Arc<TextSource>,
    start: u32,
    end: u32,
}

/// Only source scopes and raw-text boundaries, never a per-character table.
#[derive(Default)]
pub(crate) struct SourceCollector {
    scopes: Vec<Scope>,
    chunks: Vec<(usize, u32, u32)>,
}

impl SourceCollector {
    pub(crate) fn begin(&mut self, source: Arc<TextSource>, start: u32) -> usize {
        let key = self.scopes.len();
        self.scopes.push(Scope {
            source,
            start,
            end: start,
        });
        key
    }

    pub(crate) fn end(&mut self, scope: usize, end: u32) {
        self.scopes[scope].end = end;
    }

    pub(crate) fn text(&mut self, scope: Option<usize>, start: u32, end: u32) {
        if let Some(scope) = scope.filter(|_| start < end) {
            self.chunks.push((scope, start, end));
        }
    }

    pub(crate) fn finish(self, text: &str) -> SourceMap {
        if self.scopes.is_empty() {
            return SourceMap::default();
        }
        let mut needed = Vec::new();
        for scope in &self.scopes {
            needed.extend([scope.start, scope.end]);
            if let TextSource::Mapped { segments, .. } = &*scope.source {
                for segment in segments {
                    if let (Some(start), Some(end)) = (
                        scope.start.checked_add(segment.start),
                        scope.start.checked_add(segment.end),
                    ) {
                        needed.extend([start, end]);
                    }
                }
            }
        }
        for &(_, start, end) in &self.chunks {
            needed.extend([start, end]);
        }
        let bytes = byte_boundaries(text, needed);
        let valid: Vec<bool> = self
            .scopes
            .iter()
            .map(|scope| {
                let Some(&begin) = bytes.get(&scope.start) else {
                    return false;
                };
                let Some(&end) = bytes.get(&scope.end) else {
                    return false;
                };
                match &*scope.source {
                    TextSource::Literal { offset, .. } => {
                        offset.checked_add((end - begin) as u64).is_some()
                    }
                    TextSource::Mapped { segments, .. } => {
                        segments.windows(2).all(|pair| pair[0].end <= pair[1].start)
                            && segments.iter().all(|segment| {
                                let Some(start) = scope.start.checked_add(segment.start) else {
                                    return false;
                                };
                                let Some(end) = scope.start.checked_add(segment.end) else {
                                    return false;
                                };
                                let (Some(&a), Some(&b)) = (bytes.get(&start), bytes.get(&end))
                                else {
                                    return false;
                                };
                                start < end
                                    && end <= scope.end
                                    && segment.source_start <= segment.source_end
                                    && match segment.kind {
                                        TextSourceKind::Literal => {
                                            segment.source_end - segment.source_start
                                                == (b - a) as u64
                                        }
                                        TextSourceKind::Replacement => {
                                            segment.source_start < segment.source_end
                                        }
                                    }
                            })
                    }
                }
            })
            .collect();
        let mut out = Vec::new();
        for (scope_key, start, end) in self.chunks {
            if !valid[scope_key] {
                continue;
            }
            let scope = &self.scopes[scope_key];
            let (a, b) = (bytes[&start], bytes[&end]);
            match &*scope.source {
                TextSource::Literal { id, offset } => out.push(MappedRange {
                    id: id.clone(),
                    start,
                    end,
                    byte_start: a,
                    source_start: offset + (a - bytes[&scope.start]) as u64,
                    source_end: offset + (b - bytes[&scope.start]) as u64,
                    kind: TextSourceKind::Literal,
                }),
                TextSource::Mapped { id, segments } => {
                    let first =
                        segments.partition_point(|segment| scope.start + segment.end <= start);
                    for segment in segments[first..]
                        .iter()
                        .take_while(|segment| scope.start + segment.start < end)
                    {
                        let segment_start = scope.start + segment.start;
                        let segment_end = scope.start + segment.end;
                        let (start, end) = (start.max(segment_start), end.min(segment_end));
                        if start >= end {
                            continue;
                        }
                        let (a, b) = (bytes[&start], bytes[&end]);
                        let (source_start, source_end) = match segment.kind {
                            TextSourceKind::Literal => (
                                segment.source_start + (a - bytes[&segment_start]) as u64,
                                segment.source_start + (b - bytes[&segment_start]) as u64,
                            ),
                            TextSourceKind::Replacement => {
                                (segment.source_start, segment.source_end)
                            }
                        };
                        out.push(MappedRange {
                            id: id.clone(),
                            start,
                            end,
                            byte_start: a,
                            source_start,
                            source_end,
                            kind: segment.kind,
                        });
                    }
                }
            }
        }
        SourceMap(out)
    }
}

/// Resolve only requested UTF-16 boundaries in one pass through actual text.
fn byte_boundaries(text: &str, mut needed: Vec<u32>) -> BTreeMap<u32, usize> {
    needed.sort_unstable();
    needed.dedup();
    let mut wanted = needed.into_iter().peekable();
    let mut out = BTreeMap::new();
    let mut units = 0;
    for (byte, ch) in text
        .char_indices()
        .chain(std::iter::once((text.len(), '\0')))
    {
        while wanted.peek().is_some_and(|&at| at < units) {
            wanted.next();
        }
        if wanted.peek() == Some(&units) {
            out.insert(units, byte);
            wanted.next();
        }
        units += ch.len_utf16() as u32;
    }
    out
}

/// A visible, non-whitespace source-bearing part of one shaped line.
#[derive(Debug, Clone)]
struct SourceLine {
    point: SourcePoint,
    end: u64,
    y: f32,
    height: f32,
    through: f32,
}

/// A layout-derived line index. User scrolling performs no text conversion.
#[derive(Debug, Clone, Default)]
pub(crate) struct SourceGeometry {
    lines: Vec<SourceLine>,
    documents: BTreeMap<Arc<str>, Vec<(usize, u64)>>,
}

impl SourceMap {
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub(crate) fn geometry(&self, text: &str, lines: Vec<TextLine>) -> SourceGeometry {
        let mut needed = Vec::new();
        for line in &lines {
            needed.extend([line.start, line.end]);
        }
        for range in &self.0 {
            needed.extend([range.start, range.end]);
        }
        let bytes = byte_boundaries(text, needed);
        let mut out = SourceGeometry::default();
        for line in lines {
            if !line.y.0.is_finite() || !line.height.0.is_finite() || line.height.0 <= 0.0 {
                continue;
            }
            let first = self.0.partition_point(|range| range.end <= line.start);
            for range in self.0[first..]
                .iter()
                .take_while(|range| range.start < line.end)
            {
                let (start, end) = (range.start.max(line.start), range.end.min(line.end));
                let (Some(&a), Some(&b)) = (bytes.get(&start), bytes.get(&end)) else {
                    continue;
                };
                let rendered = &text[a..b];
                let trimmed = rendered.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let first_byte = a + rendered.len() - rendered.trim_start().len();
                let last_byte = first_byte + trimmed.len();
                let (source_start, source_end) = match range.kind {
                    TextSourceKind::Literal => (
                        range.source_start + (first_byte - range.byte_start) as u64,
                        range.source_start + (last_byte - range.byte_start) as u64,
                    ),
                    TextSourceKind::Replacement => (range.source_start, range.source_end),
                };
                if let Some(previous) = out.lines.last_mut()
                    && previous.point.id == range.id
                    && previous.y == line.y.0
                    && previous.end <= source_start
                {
                    previous.end = source_end;
                } else {
                    out.lines.push(SourceLine {
                        point: SourcePoint {
                            id: range.id.clone(),
                            byte: source_start,
                        },
                        end: source_end,
                        y: line.y.0,
                        height: line.height.0,
                        through: 0.0,
                    });
                }
            }
        }
        out.index();
        out
    }
}

impl SourceGeometry {
    pub(crate) fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    fn index(&mut self) {
        self.lines.sort_by(|a, b| a.y.total_cmp(&b.y));
        self.documents.clear();
        let mut through = f32::NEG_INFINITY;
        for (index, line) in self.lines.iter_mut().enumerate() {
            through = through.max(line.y + line.height);
            line.through = through;
            self.documents
                .entry(line.point.id.clone())
                .or_default()
                .push((index, 0));
        }
        for indices in self.documents.values_mut() {
            indices.sort_by_key(|&(index, _)| self.lines[index].point.byte);
            let mut through = 0;
            for (index, end) in indices {
                through = through.max(self.lines[*index].end);
                *end = through;
            }
        }
    }

    pub(crate) fn append(&mut self, other: &Self, y: f32, clip: (f32, f32)) {
        self.lines.extend(other.lines.iter().filter_map(|line| {
            let mut line = line.clone();
            line.y += y;
            (line.y < clip.1 && line.y + line.height > clip.0).then_some(line)
        }));
    }

    pub(crate) fn finish(&mut self) {
        self.index();
    }

    pub(crate) fn first_visible(&self, start: f32, end: f32) -> Option<(SourcePoint, f32)> {
        let first = self.lines.partition_point(|line| line.through <= start);
        self.lines[first..]
            .iter()
            .take_while(|line| line.y < end)
            .find(|line| line.y + line.height > start)
            .map(|line| (line.point.clone(), line.y))
    }

    pub(crate) fn position(&self, point: &SourcePoint) -> Option<f32> {
        let indices = self.documents.get(&point.id)?;
        let at = indices.partition_point(|&(_, through)| through <= point.byte);
        // A syntax gap projects forward; only the document tail projects back.
        let (index, _) = *indices.get(at).or_else(|| indices.last())?;
        Some(self.lines[index].y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::px;

    fn source(text: &str, source: TextSource) -> SourceMap {
        let mut collector = SourceCollector::default();
        let scope = collector.begin(Arc::new(source), 0);
        let end = text.encode_utf16().count() as u32;
        collector.text(Some(scope), 0, end);
        collector.end(scope, end);
        collector.finish(text)
    }

    fn line(start: u32, end: u32, y: f32) -> TextLine {
        TextLine {
            start,
            end,
            y: px(y),
            height: px(16.0),
            ..TextLine::default()
        }
    }

    #[test]
    fn source_lines_preserve_unicode_atoms_and_skip_unrendered_syntax() {
        // Canonical source: "\n\n中😀&amp;tail". The blank raw line must
        // not become the reading anchor when rich rendering removes it.
        let text = "\n\n中😀&tail";
        let map = source(
            text,
            TextSource::Mapped {
                id: "document".into(),
                segments: vec![
                    TextSourceSegment {
                        start: 0,
                        end: 5,
                        source_start: 0,
                        source_end: 9,
                        kind: TextSourceKind::Literal,
                    },
                    TextSourceSegment {
                        start: 5,
                        end: 6,
                        source_start: 9,
                        source_end: 14,
                        kind: TextSourceKind::Replacement,
                    },
                    TextSourceSegment {
                        start: 6,
                        end: 10,
                        source_start: 14,
                        source_end: 18,
                        kind: TextSourceKind::Literal,
                    },
                ],
            },
        );
        let raw = map.geometry(
            text,
            vec![line(0, 2, 0.0), line(2, 5, 16.0), line(5, 10, 32.0)],
        );
        assert_eq!(
            raw.first_visible(0.0, 48.0),
            Some((
                SourcePoint {
                    id: "document".into(),
                    byte: 2
                },
                16.0
            ))
        );
        assert_eq!(
            raw.position(&SourcePoint {
                id: "document".into(),
                byte: 5
            }),
            Some(16.0)
        );
        // Any byte within the entity belongs to its visible glyph's line.
        assert_eq!(
            raw.position(&SourcePoint {
                id: "document".into(),
                byte: 12
            }),
            Some(32.0)
        );

        let rich = source(
            "中😀&tail",
            TextSource::Mapped {
                id: "document".into(),
                segments: vec![
                    TextSourceSegment {
                        start: 0,
                        end: 3,
                        source_start: 2,
                        source_end: 9,
                        kind: TextSourceKind::Literal,
                    },
                    TextSourceSegment {
                        start: 3,
                        end: 4,
                        source_start: 9,
                        source_end: 14,
                        kind: TextSourceKind::Replacement,
                    },
                    TextSourceSegment {
                        start: 4,
                        end: 8,
                        source_start: 14,
                        source_end: 18,
                        kind: TextSourceKind::Literal,
                    },
                ],
            },
        )
        .geometry("中😀&tail", vec![line(0, 3, 0.0), line(3, 8, 16.0)]);
        assert_eq!(
            rich.position(&SourcePoint {
                id: "document".into(),
                byte: 2
            }),
            Some(0.0)
        );
        assert_eq!(
            rich.position(&SourcePoint {
                id: "document".into(),
                byte: 0
            }),
            Some(0.0)
        );
        assert_eq!(
            rich.position(&SourcePoint {
                id: "document".into(),
                byte: 99
            }),
            Some(16.0)
        );

        // Invalid surrogate/literal boundaries do not borrow stale source
        // identity; glyph content and its normal layout remain independent.
        let invalid = source(
            "😀",
            TextSource::Mapped {
                id: "document".into(),
                segments: vec![TextSourceSegment {
                    start: 1,
                    end: 2,
                    source_start: 0,
                    source_end: 4,
                    kind: TextSourceKind::Literal,
                }],
            },
        );
        assert!(invalid.is_empty());

        // An inline image is one real UTF-16 placeholder even after CJK
        // and a surrogate pair; its source syntax is an indivisible unit.
        let image = source(
            "中😀\u{FFFC}",
            TextSource::Mapped {
                id: "document".into(),
                segments: vec![TextSourceSegment {
                    start: 3,
                    end: 4,
                    source_start: 20,
                    source_end: 40,
                    kind: TextSourceKind::Replacement,
                }],
            },
        )
        .geometry("中😀\u{FFFC}", vec![line(0, 3, 0.0), line(3, 4, 16.0)]);
        assert_eq!(
            image.first_visible(0.0, 32.0),
            Some((
                SourcePoint {
                    id: "document".into(),
                    byte: 20
                },
                16.0
            ))
        );
        assert_eq!(
            image.position(&SourcePoint {
                id: "document".into(),
                byte: 30
            }),
            Some(16.0)
        );
    }
}
