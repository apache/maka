//! A demo's page of cards (as the TSX gallery's `DemoPage`): one column on
//! phones, as many as fit the content pane in the desktop layout.

use std::rc::Rc;

use nsh_core::{element::Reactive, prelude::*};

use super::{
    animated::appear,
    layout::{columns_for, desktop, pane_width},
    theme::colors,
};

/// Makes a card. It is called again when the desktop layout deals the
/// cards into another number of columns: what a card must keep across
/// that (what the user typed or chose) lives in the demo's signals.
type MakeCard = Rc<dyn Fn() -> AnyElement>;

/// A demo's page of cards, each fading in after the one before. On phones
/// one column on the 16 pt gutters; in the desktop layout the cards are
/// dealt left to right into as many columns as fit the pane (at least
/// 380 pt each, [`DemoPage::columns`] at most), on 24 pt gutters, made
/// again when the window's width changes their count. Content added with
/// [`DemoPage::child`] follows the cards inside the scroll view (a demo's
/// modals).
pub(crate) struct DemoPage {
    cards: Vec<MakeCard>,
    columns: u32,
    bottom: f32,
    appear: bool,
    keyboard_dismiss_mode: Option<Reactive<KeyboardDismissMode>>,
    keyboard_taps: Option<Reactive<KeyboardTaps>>,
    content: Vec<AnyElement>,
}

impl DemoPage {
    /// A page without cards: at most 2 columns, 40 pt under the last card
    /// on phones, the cards fading in.
    pub(crate) fn new() -> Self {
        Self {
            cards: Vec::new(),
            columns: 2,
            bottom: 40.0,
            appear: true,
            keyboard_dismiss_mode: None,
            keyboard_taps: None,
            content: Vec::new(),
        }
    }

    /// Adds the card `make` makes (called again when the columns change).
    pub(crate) fn card<E: IntoElement>(mut self, make: impl Fn() -> E + 'static) -> Self {
        self.cards.push(Rc::new(move || make().into_element()));
        self
    }

    /// Adds the cards each of `makes` makes.
    pub(crate) fn cards<E: IntoElement>(
        mut self,
        makes: impl IntoIterator<Item = impl Fn() -> E + 'static>,
    ) -> Self {
        for make in makes {
            self = self.card(make);
        }
        self
    }

    /// The most columns in the desktop layout (default 2).
    pub(crate) fn columns(mut self, columns: u32) -> Self {
        self.columns = columns;
        self
    }

    /// The space under the last card on phones (default 40 pt).
    pub(crate) fn bottom(mut self, bottom: f32) -> Self {
        self.bottom = bottom;
        self
    }

    /// Whether the cards fade in (default true).
    pub(crate) fn appear(mut self, appear: bool) -> Self {
        self.appear = appear;
        self
    }

    /// How dragging the page treats the keyboard (TS:
    /// `keyboardDismissMode`).
    pub(crate) fn keyboard_dismiss_mode(
        mut self,
        mode: impl IntoReactive<KeyboardDismissMode>,
    ) -> Self {
        self.keyboard_dismiss_mode = Some(mode.into_reactive());
        self
    }

    /// Taps while the keyboard shows (TS: `keyboardShouldPersistTaps`).
    pub(crate) fn keyboard_taps(mut self, taps: impl IntoReactive<KeyboardTaps>) -> Self {
        self.keyboard_taps = Some(taps.into_reactive());
        self
    }

    /// Adds content after the cards, inside the scroll view.
    pub(crate) fn child(mut self, child: impl IntoElement) -> Self {
        self.content.push(child.into_element());
        self
    }
}

impl Default for DemoPage {
    fn default() -> Self {
        Self::new()
    }
}

/// The card `make` makes at `index` among the page's: fading in after the
/// ones before it, or as it is.
fn place(make: &MakeCard, index: usize, appears: bool) -> AnyElement {
    if appears {
        appear().index(index as u32).child(make()).into_element()
    } else {
        make()
    }
}

impl IntoElement for DemoPage {
    fn into_element(self) -> AnyElement {
        let Self {
            cards,
            columns: most,
            bottom,
            appear: appears,
            keyboard_dismiss_mode,
            keyboard_taps,
            content,
        } = self;
        // The shell makes the demo again when the layout changes: read once.
        let cards: Vec<AnyElement> = if untracked(desktop) {
            // Read in the layout below: it is made again only when the count
            // changes.
            let count = computed(move || columns_for(380.0, most, pane_width(), 20.0));
            let cards = Rc::new(cards);
            vec![dynamic(move || {
                let n = count.get();
                let columns = (0..n as usize).map(|column| {
                    view().flex_1().min_w(px(0.0)).gap(px(20.0)).children(
                        cards
                            .iter()
                            .enumerate()
                            .filter(|(i, _)| i % n as usize == column)
                            .map(|(i, make)| place(make, i, appears)),
                    )
                });
                view()
                    .flex_row()
                    .items_start()
                    .gap(px(20.0))
                    .p_6()
                    .pb(px(48.0))
                    .w_full()
                    .max_w(px(n as f32 * 560.0 + 48.0))
                    .self_center()
                    .children(columns)
            })]
        } else {
            vec![
                view()
                    .p_4()
                    .pb(px(bottom))
                    .gap_4()
                    .children(
                        cards
                            .iter()
                            .enumerate()
                            .map(|(i, make)| place(make, i, appears)),
                    )
                    .into_element(),
            ]
        };
        // The page scrolls inside the component's view.
        view()
            .flex_1()
            .child(
                scroll()
                    .flex_1()
                    .bg(colors::BACKGROUND)
                    .when_some(keyboard_dismiss_mode, |s, mode| {
                        s.keyboard_dismiss_mode(mode)
                    })
                    .when_some(keyboard_taps, |s, taps| s.keyboard_taps(taps))
                    .children(cards)
                    .children(content),
            )
            .into_element()
    }
}
