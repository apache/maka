//! Hit testing (`hit`): the offset of a point, the caret of an offset and
//! the boxes of a range, over lines whose characters are 10 wide.

use nsh_core::{Affinity, Points, TextLine, TextPosition, geometry::point};

use crate::hit::{Stop, caret_rect, hit_test, push_stops, range_rects};

/// A line of `start..end` at row `row` (10 high), whose drawn text is
/// `chars` characters.
fn line(start: u32, end: u32, row: f32, chars: u32) -> TextLine {
    TextLine {
        start,
        end,
        y: Points(row * 10.0),
        width: Points(chars as f32 * 10.0),
        height: Points(10.0),
        ..TextLine::default()
    }
}

/// The stops of `text` from offset `start` on a line, 10 wide a character.
fn stops(start: u32, text: &str) -> Vec<Stop> {
    let mut stops = Vec::new();
    let width = text.chars().count() as f32 * 10.0;
    push_stops(&mut stops, 0.0, width, start, Some(text), |range| {
        let a = text[..range.start].chars().count() as f32 * 10.0;
        let b = text[..range.end].chars().count() as f32 * 10.0;
        if text == "אב" {
            (width - b, width - a)
        } else {
            (a, b)
        }
    });
    stops
}

/// "foo bar" wrapped after "foo ": the first line ends where the second
/// starts, and its space is not drawn.
fn wrapped() -> (Vec<TextLine>, Vec<Vec<Stop>>) {
    (
        vec![line(0, 4, 0.0, 3), line(4, 7, 1.0, 3)],
        vec![stops(0, "foo"), stops(4, "bar")],
    )
}

#[test]
fn hit_past_a_wrapped_line_is_its_end_upstream() {
    let (lines, s) = wrapped();
    let at = hit_test(
        &lines,
        |i| s[i].as_slice(),
        point(Points(100.0), Points(5.0)),
    );
    assert_eq!(at, TextPosition::new(4, Affinity::Upstream));
    // The last line has no line after it.
    let at = hit_test(
        &lines,
        |i| s[i].as_slice(),
        point(Points(100.0), Points(15.0)),
    );
    assert_eq!(at, TextPosition::new(7, Affinity::Downstream));
}

#[test]
fn hit_takes_the_nearest_edge_and_clamps_to_the_text() {
    let (lines, s) = wrapped();
    let hit = |x: f32, y: f32| hit_test(&lines, |i| s[i].as_slice(), point(Points(x), Points(y)));
    assert_eq!(hit(14.0, 5.0).offset, 1);
    assert_eq!(hit(16.0, 5.0).offset, 2);
    assert_eq!(hit(-20.0, 15.0), TextPosition::new(4, Affinity::Downstream));
    // Above the text the first line, below it the last.
    assert_eq!(hit(0.0, -30.0).offset, 0);
    assert_eq!(hit(0.0, 300.0).offset, 4);
}

#[test]
fn hit_before_a_hard_break_stays_before_it() {
    // "ab\ncd": the break is offset 2, the second line starts at 3.
    let lines = [line(0, 2, 0.0, 2), line(3, 5, 1.0, 2)];
    let s = [stops(0, "ab"), stops(3, "cd")];
    let at = hit_test(
        &lines,
        |i| s[i].as_slice(),
        point(Points(99.0), Points(5.0)),
    );
    assert_eq!(at, TextPosition::new(2, Affinity::Downstream));
    // The caret there is on the first line, after "ab".
    let c = caret_rect(&lines, |i| s[i].as_slice(), at).expect("lines");
    assert_eq!((c.origin.x, c.origin.y), (Points(20.0), Points(0.0)));
}

#[test]
fn caret_of_a_wrap_depends_on_affinity() {
    let (lines, s) = wrapped();
    let rect = |affinity| {
        caret_rect(&lines, |i| s[i].as_slice(), TextPosition::new(4, affinity)).expect("lines")
    };
    let up = rect(Affinity::Upstream);
    assert_eq!((up.origin.x, up.origin.y), (Points(30.0), Points(0.0)));
    assert_eq!((up.size.width, up.size.height), (Points(0.0), Points(10.0)));
    let down = rect(Affinity::Downstream);
    assert_eq!((down.origin.x, down.origin.y), (Points(0.0), Points(10.0)));
}

#[test]
fn hit_near_the_end_of_a_wrap_without_dropped_space_stays_upstream() {
    // "abcd" wrapped after "ab": the line's last stop is the next line's start.
    let lines = [line(0, 2, 0.0, 2), line(2, 4, 1.0, 2)];
    let s = [stops(0, "ab"), stops(2, "cd")];
    let at = hit_test(
        &lines,
        |i| s[i].as_slice(),
        point(Points(19.0), Points(5.0)),
    );
    assert_eq!(at, TextPosition::new(2, Affinity::Upstream));
    // The round trip: the caret stays on the first line, after "ab".
    let c = caret_rect(&lines, |i| s[i].as_slice(), at).expect("lines");
    assert_eq!((c.origin.x, c.origin.y), (Points(20.0), Points(0.0)));
}

#[test]
fn no_lines_no_caret() {
    let none: [Stop; 0] = [];
    assert!(caret_rect(&[], |_| &none[..], TextPosition::default()).is_none());
    let at = hit_test(&[], |_| &none[..], point(Points(1.0), Points(1.0)));
    assert_eq!(at, TextPosition::default());
}

#[test]
fn range_across_lines_goes_through_the_line_end() {
    let (lines, s) = wrapped();
    let mut out = Vec::new();
    range_rects(&lines, |i| s[i].as_slice(), 2..6, &mut out);
    let boxes: Vec<_> = out
        .iter()
        .map(|b| (b.origin.x.0, b.origin.y.0, b.size.width.0, b.size.height.0))
        .collect();
    assert_eq!(boxes, [(20.0, 0.0, 10.0, 10.0), (0.0, 10.0, 20.0, 10.0)]);
    // Appended to, and nothing for an empty range.
    range_rects(&lines, |i| s[i].as_slice(), 3..3, &mut out);
    assert_eq!(out.len(), 2);
}

#[test]
fn range_of_dropped_spaces_has_no_box() {
    let (lines, s) = wrapped();
    let mut out = Vec::new();
    range_rects(&lines, |i| s[i].as_slice(), 3..4, &mut out);
    assert!(out.is_empty());
}

#[test]
fn stops_skip_the_inside_of_pairs_and_clusters() {
    let offsets = |text: &str| -> Vec<u32> { stops(0, text).iter().map(|s| s.offset).collect() };
    // U+1F600 is two UTF-16 units.
    assert_eq!(offsets("😀a"), [0, 2, 3]);
    // "e" and a combining acute accent are one cluster.
    assert_eq!(offsets("e\u{301}x"), [0, 2, 3]);
    let s = stops(0, "e\u{301}x");
    assert_eq!(s.last().map(|s| s.x), Some(30.0));
}

#[test]
fn a_caret_inside_a_cluster_stands_before_it() {
    let lines = [line(0, 3, 0.0, 3)];
    let s = [stops(0, "😀a")];
    let c = caret_rect(
        &lines,
        |i| s[i].as_slice(),
        TextPosition::new(1, Affinity::Downstream),
    )
    .expect("lines");
    assert_eq!(c.origin.x, Points(0.0));
}

#[test]
fn attachments_are_one_unit_and_pieces_share_their_join() {
    let mut s = Vec::new();
    push_stops(&mut s, 0.0, 20.0, 0, Some("ab"), |r| {
        (r.start as f32 * 10.0, r.end as f32 * 10.0)
    });
    push_stops(&mut s, 20.0, 15.0, 2, None, |_| (0.0, 0.0));
    push_stops(&mut s, 35.0, 10.0, 3, Some("c"), |_| (0.0, 10.0));
    let got: Vec<_> = s.iter().map(|s| (s.offset, s.x)).collect();
    assert_eq!(got, [(0, 0.0), (1, 10.0), (2, 20.0), (3, 35.0), (4, 45.0)]);
}

#[test]
fn rtl_carets_and_ranges_follow_the_drawn_characters() {
    let lines = [line(0, 2, 0.0, 2)];
    let s = [stops(0, "אב")];
    let c = caret_rect(&lines, |i| s[i].as_slice(), TextPosition::default()).unwrap();
    assert_eq!(c.origin.x, Points(20.0));
    assert_eq!(
        hit_test(&lines, |i| s[i].as_slice(), point(Points(1.0), Points(5.0))).offset,
        2
    );
    let mut out = Vec::new();
    range_rects(&lines, |i| s[i].as_slice(), 0..1, &mut out);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].origin.x, Points(10.0));
}

/// "abc אבג xyz" on one line: the Hebrew drawn right to left between
/// x=40 and x=70, so offset 4 starts at x=70 while "c " ends at x=40.
fn mixed() -> ([TextLine; 1], Vec<Stop>) {
    let text = "abc אבג xyz";
    let mut edges = Vec::new();
    push_stops(&mut edges, 0.0, 110.0, 0, Some(text), |r| {
        let i = text[..r.start].chars().count();
        let left = match i {
            4..=6 => (10 - i) * 10,
            _ => i * 10,
        } as f32;
        (left, left + 10.0)
    });
    ([line(0, 11, 0.0, 11)], edges)
}

#[test]
fn mixed_direction_ranges_keep_their_visual_gaps() {
    let (lines, edges) = mixed();
    let mut boxes = Vec::new();
    range_rects(&lines, |_| &edges, 0..5, &mut boxes);
    assert_eq!(
        boxes
            .iter()
            .map(|b| (b.origin.x.0, b.size.width.0))
            .collect::<Vec<_>>(),
        [(0.0, 40.0), (60.0, 10.0)]
    );
    let caret = |affinity| {
        caret_rect(&lines, |_| &edges, TextPosition::new(4, affinity))
            .unwrap()
            .origin
            .x
    };
    assert_eq!(caret(Affinity::Downstream), Points(70.0));
    assert_eq!(caret(Affinity::Upstream), Points(40.0));
}

#[test]
fn hits_at_a_bidi_boundary_keep_the_edge_they_land_on() {
    let (lines, edges) = mixed();
    let caret_at = |x: f32| {
        let at = hit_test(&lines, |_| &edges, point(Points(x), Points(5.0)));
        let c = caret_rect(&lines, |_| &edges, at).expect("lines");
        (at, c.origin.x)
    };
    // After "abc ": the space's trailing edge, offset 4 upstream.
    assert_eq!(
        caret_at(40.0),
        (TextPosition::new(4, Affinity::Upstream), Points(40.0))
    );
    // The leading edge of "א": offset 4 downstream.
    assert_eq!(
        caret_at(70.0),
        (TextPosition::new(4, Affinity::Downstream), Points(70.0))
    );
    // Where both edges of an offset meet, downstream.
    assert_eq!(
        caret_at(21.0),
        (TextPosition::new(2, Affinity::Downstream), Points(20.0))
    );
}
#[test]
fn rtl_wraps_drop_spaces_at_the_visual_left() {
    let lines = [line(0, 3, 0.0, 2), line(3, 4, 1.0, 1)];
    let edges = [stops(0, "אב"), stops(3, "a")];
    let hit = hit_test(&lines, |i| &edges[i], point(Points(-10.0), Points(5.0)));
    assert_eq!(hit, TextPosition::new(3, Affinity::Upstream));
}
