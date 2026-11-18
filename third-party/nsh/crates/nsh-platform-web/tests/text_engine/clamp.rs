//! A line clamp cuts its last line at the box, inside a word if need be,
//! not after the last word that fit there: a `truncate`d name in a row
//! ended at a space with the box empty past it.

use nsh_core::{
    AttributedText, Color, EllipsizeMode, EventKind, EventMask, Points, ResolvedTextStyle,
    TextEngine, TextLink,
};

use crate::text::{WebLayout, WebTextEngine};

fn clamped(s: &str, max_lines: u32) -> AttributedText {
    let mut t = AttributedText::default();
    t.push(s, ResolvedTextStyle::default());
    t.max_lines = max_lines;
    t.ellipsize = EllipsizeMode::Tail;
    t
}

#[test]
fn clamped_last_line_is_cut_at_the_box() {
    let engine = WebTextEngine::default();
    // The stub measures every character equally wide.
    let w = engine
        .measure(&engine.prepare(&clamped("x", 0)), None)
        .width
        .0;
    let box_width = 150.0;
    for (long, max_lines) in [
        ("Christopher Montgomery Wellington", 1),
        ("Karl Anton Hohenzollern-Sigmaringen", 1),
        (
            "Christopher Montgomery-Wellington the Third, Senior Equity Strategist",
            2,
        ),
    ] {
        let t = clamped(long, max_lines);
        let p = engine.prepare(&t);
        let size = engine.measure(&p, Some(Points(box_width)));
        assert_eq!(size.width.0, box_width, "{long}");
        let layout = engine.layout(&p, size);
        let lines = engine.lines(&layout);
        assert_eq!(lines.len(), max_lines as usize, "{long}");
        let last = lines.last().unwrap();
        let shown: String = layout
            .downcast::<WebLayout>()
            .unwrap()
            .runs
            .iter()
            .filter(|r| r.y >= last.y.0 - 0.01)
            .map(|r| r.text.as_str())
            .collect();
        // As many characters as fit with the ellipsis, spaces before it
        // dropped.
        let start = last.start as usize;
        let keep = ((box_width + 0.01) / w).floor() as usize - 1;
        let expected = format!("{}…", long[start..start + keep].trim_end());
        assert_eq!(shown, expected, "{long}");
        assert!(
            last.x.0 + last.width.0 <= box_width + 0.01,
            "{long}: {last:?}"
        );
        // The ellipsis stands for the rest of the text.
        assert_eq!(last.end as usize, long.len(), "{long}");
    }
}

/// What of a link a clamped line shows is the link's, and the ellipsis is
/// no link's: a link the box cuts keeps its drawn characters (a press there
/// is the link's, as on the native backends), one wholly past the box draws
/// none, and the ellipsis standing for either takes no press.
#[test]
fn a_clamped_line_links_only_the_characters_it_shows() {
    let engine = WebTextEngine::default();
    let w = engine
        .measure(&engine.prepare(&clamped("x", 0)), None)
        .width
        .0;
    // Twenty characters wide: nineteen beside the ellipsis.
    let box_width = 20.0 * w;
    let mut events = EventMask::default();
    events.set(EventKind::Press, true);
    let link_style = ResolvedTextStyle {
        color: Color(0x0000_ffff),
        ..Default::default()
    };
    // (characters before the link, the link's, how many of the link show)
    for (before, linked, shown) in [(4, 30, 15), (25, 8, 0)] {
        let mut t = AttributedText::default();
        t.push(&"A".repeat(before), ResolvedTextStyle::default());
        t.push(&"W".repeat(linked), link_style);
        t.links.push(TextLink {
            start: before as u32,
            end: (before + linked) as u32,
            node: 2,
            events,
            focus_stop: true,
        });
        t.max_lines = 1;
        t.ellipsize = EllipsizeMode::Tail;
        let p = engine.prepare(&t);
        let size = engine.measure(&p, Some(Points(box_width)));
        let layout = engine.layout(&p, size);
        let runs = &layout.downcast::<WebLayout>().unwrap().runs;
        let drawn: String = runs.iter().map(|r| r.text.as_str()).collect();
        let expected = format!("{}{}…", "A".repeat(before.min(19)), "W".repeat(shown));
        assert_eq!(drawn, expected, "{before} + {linked}");
        // ASCII: a run's UTF-16 offsets are its byte offsets.
        let in_links: String = runs
            .iter()
            .flat_map(|r| {
                r.links
                    .iter()
                    .map(|&(from, to, _)| &r.text[from as usize..to as usize])
            })
            .collect();
        assert_eq!(in_links, "W".repeat(shown), "{before} + {linked}");
    }
}

#[test]
fn clamped_truncation_keeps_whole_clusters_and_counts_ellipsis_letter_spacing() {
    let engine = WebTextEngine::default();
    let style = ResolvedTextStyle {
        letter_spacing: Points(4.0),
        ..Default::default()
    };
    let measure_spaced = |s: &str| {
        let mut t = AttributedText::default();
        t.push(s, style);
        engine.measure(&engine.prepare(&t), None).width.0
    };
    let a_w = measure_spaced("A");
    let thumb_w = measure_spaced("👍🏻");
    let ellipsis_w = measure_spaced("…");
    let url_prefix = "https://example.com/👍🏻";
    let url_prefix_w = measure_spaced(url_prefix);

    // `box_width` fits "A" + "…" (both with letter-spacing), not "A" + "👨‍👩‍👧‍👦" + "…".
    // Truncating must drop the whole ZWJ cluster instead of slicing code points out of it,
    // including on long unbroken tokens (> 16 clusters) and non-breaking spaces before `…`.
    for (input, box_width, expected) in [
        ("A👨‍👩‍👧‍👦", a_w + ellipsis_w + 0.5, "A…"),
        ("👍🏻👨‍👩‍👧‍👦", thumb_w + ellipsis_w + 0.5, "👍🏻…"),
        (
            "https://example.com/👍🏻👨‍👩‍👧‍👦/very/long/path/segment",
            url_prefix_w + ellipsis_w + 0.5,
            "https://example.com/👍🏻…",
        ),
        ("A\u{00A0}👨‍👩‍👧‍👦", a_w + ellipsis_w + 0.5, "A…"),
    ] {
        let mut t = AttributedText::default();
        t.push(input, style);
        t.max_lines = 1;
        t.ellipsize = EllipsizeMode::Tail;
        let p = engine.prepare(&t);
        let size = engine.measure(&p, Some(Points(box_width)));
        let layout = engine.layout(&p, size);
        let lines = engine.lines(&layout);
        assert_eq!(lines.len(), 1, "{input}");
        let runs = &layout.downcast::<WebLayout>().unwrap().runs;
        let shown: String = runs.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(shown, expected, "{input}");
        assert!(
            lines[0].width.0 <= box_width + 0.01,
            "{input}: line overflowed {box_width}: {:?}",
            lines[0]
        );
    }
}
