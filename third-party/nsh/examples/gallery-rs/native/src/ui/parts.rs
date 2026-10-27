//! The gallery's building blocks without state of their own (as the TSX
//! gallery's `ui.tsx`): builders that render to elements, GPUI-style.
//! Those with content take it with `.child(..)` / `.children(..)`; those
//! with a root to place (a card in a row) take [`Styled`] methods for it.

use nsh_base::nav_page;
use nsh_core::{
    element::{AnyElement, Os, Screen, StyleRefinement},
    prelude::*,
};

/// A text a builder shows: a value, a signal or a closure.
type Label = Reactive<SharedString>;

use super::{
    animated::press,
    icons::{IconName, Tint, icon},
    theme::{Finish, Finished, MONO, Tone, colors, radius},
};

/// Delegates [`Styled`] to the builder's root view, and gives it
/// [`FluentBuilder`].
macro_rules! styled_root {
    ($($name:ident),*) => {$(
        impl Styled for $name {
            fn style(&mut self) -> &mut StyleRefinement {
                Styled::style(&mut self.root)
            }
        }

        impl FluentBuilder for $name {}
    )*};
}

/// Takes content: `.child(..)`, `.children(..)`.
macro_rules! content {
    ($($name:ident),*) => {$(
        impl $name {
            /// Adds content.
            pub(crate) fn child(mut self, child: impl IntoElement) -> Self {
                self.content.push(child.into_element());
                self
            }

            /// Adds content (an `Option` adds one or none).
            #[allow(dead_code, reason = "made for every builder; not every builder's demos pass a list")]
            pub(crate) fn children(
                mut self,
                children: impl IntoIterator<Item = impl IntoElement>,
            ) -> Self {
                self.content.extend(children.into_iter().map(IntoElement::into_element));
                self
            }
        }
    )*};
}

/// The gallery's header colors on a screen (TS `{...header}`): the page's
/// background, the text color for the title, the accent for the back
/// button, following the appearance.
pub(crate) fn header(screen: Screen) -> Screen {
    screen.header_style_with(|s| {
        s.bg(colors::BACKGROUND)
            .text_color(colors::TEXT)
            .tint_color(colors::ACCENT)
    })
}

/// Whether the app draws its pages' headers ([`PageHeader`]): on the
/// desktops and the web; iOS and Android show the system's.
pub(crate) fn draws_header() -> bool {
    !matches!(os(), Os::Ios | Os::Android)
}

/// A pushed screen with the gallery's header: `title` in the system's
/// header on phones, a [`PageHeader`] with a back button where the app
/// draws it.
pub(crate) fn titled(title: impl Into<SharedString>) -> Screen {
    let title = title.into();
    with_header(header(nav_page().title(title.clone())), || {
        PageHeader::new(title)
    })
}

/// `screen` with the header `make` makes where the app draws headers
/// ([`draws_header`]); the system's header elsewhere.
pub(crate) fn with_header(screen: Screen, make: impl FnOnce() -> PageHeader) -> Screen {
    if draws_header() {
        screen.header(make())
    } else {
        screen
    }
}

/// A page's header where the app draws it (TS `PageHeader`): a back
/// button (popping the gallery's stack), the title, and items on either
/// side, on the page's background over a hairline.
pub(crate) struct PageHeader {
    title: Option<Label>,
    title_element: Option<AnyElement>,
    back: bool,
    left: Option<AnyElement>,
    right: Option<AnyElement>,
    tint: AdaptiveColor,
    text_color: AdaptiveColor,
    transparent: bool,
    background: AdaptiveColor,
    root: View,
}

impl PageHeader {
    /// A header titled `title`, with a back button.
    pub(crate) fn new(title: impl IntoReactive<SharedString>) -> Self {
        Self {
            title: Some(title.into_reactive()),
            title_element: None,
            back: true,
            left: None,
            right: None,
            tint: colors::ACCENT,
            text_color: colors::TEXT,
            transparent: false,
            background: colors::BACKGROUND,
            root: view(),
        }
    }

    /// Whether it has a back button (default true).
    pub(crate) fn back(mut self, back: bool) -> Self {
        self.back = back;
        self
    }

    /// An element in place of the title.
    pub(crate) fn title_element(mut self, title: impl IntoElement) -> Self {
        self.title_element = Some(title.into_element());
        self
    }

    /// An element left of the title (after the back button).
    pub(crate) fn left(mut self, item: impl IntoElement) -> Self {
        self.left = Some(item.into_element());
        self
    }

    /// An element right of the title.
    pub(crate) fn right(mut self, item: impl IntoElement) -> Self {
        self.right = Some(item.into_element());
        self
    }

    /// The colors of the title and of the back button.
    pub(crate) fn colors(mut self, text_color: AdaptiveColor, tint: AdaptiveColor) -> Self {
        self.text_color = text_color;
        self.tint = tint;
        self
    }

    /// Its background (default: the page's).
    pub(crate) fn background(mut self, background: AdaptiveColor) -> Self {
        self.background = background;
        self
    }

    /// No background and no hairline: the content shows under it.
    pub(crate) fn transparent(mut self) -> Self {
        self.transparent = true;
        self
    }
}

styled_root!(PageHeader);

impl IntoElement for PageHeader {
    fn into_element(self) -> AnyElement {
        let tint = self.tint;
        let back = self.back.then(|| {
            view()
                .size(px(32.0))
                .rounded(px(radius::CONTROL))
                .items_center()
                .justify_center()
                .cursor_pointer()
                .role(AccessibilityRole::Button)
                .label("Back")
                .hover(|s| s.bg(colors::RAISED))
                .active(|s| s.opacity(0.6))
                .on_press(crate::nav::pop)
                .child(
                    view()
                        .rotate(deg(180.0))
                        .child(icon().name(IconName::Chevron).size(18.0).tint(tint)),
                )
        });
        let title = match (self.title_element, self.title) {
            (Some(element), _) => view().flex_1().flex_row().child(element).into_element(),
            (None, Some(title)) => text(title)
                .flex_1()
                .number_of_lines(1)
                .text_size(px(17.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(self.text_color)
                .into_element(),
            (None, None) => view().flex_1().into_element(),
        };
        self.root
            .h(px(52.0))
            .flex_row()
            .items_center()
            .gap_2()
            .px_3()
            .when(!self.transparent, |v| {
                v.bg(self.background)
                    .border_b_1()
                    .border_b_color(colors::LINE)
            })
            .children(back)
            .children(self.left)
            .child(title)
            .children(self.right)
            .into_element()
    }
}

/// A rounded icon tile.
pub(crate) struct IconTile {
    name: IconName,
    size: f32,
    tint: Reactive<AdaptiveColor>,
    root: View,
}

impl IconTile {
    /// Tile of `name`, 40 pt, the glyph in the text color.
    pub(crate) fn new(name: IconName) -> Self {
        Self {
            name,
            size: 40.0,
            tint: Reactive::Static(colors::TEXT),
            root: view(),
        }
    }

    /// Its width and height.
    pub(crate) fn size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }

    /// The glyph's color (a color, or a signal or closure of one).
    pub(crate) fn tint(mut self, tint: impl IntoReactive<AdaptiveColor>) -> Self {
        self.tint = tint.into_reactive();
        self
    }
}

impl IntoElement for IconTile {
    fn into_element(self) -> AnyElement {
        let size = self.size;
        self.root
            .size(px(size))
            .rounded(px(size * 0.3))
            .border_curve(BorderCurve::Continuous)
            .border_1()
            .border_color(colors::BORDER)
            .bg(colors::RAISED)
            .finish(Finish::Raised)
            .items_center()
            .justify_center()
            .child(
                icon()
                    .name(self.name)
                    .size(size * 0.5)
                    .tint(self.tint.map(Tint::from)),
            )
            .into_element()
    }
}

/// A card: an optional icon, a title and a subtitle, something on the
/// right (a badge, an action), then the content on an inset surface (or
/// bare with [`Card::flush`]).
pub(crate) struct Card {
    icon: Option<IconName>,
    title: Option<Label>,
    subtitle: Option<Label>,
    right: Option<AnyElement>,
    flush: bool,
    content: Vec<AnyElement>,
    root: View,
}

impl Card {
    /// An empty card.
    pub(crate) fn new() -> Self {
        Self {
            icon: None,
            title: None,
            subtitle: None,
            right: None,
            flush: false,
            content: Vec::new(),
            root: view(),
        }
    }

    /// Its icon, before the title.
    pub(crate) fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    /// Its title (without one, no header row).
    pub(crate) fn title(mut self, title: impl IntoReactive<SharedString>) -> Self {
        self.title = Some(title.into_reactive());
        self
    }

    /// The line under the title.
    pub(crate) fn subtitle(mut self, subtitle: impl IntoReactive<SharedString>) -> Self {
        self.subtitle = Some(subtitle.into_reactive());
        self
    }

    /// What sits right of the title.
    pub(crate) fn right(mut self, right: impl IntoElement) -> Self {
        self.right = Some(right.into_element());
        self
    }

    /// The content sits on the card itself, not on an inset.
    pub(crate) fn flush(mut self) -> Self {
        self.flush = true;
        self
    }
}

impl Default for Card {
    fn default() -> Self {
        Self::new()
    }
}

/// A card's or a section's surface.
fn card_surface(root: View) -> View {
    root.bg(colors::SURFACE)
        .rounded(px(radius::CARD))
        .border_curve(BorderCurve::Continuous)
        .border_1()
        .border_color(colors::BORDER)
        .p(px(5.0))
        .finish(Finish::Card)
}

impl IntoElement for Card {
    fn into_element(self) -> AnyElement {
        let header = self.title.map(|title| {
            view()
                .flex_row()
                .items_center()
                .gap_3()
                .px(px(11.0))
                .pt(px(11.0))
                .pb(px(12.0))
                .children(self.icon.map(IconTile::new))
                .child(
                    view()
                        .flex_1()
                        .gap(px(2.0))
                        .child(
                            text(title)
                                .text_size(px(17.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(colors::TEXT),
                        )
                        .children(self.subtitle.map(|subtitle| {
                            text(subtitle)
                                .number_of_lines(2)
                                .text_size(px(13.0))
                                .text_color(colors::MUTED)
                        })),
                )
                .children(self.right)
        });
        let surface = card_surface(self.root).children(header);
        if self.flush {
            surface.children(self.content)
        } else {
            surface.child(Inset::new().children(self.content))
        }
        .into_element()
    }
}

/// A titled card of controls (the demos' sections).
pub(crate) struct Section {
    title: Label,
    note: Option<Label>,
    content: Vec<AnyElement>,
    root: View,
}

impl Section {
    /// A section titled `title`.
    pub(crate) fn new(title: impl IntoReactive<SharedString>) -> Self {
        Self {
            title: title.into_reactive(),
            note: None,
            content: Vec::new(),
            root: view(),
        }
    }

    /// A quiet note right of the title.
    pub(crate) fn note(mut self, note: impl IntoReactive<SharedString>) -> Self {
        self.note = Some(note.into_reactive());
        self
    }
}

impl IntoElement for Section {
    fn into_element(self) -> AnyElement {
        card_surface(self.root)
            .child(
                view()
                    .flex_row()
                    .items_baseline()
                    .px(px(11.0))
                    .py(px(10.0))
                    .gap_2()
                    .child(
                        text(self.title)
                            .flex_1()
                            .text_size(px(15.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(colors::TEXT),
                    )
                    .children(self.note.map(|note| {
                        text(note)
                            .text_size(px(13.0))
                            .text_color(colors::FAINT)
                            .tabular_nums()
                    })),
            )
            .child(Inset::new().children(self.content))
            .into_element()
    }
}

/// The darker surface inside a card.
pub(crate) struct Inset {
    gap: f32,
    padding: f32,
    content: Vec<AnyElement>,
    root: View,
}

impl Inset {
    /// An inset with 14 pt padding and 12 pt between its children.
    pub(crate) fn new() -> Self {
        Self {
            gap: 12.0,
            padding: 14.0,
            content: Vec::new(),
            root: view(),
        }
    }

    /// The space between its children.
    pub(crate) fn gap(mut self, gap: f32) -> Self {
        self.gap = gap;
        self
    }

    /// Its padding.
    pub(crate) fn padding(mut self, padding: f32) -> Self {
        self.padding = padding;
        self
    }
}

impl Default for Inset {
    fn default() -> Self {
        Self::new()
    }
}

impl IntoElement for Inset {
    fn into_element(self) -> AnyElement {
        self.root
            .bg(colors::INSET)
            .rounded(px(radius::INSET))
            .border_curve(BorderCurve::Continuous)
            .border_1()
            .border_color(colors::LINE)
            .finish(Finish::Inset)
            .p(px(self.padding))
            .gap(px(self.gap))
            .children(self.content)
            .into_element()
    }
}

/// A caption row: a label on the left, a quieter note on the right.
pub(crate) fn caption(
    label: impl IntoReactive<SharedString>,
    note: Option<impl IntoReactive<SharedString>>,
) -> View {
    view()
        .flex_row()
        .items_baseline()
        .gap_2()
        .child(
            text(label)
                .flex_1()
                .text_size(px(14.0))
                .text_color(colors::MUTED),
        )
        .children(note.map(|note| {
            text(note)
                .text_size(px(13.0))
                .text_color(colors::FAINT)
                .tabular_nums()
        }))
}

/// A large figure with a tinted note after it ("38 / 1k  would pass").
pub(crate) struct Figure {
    value: Label,
    unit: Option<Label>,
    note: Option<Label>,
    tone: Reactive<Tone>,
}

impl Figure {
    /// The figure `value`.
    pub(crate) fn new(value: impl IntoReactive<SharedString>) -> Self {
        Self {
            value: value.into_reactive(),
            unit: None,
            note: None,
            tone: Reactive::Static(Tone::Accent),
        }
    }

    /// Its unit, quieter, after it.
    pub(crate) fn unit(mut self, unit: impl IntoReactive<SharedString>) -> Self {
        self.unit = Some(unit.into_reactive());
        self
    }

    /// A note after it, in `tone`'s color (the accent by default).
    pub(crate) fn note(mut self, note: impl IntoReactive<SharedString>) -> Self {
        self.note = Some(note.into_reactive());
        self
    }

    /// The note's tone.
    pub(crate) fn tone(mut self, tone: impl IntoReactive<Tone>) -> Self {
        self.tone = tone.into_reactive();
        self
    }
}

impl IntoElement for Figure {
    fn into_element(self) -> AnyElement {
        text(self.value)
            .text_size(px(32.0))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(colors::TEXT)
            .tabular_nums()
            .letter_spacing(px(-0.5))
            .children(self.unit.map(|unit| {
                text(unit.map(|unit| SharedString::from(format!(" {unit}"))))
                    .text_size(px(17.0))
                    .font_weight(FontWeight::NORMAL)
                    .text_color(colors::MUTED)
            }))
            .children(self.note.map(|note| {
                let tone = self.tone;
                text(note.map(|note| SharedString::from(format!(" {note}"))))
                    .text_size(px(15.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(tone.map(Tone::color))
            }))
            .into_element()
    }
}

/// A small label in a tinted capsule.
pub(crate) struct Badge {
    label: Label,
    tone: Reactive<Tone>,
    outline: bool,
}

impl Badge {
    /// A neutral badge `label`.
    pub(crate) fn new(label: impl IntoReactive<SharedString>) -> Self {
        Self {
            label: label.into_reactive(),
            tone: Reactive::Static(Tone::Neutral),
            outline: false,
        }
    }

    /// Its tone.
    pub(crate) fn tone(mut self, tone: impl IntoReactive<Tone>) -> Self {
        self.tone = tone.into_reactive();
        self
    }

    /// A rim in the tone's color instead of a fill.
    pub(crate) fn outline(mut self) -> Self {
        self.outline = true;
        self
    }
}

impl IntoElement for Badge {
    fn into_element(self) -> AnyElement {
        let tone = self.tone;
        let fg = tone.clone().map(|tone| {
            if tone == Tone::Neutral {
                colors::TEXT
            } else {
                tone.color()
            }
        });
        let outline = self.outline;
        view()
            .px(px(10.0))
            .h(px(26.0))
            .rounded(px(13.0))
            .justify_center()
            .border_1()
            .map(|v| {
                if outline {
                    v.border_color(tone.map(Tone::color))
                } else {
                    let rim = fg.clone().map(|fg| fg.opacity(0.1));
                    v.bg(tone.map(Tone::tint))
                        .finish_shadow(Finish::Chip)
                        .border_color(rim)
                }
            })
            .child(
                text(self.label)
                    .text_size(px(12.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg),
            )
            .into_element()
    }
}

/// A label above a value, for grids of figures.
pub(crate) struct Stat {
    label: Label,
    value: Label,
    /// The value's tone (none: the text's color).
    tone: Reactive<Option<Tone>>,
    width: Option<f32>,
}

impl Stat {
    /// `value`, labelled `label`.
    pub(crate) fn new(
        label: impl IntoReactive<SharedString>,
        value: impl IntoReactive<SharedString>,
    ) -> Self {
        Self {
            label: label.into_reactive(),
            value: value.into_reactive(),
            tone: Reactive::Static(None),
            width: None,
        }
    }

    /// The value in `tone`'s color.
    pub(crate) fn tone(mut self, tone: impl IntoReactive<Tone>) -> Self {
        self.tone = tone.into_reactive().map(Some);
        self
    }

    /// The value in `tone`'s color while `when` holds, in the text's
    /// otherwise.
    pub(crate) fn tone_when(mut self, when: impl IntoReactive<bool>, tone: Tone) -> Self {
        self.tone = when.into_reactive().map(move |on| on.then_some(tone));
        self
    }

    /// Its width, a fraction of the row (`0.5`: two per row).
    pub(crate) fn width(mut self, fraction: f32) -> Self {
        self.width = Some(fraction);
        self
    }
}

impl IntoElement for Stat {
    fn into_element(self) -> AnyElement {
        view()
            .when_some(self.width, |v, w| v.w(relative(w)))
            .gap(px(3.0))
            .py_1()
            .child(
                text(self.label)
                    .text_size(px(12.0))
                    .text_color(colors::MUTED),
            )
            .child(
                text(self.value)
                    .text_size(px(15.0))
                    .text_color(self.tone.map(|t| t.map_or(colors::TEXT, Tone::color)))
                    .tabular_nums(),
            )
            .into_element()
    }
}

/// A colored square and a label (and a value), for chart legends; the
/// color can be bound.
pub(crate) fn legend(
    color: impl IntoReactive<AdaptiveColor>,
    label: impl IntoReactive<SharedString>,
    value: Option<impl IntoReactive<SharedString>>,
) -> View {
    view()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .child(view().size(px(9.0)).rounded(px(2.5)).bg(color))
        .child(
            text(label)
                .text_size(px(13.0))
                .text_color(colors::MUTED)
                .children(value.map(|value| {
                    text(
                        value
                            .into_reactive()
                            .map(|value| SharedString::from(format!(" {value}"))),
                    )
                    .text_color(colors::TEXT)
                    .tabular_nums()
                })),
        )
}

/// A row inside an inset, with a hairline above all but the first.
pub(crate) struct Row {
    first: bool,
    on_press: Option<Listener<()>>,
    content: Vec<AnyElement>,
    root: View,
}

impl Row {
    /// A row; `first` leaves the hairline out.
    pub(crate) fn new(first: bool) -> Self {
        Self {
            first,
            on_press: None,
            content: Vec::new(),
            root: view(),
        }
    }
}

impl IntoElement for Row {
    fn into_element(self) -> AnyElement {
        self.root
            .min_h(px(48.0))
            .flex_row()
            .items_center()
            .gap_3()
            .when(!self.first, |v| v.border_t_1().border_t_color(colors::LINE))
            .when_some(self.on_press, |v, listener| {
                v.on_press(listener).active(|s| s.bg(colors::RAISED))
            })
            .children(self.content)
            .into_element()
    }
}

/// A [`Button`]'s look.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum ButtonVariant {
    /// Light on the dark page, dark on the light one: the main action.
    #[default]
    Primary,
    /// A raised control.
    Secondary,
    /// Citrus.
    Accent,
    /// Only a rim.
    Ghost,
}

/// A button, 44 pt tall: `Primary` is light (the main action),
/// `Secondary` dark, `Accent` citrus. [`Button::color`] fills it with
/// that color instead.
pub(crate) struct Button {
    label: Label,
    variant: Reactive<ButtonVariant>,
    color: Option<AdaptiveColor>,
    icon: Option<Reactive<IconName>>,
    disabled: Prop<bool>,
    on_press: Listener<()>,
    root: View,
}

impl Button {
    /// A primary button `label` calling `on_press`.
    pub(crate) fn new(
        label: impl IntoReactive<SharedString>,
        on_press: impl Into<Listener<()>>,
    ) -> Self {
        Self {
            label: label.into_reactive(),
            variant: Reactive::Static(ButtonVariant::Primary),
            color: None,
            icon: None,
            disabled: false.into(),
            on_press: on_press.into(),
            root: view(),
        }
    }

    /// Its look (a variant, or a signal or closure of one).
    pub(crate) fn variant(mut self, variant: impl IntoReactive<ButtonVariant>) -> Self {
        self.variant = variant.into_reactive();
        self
    }

    /// An icon before the label (a glyph, or a signal or closure of one).
    pub(crate) fn icon(mut self, icon: impl IntoReactive<IconName>) -> Self {
        self.icon = Some(icon.into_reactive());
        self
    }

    /// Takes no presses.
    pub(crate) fn disabled(mut self, disabled: impl Into<Prop<bool>>) -> Self {
        self.disabled = disabled.into();
        self
    }
}

nsh_core::static_reactive!(ButtonVariant: ButtonVariant);

/// A [`Button`]'s look: its fill and content colors, its finish, whether
/// it has a rim.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ButtonLook {
    bg: AdaptiveColor,
    fg: AdaptiveColor,
    finish: Option<Finish>,
    rim: bool,
}

impl ButtonLook {
    /// The look of `variant`, filled with `color` if given.
    fn of(variant: ButtonVariant, color: Option<AdaptiveColor>) -> Self {
        let (bg, fg) = match (color, variant) {
            (Some(color), _) => (color, AdaptiveColor::from(rgb(0xffffff))),
            (None, ButtonVariant::Primary) => (colors::LIGHT, colors::ON_LIGHT),
            (None, ButtonVariant::Accent) => (colors::ACCENT_FILL, colors::ON_ACCENT),
            (None, ButtonVariant::Ghost) => (AdaptiveColor::TRANSPARENT, colors::TEXT),
            (None, ButtonVariant::Secondary) => (colors::RAISED, colors::TEXT),
        };
        let finish = match variant {
            _ if color.is_some() => None,
            ButtonVariant::Primary => Some(Finish::Light),
            ButtonVariant::Accent => Some(Finish::Accent),
            ButtonVariant::Secondary => Some(Finish::Raised),
            ButtonVariant::Ghost => None,
        };
        let rim = matches!(variant, ButtonVariant::Secondary | ButtonVariant::Ghost);
        Self {
            bg,
            fg,
            finish,
            rim,
        }
    }
}

/// `surface` in `look`: set once for a fixed variant, bound (colors, and
/// a layer per finish) for one that changes.
fn button_surface(surface: View, look: &Reactive<ButtonLook>) -> View {
    match look {
        Reactive::Static(look) => surface
            .bg(look.bg)
            .when_some(look.finish, |v, f| v.finish(f))
            .when(look.rim, |v| v.border_1().border_color(colors::BORDER)),
        Reactive::Bound(_) => {
            let finished = |f: Finish| look.clone().map(move |l| l.finish == Some(f));
            surface
                .bg(look.clone().map(|l| l.bg))
                .style_when(finished(Finish::Light), |v| v.finish(Finish::Light))
                .style_when(finished(Finish::Accent), |v| v.finish(Finish::Accent))
                .style_when(finished(Finish::Raised), |v| v.finish(Finish::Raised))
                .style_when(look.clone().map(|l| l.rim), |v| {
                    v.border_1().border_color(colors::BORDER)
                })
        }
    }
}

impl IntoElement for Button {
    fn into_element(self) -> AnyElement {
        let color = self.color;
        let look = match self.variant {
            Reactive::Static(variant) => Reactive::Static(ButtonLook::of(variant, color)),
            // One memo of the look: its parts' bindings read it.
            Reactive::Bound(variant) => {
                let look = computed(move || ButtonLook::of(variant(), color));
                look.into_reactive()
            }
        };
        let fg = look.clone().map(|l| l.fg);
        // The root (the press target) takes the caller's styles: `flex_1`
        // shares a row.
        press()
            .disabled(self.disabled)
            .label(Prop::from(self.label.clone().map(Some)))
            .on_press(self.on_press)
            .map(|p| apply_root(p, self.root))
            .child(
                button_surface(
                    view()
                        .h(px(44.0))
                        .px(px(18.0))
                        .rounded(px(radius::CONTROL))
                        .border_curve(BorderCurve::Continuous)
                        .flex_row()
                        .items_center()
                        .justify_center()
                        .gap_2(),
                    &look,
                )
                .children(self.icon.map(|name| {
                    icon()
                        .name(name)
                        .size(16.0)
                        .tint(fg.clone().map(Tint::from))
                }))
                .child(
                    text(self.label)
                        .text_size(px(15.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(fg),
                ),
            )
            .into_element()
    }
}

/// A round icon button (44 pt): light by default, [`RoundButton::secondary`]
/// dark.
pub(crate) struct RoundButton {
    icon: Reactive<IconName>,
    label: Label,
    secondary: bool,
    size: f32,
    disabled: bool,
    on_press: Listener<()>,
    root: View,
}

impl RoundButton {
    /// A button of `icon`, labelled `label` for assistive technologies,
    /// calling `on_press` (the glyph and the label can be bound).
    pub(crate) fn new(
        icon: impl IntoReactive<IconName>,
        label: impl IntoReactive<SharedString>,
        on_press: impl Into<Listener<()>>,
    ) -> Self {
        Self {
            icon: icon.into_reactive(),
            label: label.into_reactive(),
            secondary: false,
            size: 44.0,
            disabled: false,
            on_press: on_press.into(),
            root: view(),
        }
    }

    /// Dark, on lit glass.
    pub(crate) fn secondary(mut self) -> Self {
        self.secondary = true;
        self
    }
}

impl IntoElement for RoundButton {
    fn into_element(self) -> AnyElement {
        let size = self.size;
        let primary = !self.secondary;
        press()
            .scale(0.92)
            .disabled(self.disabled)
            .label(Prop::from(self.label.map(Some)))
            .on_press(self.on_press)
            .map(|p| apply_root(p, self.root))
            .child(
                view()
                    .size(px(size))
                    .rounded(px(size / 2.0))
                    .items_center()
                    .justify_center()
                    .map(|v| {
                        if primary {
                            v.bg(colors::LIGHT).finish(Finish::Light)
                        } else {
                            v.bg(colors::RAISED).finish(Finish::Pill).border_1()
                        }
                    })
                    .child(
                        icon()
                            .name(Prop::from(self.icon))
                            .size(size * 0.42)
                            .tint(if primary {
                                colors::ON_LIGHT
                            } else {
                                colors::TEXT
                            }),
                    ),
            )
            .into_element()
    }
}

/// `root`'s styles on `element` (a builder's root that is a component).
fn apply_root<E: Styled>(mut element: E, mut root: View) -> E {
    let styles = std::mem::take(Styled::style(&mut root));
    *Styled::style(&mut element) = styles;
    element
}

/// A horizontal meter with an optional marker (a limit).
pub(crate) struct Meter {
    value: Reactive<f32>,
    tone: Reactive<Tone>,
    marker: Option<f32>,
}

impl Meter {
    /// Filled to `value` (0 to 1), in the accent.
    pub(crate) fn new(value: impl IntoReactive<f32>) -> Self {
        Self {
            value: value.into_reactive(),
            tone: Reactive::Static(Tone::Accent),
            marker: None,
        }
    }

    /// The fill's tone.
    pub(crate) fn tone(mut self, tone: impl IntoReactive<Tone>) -> Self {
        self.tone = tone.into_reactive();
        self
    }

    /// A mark at `at` (0 to 1).
    pub(crate) fn marker(mut self, at: f32) -> Self {
        self.marker = Some(at);
        self
    }
}

impl IntoElement for Meter {
    fn into_element(self) -> AnyElement {
        view()
            .h(px(6.0))
            .rounded(px(3.0))
            .bg(colors::RAISED)
            .child(
                view()
                    .w(self
                        .value
                        .map(|v| Length::from(relative(v.clamp(0.0, 1.0)))))
                    .h(px(6.0))
                    .rounded(px(3.0))
                    .bg(self.tone.map(Tone::color)),
            )
            .children(self.marker.map(|at| {
                view()
                    .absolute()
                    .left(relative(at))
                    .top(px(-3.0))
                    .w(px(2.0))
                    .h(px(12.0))
                    .rounded(px(1.0))
                    .bg(colors::TEXT)
            }))
            .into_element()
    }
}

styled_root!(IconTile, Card, Section, Inset, Row, Button, RoundButton);
content!(Card, Section, Inset, Row);

/// Text in the monospaced family (TS `fontFamily: mono`): API names and
/// identifiers.
pub(crate) fn code(content: impl Into<SharedString>) -> Text {
    text(content.into()).font_family(MONO)
}
