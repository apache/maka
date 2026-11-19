//! The text inside a view with an `href` (`nsh-base`'s `Link`), drawn
//! as OSC 8 hyperlinks.
//!
//! The painted buffer keeps plain symbols: every pass that reads it
//! (selection, search, the agent's screen, tests) and ratatui's diff see
//! the same Cells with or without links, so the layout, the Cells redrawn
//! and the cursor moves do not change. The text painter records which Cells
//! hold a linked glyph ([`Painted`]); at the end of a frame [`finish`] keeps
//! those an overlay did not draw over, by position ([`Links`]), and the
//! terminal backend ([`crate::MeasuredBackend`]) wraps each such Cell it is
//! handed in its own link: `ESC ] 8 ; id=… ; URL ESC \`, the symbol, then
//! `ESC ] 8 ; ; ESC \`. Each Cell opens and closes its link, as the diff
//! redraws single Cells; the Cells of one link share its view's `id`, so a
//! terminal treats them as one link.

use std::{collections::HashMap, sync::Arc};

use ratatui_core::buffer::{Buffer, Cell, CellDiffOption};

/// Ends a hyperlink.
pub(crate) const CLOSE: &str = "\x1b]8;;\x1b\\";

/// The linked Cells the text painter drew this frame, by buffer index: the
/// link's opening sequence and the glyph drawn there.
pub(crate) type Painted = HashMap<usize, (Arc<str>, Arc<str>)>;

/// The linked Cells of the last frame, by position: the opening sequence.
pub(crate) type Links = HashMap<(u16, u16), Arc<str>>;

/// The sequence that opens a link to `href` for the view `node`, or none
/// when `href` is no URL the app could open (`check_url`: a path of the
/// app's, `#anchor`, or one with whitespace or a control character, which
/// could end the sequence and start another). Characters outside ASCII are
/// percent-encoded, as OSC 8 takes bytes 32 to 126.
pub(crate) fn open(node: nsh_core::NodeId, href: &str) -> Option<Arc<str>> {
    nsh_core::open_url::check_url(href).ok()?;
    let mut url = String::with_capacity(href.len());
    for c in href.chars() {
        if c.is_ascii() {
            url.push(c);
        } else {
            for byte in c.encode_utf8(&mut [0; 4]).bytes() {
                url.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    Some(format!("\x1b]8;id=nsh-{node};{url}\x1b\\").into())
}

/// The links of the frame just painted into `buffer`: the Cells of
/// `painted` that still hold their glyph. A Cell whose link changed since
/// `previous` (a new URL over the same text, or the link gone) is drawn
/// again whatever the diff finds, as the terminal keeps the old link there.
pub(crate) fn finish(buffer: &mut Buffer, painted: &Painted, previous: &Links) -> Links {
    let mut links = Links::with_capacity(painted.len());
    for (&index, (open, glyph)) in painted {
        if buffer
            .content
            .get(index)
            .is_some_and(|cell| cell.symbol() == &**glyph)
        {
            links.insert(buffer.pos_of(index), open.clone());
        }
    }
    let changed = previous
        .iter()
        .filter(|(at, open)| links.get(at) != Some(open))
        .map(|(at, _)| *at)
        .chain(
            links
                .iter()
                .filter(|(at, open)| previous.get(at) != Some(open))
                .map(|(at, _)| *at),
        );
    let area = buffer.area;
    let changed: Vec<_> = changed.collect();
    for (x, y) in changed {
        if area.contains((x, y).into()) {
            let cell = &mut buffer[(x, y)];
            if cell.diff_option == CellDiffOption::None {
                cell.set_diff_option(CellDiffOption::AlwaysUpdate);
            }
        }
    }
    links
}

/// `cell` with its symbol inside the link `open` starts.
pub(crate) fn wrap(cell: &Cell, open: &str) -> Cell {
    let mut cell = cell.clone();
    let symbol = format!("{open}{}{CLOSE}", cell.symbol());
    cell.set_symbol(&symbol);
    cell
}

#[cfg(test)]
mod tests {
    use ratatui_core::layout::Rect;

    use super::*;

    #[test]
    fn only_a_url_the_app_could_open_is_a_link() {
        assert_eq!(
            open(7, "https://example.com/x").as_deref(),
            Some("\x1b]8;id=nsh-7;https://example.com/x\x1b\\")
        );
        assert_eq!(
            open(7, "https://example.com/caf\u{e9}").as_deref(),
            Some("\x1b]8;id=nsh-7;https://example.com/caf%C3%A9\x1b\\")
        );
        for href in [
            "",
            "/settings",
            "#top",
            "https://e.com/a b",
            "https://e.com/\x1b]8;;x",
            "a\x07b",
            "a\u{9b}b",
            "a\nb",
            "a\x7fb",
        ] {
            assert_eq!(open(7, href), None, "{href:?}");
        }
    }

    #[test]
    fn a_link_drawn_over_is_dropped_and_a_changed_one_is_drawn_again() {
        let mut buffer = Buffer::empty(Rect::new(0, 0, 4, 1));
        buffer[(0, 0)].set_symbol("a");
        buffer[(1, 0)].set_symbol("x");
        let first: Arc<str> = open(1, "https://a").unwrap();
        let painted: Painted = [
            (0, (first.clone(), Arc::from("a"))),
            (1, (first.clone(), Arc::from("b"))),
        ]
        .into();
        let links = finish(&mut buffer, &painted, &Links::new());
        assert_eq!(links, [((0, 0), first.clone())].into());
        let second: Arc<str> = open(1, "https://b").unwrap();
        let mut again = Buffer::empty(buffer.area);
        again[(0, 0)].set_symbol("a");
        let next = finish(
            &mut again,
            &[(0, (second.clone(), Arc::from("a")))].into(),
            &links,
        );
        assert_eq!(next, [((0, 0), second)].into());
        assert_eq!(again[(0, 0)].diff_option, CellDiffOption::AlwaysUpdate);
        // An unchanged link leaves the Cell to the diff.
        let mut same = Buffer::empty(buffer.area);
        same[(0, 0)].set_symbol("a");
        finish(&mut same, &painted, &links);
        assert_eq!(same[(0, 0)].diff_option, CellDiffOption::None);
    }
}
