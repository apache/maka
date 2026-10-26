//! Hit testing in a laid-out text: which offset a point is at, where the
//! caret of an offset stands and which boxes a range covers. It works on a
//! layout's lines and the places the caret can stand on each ([`Stop`]),
//! and depends on nothing of the browser, so its tests run off WebAssembly
//! too (`tests/text`).
//!
//! A run's logical cluster boundaries keep both visual edges: at a bidi
//! boundary, the preceding cluster's end and the next one's start differ.

use std::ops::Range;

use nsh_core::{
    Affinity, Bounds, Point, Points, TextLine, TextPosition,
    geometry::{point, size},
    text_edit::next_cluster,
};

/// A place the caret can stand on a line: between two clusters, at the
/// start or at the end of the drawn text.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Stop {
    /// The offset (UTF-16 units).
    pub(crate) offset: u32,
    pub(crate) x: f32,
    /// The trailing edge of the cluster starting here (the next offset).
    pub(crate) trailing: f32,
}

/// Appends a drawn run's cluster edges in logical order. `bounds` gives
/// each cluster's visual left/right edges relative to the run (measured
/// in the full run, so shaping and bidi reordering match what is drawn).
/// `None` is a one-unit attachment. Joining runs replaces the shared
/// boundary's downstream edge, retaining the preceding cluster's end.
pub(crate) fn push_stops(
    stops: &mut Vec<Stop>,
    x: f32,
    width: f32,
    start: u32,
    text: Option<&str>,
    mut bounds: impl FnMut(Range<usize>) -> (f32, f32),
) {
    let mut push = |offset, x, trailing| {
        let stop = Stop {
            offset,
            x,
            trailing,
        };
        match stops.last_mut() {
            Some(last) if last.offset == offset => *last = stop,
            _ => stops.push(stop),
        }
    };
    let Some(text) = text else {
        push(start, x, x + width);
        push(start.saturating_add(1), x + width, x + width);
        return;
    };
    // The absolutely placed DOM runs inherit the page's LTR base direction;
    // strong RTL text still reorders within them.
    let bidi = unicode_bidi::BidiInfo::new(text, Some(unicode_bidi::Level::ltr()));
    let (mut at, mut offset, mut last) = (0, start, x);
    while at < text.len() {
        let next = next_cluster(text, at);
        let Some(cluster) = text.get(at..next).filter(|_| next > at) else {
            break;
        };
        let (left, right) = bounds(at..next);
        let rtl = bidi.levels.get(at).is_some_and(|level| level.is_rtl());
        let (leading, trailing) = if rtl { (right, left) } else { (left, right) };
        push(offset, x + leading, x + trailing);
        offset = offset
            .saturating_add(u32::try_from(cluster.encode_utf16().count()).unwrap_or(u32::MAX));
        last = x + trailing;
        at = next;
    }
    push(offset, last, last);
}

/// The x of the caret at `offset` on a line with `stops`: its stop, or the
/// one before it where it stands inside a cluster or in the spaces a
/// wrap dropped from the line's end. `line_x` for a line with none.
fn x_of(stops: &[Stop], offset: u32, line_x: f32) -> f32 {
    let after = stops.partition_point(|s| s.offset <= offset);
    after
        .checked_sub(1)
        .and_then(|i| stops.get(i))
        .or_else(|| stops.first())
        .map_or(line_x, |s| s.x)
}

/// The index of the line a point at height `y` lands on: the one at that
/// height, the first above the text, the last below it.
fn line_at(lines: &[TextLine], y: Points) -> Option<usize> {
    lines
        .iter()
        .position(|l| y < l.y + l.height)
        .or(lines.len().checked_sub(1))
}

/// The caret position nearest `p` (content box): on the line at its
/// height, at the edge nearest its x. A cluster's trailing edge is the
/// next offset with [`Affinity::Upstream`] (at a bidi boundary it is not
/// where that offset's own cluster starts). Past the end of a line, the
/// line's end offset: upstream where the line wrapped (the next line
/// starts there), so the caret stays on this line, and before the break
/// character where it ended at one. `stops(i)` are the stops of line `i`.
pub(crate) fn hit_test<'a>(
    lines: &[TextLine],
    stops: impl Fn(usize) -> &'a [Stop],
    p: Point<Points>,
) -> TextPosition {
    let Some(i) = line_at(lines, p.y) else {
        return TextPosition::default();
    };
    let Some(l) = lines.get(i) else {
        return TextPosition::default();
    };
    let stops = stops(i);
    let x = p.x.0;
    // Where the line wrapped, its end is also the next line's start: the
    // caret at it stays on this line (upstream).
    let wrapped = l.end > l.start && lines.get(i + 1).is_some_and(|next| next.start == l.end);
    // Leading edges first: where both edges of an offset stand at the same
    // x the first minimum, downstream, wins. A trailing edge apart from the
    // next offset's own (a bidi boundary) is that offset upstream; within
    // half a point, measurement noise, it is the same caret.
    let nearest = stops
        .iter()
        .map(|s| (s.x, s.offset, Affinity::Downstream))
        .chain(stops.windows(2).map(|pair| {
            let apart = (pair[0].trailing - pair[1].x).abs() > 0.5;
            let affinity = if apart {
                Affinity::Upstream
            } else {
                Affinity::Downstream
            };
            (pair[0].trailing, pair[1].offset, affinity)
        }))
        .min_by(|a, b| {
            (a.0 - x)
                .abs()
                .total_cmp(&(b.0 - x).abs())
                .then_with(|| b.0.total_cmp(&a.0))
        });
    let (offset, affinity) = nearest.map_or((l.start, Affinity::Downstream), |(_, o, a)| (o, a));
    // A wrap may drop trailing spaces: past its visual end still means
    // the logical line end, unless the run ends at the left (RTL).
    let past_end = stops
        .first()
        .zip(stops.last())
        .is_some_and(|(first, last)| {
            last.offset < l.end
                && if first.x <= last.x {
                    x >= last.x
                } else {
                    x <= last.x
                }
        });
    let (offset, affinity) = if past_end {
        (l.end, Affinity::Downstream)
    } else {
        (offset, affinity)
    };
    let affinity = if wrapped && offset == l.end {
        Affinity::Upstream
    } else if offset == l.end {
        // The end of a line that did not wrap belongs to it either way.
        Affinity::Downstream
    } else {
        affinity
    };
    TextPosition::new(offset, affinity)
}

/// The caret at `position`: zero wide, as high as its line, at the stop of
/// the offset. `None` when there are no lines.
pub(crate) fn caret_rect<'a>(
    lines: &[TextLine],
    stops: impl Fn(usize) -> &'a [Stop],
    position: TextPosition,
) -> Option<Bounds<Points>> {
    let i = position.line(lines)?;
    let l = lines.get(i)?;
    let edges = stops(i);
    let x = if position.affinity == Affinity::Upstream {
        edges
            .windows(2)
            .find(|pair| pair[1].offset == position.offset)
            .map_or_else(
                || x_of(edges, position.offset, l.x.0),
                |pair| pair[0].trailing,
            )
    } else {
        x_of(edges, position.offset, l.x.0)
    };
    Some(Bounds::new(
        point(Points(x), l.y),
        size(Points::ZERO, l.height),
    ))
}

/// Appends the visual stretches of `range`, split at bidi gaps, line high:
/// from the range's start on the line to its end, or to the end of the
/// line's drawn text where the range goes on past the line. A box with
/// nothing in it (the range covers only spaces a wrap dropped) is left out.
pub(crate) fn range_rects<'a>(
    lines: &[TextLine],
    stops: impl Fn(usize) -> &'a [Stop],
    range: Range<u32>,
    out: &mut Vec<Bounds<Points>>,
) {
    if range.start >= range.end {
        return;
    }
    for (i, l) in lines.iter().enumerate() {
        if l.start >= range.end || range.start >= l.end {
            continue;
        }
        let first = out.len();
        for pair in stops(i).windows(2) {
            if pair[0].offset < range.end && range.start < pair[1].offset {
                let (a, b) = (pair[0].x, pair[0].trailing);
                if (a - b).abs() > 0.001 {
                    out.push(Bounds::new(
                        point(Points(a.min(b)), l.y),
                        size(Points((a - b).abs()), l.height),
                    ));
                }
            }
        }
        out[first..].sort_by(|a, b| a.origin.x.0.total_cmp(&b.origin.x.0));
        let mut kept = first;
        for read in first..out.len() {
            let r = out[read];
            if kept > first
                && r.origin.x <= out[kept - 1].origin.x + out[kept - 1].size.width + Points(0.01)
            {
                let p = &mut out[kept - 1];
                p.size.width =
                    (p.origin.x + p.size.width).max(r.origin.x + r.size.width) - p.origin.x;
            } else {
                out[kept] = r;
                kept += 1;
            }
        }
        out.truncate(kept);
    }
}
