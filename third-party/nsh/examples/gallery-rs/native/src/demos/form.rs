//! Form: an account form in a scroll view (the focused input stays above
//! the keyboard natively, return moves to the next one, dragging the form
//! can hide the keyboard; leaving a field or submitting checks it), fields
//! whose border glows while focused and that shake on an error, selection
//! and keys, a sheet of inputs and a message bar riding on the keyboard
//! (as the TSX gallery's `demos/Form.tsx`).

use nsh_base::{dialog, input};
use nsh_core::{
    Points, Size,
    element::{
        AutoCapitalize, AutoFill, KeyboardDismissMode, LayoutAnimation, ReturnKeyType,
        SubmitBehavior, View,
    },
    prelude::*,
};

use crate::{
    nav,
    ui::{
        Badge, Button, ButtonVariant, Card, DemoPage, Finish, Finished, IconName, IconTile, Inset,
        MONO, Meter, RoundButton, Section, Segment, Tone, appear, caption, colors, hint, icon,
        press, radius, segmented, tints, titled,
    },
};

/// What a [`field`] animates: the focus ring and the shake of an error.
#[derive(Clone, Copy)]
struct FieldFx {
    /// 0 blurred, 1 focused: the ring's opacity.
    focus: AnimatedValue,
    /// The field's horizontal offset while it shakes.
    shake: AnimatedValue,
    /// It shows an error now.
    shown: Stored<bool>,
}

impl FieldFx {
    fn new() -> Self {
        Self {
            focus: animated_value(0.0),
            shake: animated_value(0.0),
            shown: stored(false),
        }
    }

    /// The field shows an error (`error`) or not: a change slides the
    /// message in or out (layout animation), one coming shakes the field.
    fn error(&self, error: bool) {
        if self.shown.replace(error) == error {
            return;
        }
        animate_layout(LayoutAnimation::EASE_IN_EASE_OUT);
        if error {
            Animation::sequence(
                [9.0, -8.0, 6.0, -4.0, 2.0, 0.0].map(|x| {
                    Animation::timing(&self.shake, x, Timing::new(45.0, Easing::EaseInOut))
                }),
            )
            .start();
        }
    }
}

/// A field's error message, when it shows one.
type FieldError = Memo<Option<&'static str>>;

/// A labelled input (`api` names the prop it shows, `hint` is a plain
/// note): the border glows accent while focused (a ring fading in
/// natively), an error turns it red, slides a message in and shakes the
/// field ([`FieldFx::error`]).
struct Field {
    fx: FieldFx,
    label: SharedString,
    api: Option<&'static str>,
    hint: Option<Reactive<SharedString>>,
    error: Option<FieldError>,
    prefix: Option<&'static str>,
    multiline: bool,
    editable: bool,
    on_blur: Option<Box<dyn Fn()>>,
}

/// A [`Field`] labelled `label`, animated by `fx`.
fn field(fx: &FieldFx, label: impl Into<SharedString>) -> Field {
    Field {
        fx: *fx,
        label: label.into(),
        api: None,
        hint: None,
        error: None,
        prefix: None,
        multiline: false,
        editable: true,
        on_blur: None,
    }
}

impl Field {
    fn api(mut self, api: &'static str) -> Self {
        self.api = Some(api);
        self
    }

    fn hint(mut self, hint: impl IntoReactive<SharedString>) -> Self {
        self.hint = Some(hint.into_reactive());
        self
    }

    /// Its error: it shows, and animates in, while there is one.
    fn error(mut self, error: FieldError) -> Self {
        self.error = Some(error);
        self
    }

    fn prefix(mut self, prefix: &'static str) -> Self {
        self.prefix = Some(prefix);
        self
    }

    fn multiline(mut self) -> Self {
        self.multiline = true;
        self
    }

    fn read_only(mut self) -> Self {
        self.editable = false;
        self
    }

    /// Runs when it loses focus, after the ring fades.
    fn on_blur(mut self, f: impl Fn() + 'static) -> Self {
        self.on_blur = Some(Box::new(f));
        self
    }

    /// The field, its input made by `input` from the styled one (values,
    /// listeners, refs, styles of its own).
    fn render(self, input: impl FnOnce(Input) -> Input) -> View {
        let focus = self.fx.focus;
        let on_blur = self.on_blur;
        let base = nsh_core::element::input()
            .placeholder_color(|| color(colors::FAINT))
            .selection_color(|| color(colors::ACCENT))
            .return_key_type(ReturnKeyType::Done)
            .multiline(self.multiline)
            .readonly(!self.editable)
            .on_focus(move || {
                focus.timing(1.0, 160.0, Easing::EaseInOut);
            })
            .on_blur(move || {
                focus.timing(0.0, 220.0, Easing::EaseInOut);
                if let Some(on_blur) = &on_blur {
                    on_blur();
                }
            })
            .flex_1()
            .px(px(14.0))
            .text_size(px(15.0))
            .text_color(if self.editable {
                colors::TEXT
            } else {
                colors::MUTED
            })
            .map(|i| {
                if self.multiline {
                    i.min_h(px(46.0)).pt(px(13.0)).pb(px(13.0))
                } else {
                    i.h(px(46.0))
                }
            });
        let error = self.error;
        let failed = move || error.is_some_and(|e| e.with(Option::is_some));
        if error.is_some() {
            let fx = self.fx;
            effect(move || fx.error(failed()));
        }
        let editable = self.editable;
        view()
            .gap(px(6.0))
            .bind_translate_x(&self.fx.shake)
            .child(
                view()
                    .flex_row()
                    .items_baseline()
                    .gap_2()
                    .child(
                        text(self.label)
                            .flex_1()
                            .text_size(px(13.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(colors::MUTED),
                    )
                    .children(self.api.map(|api| {
                        text(api)
                            .text_size(px(12.0))
                            .text_color(colors::FAINT)
                            .font_family(MONO)
                    }))
                    .children(self.hint.map(|hint| {
                        text(hint)
                            .text_size(px(13.0))
                            .text_color(colors::FAINT)
                            .tabular_nums()
                    })),
            )
            .child(
                view()
                    .flex_row()
                    .map(|v| {
                        if self.multiline {
                            v.items_start()
                        } else {
                            v.items_center()
                        }
                    })
                    .rounded(px(radius::CONTROL))
                    .border_curve(BorderCurve::Continuous)
                    .border_1()
                    .border_color(move || {
                        if failed() {
                            colors::DANGER
                        } else if editable {
                            colors::BORDER
                        } else {
                            colors::LINE
                        }
                    })
                    .bg(colors::INSET)
                    // Recessed while editable; a read-only field lies flat.
                    .when(self.editable, |v| v.finish(Finish::Inset))
                    .children(self.prefix.map(|prefix| {
                        text(prefix)
                            .pl(px(14.0))
                            .text_size(px(15.0))
                            .text_color(colors::MUTED)
                    }))
                    .child(input(base))
                    .child(
                        view()
                            .pointer_events(PointerEvents::None)
                            .absolute()
                            .top(px(-1.0))
                            .left(px(-1.0))
                            .right(px(-1.0))
                            .bottom(px(-1.0))
                            .rounded(px(radius::CONTROL))
                            .border_curve(BorderCurve::Continuous)
                            .border(px(1.5))
                            .border_color(move || {
                                if failed() {
                                    colors::DANGER
                                } else {
                                    colors::ACCENT
                                }
                            })
                            .bind_opacity(&self.fx.focus),
                    ),
            )
            // The error's row comes and goes; while it shows, its text
            // follows the error.
            .children(error.map(|error| {
                when(
                    move || error.with(Option::is_some),
                    move || {
                        view()
                            .flex_row()
                            .items_center()
                            .gap(px(7.0))
                            .child(view().size(px(6.0)).rounded(px(3.0)).bg(colors::DANGER))
                            .child(
                                text(move || error.get().unwrap_or_default())
                                    .flex_1()
                                    .text_size(px(13.0))
                                    .text_color(colors::DANGER),
                            )
                    },
                )
            }))
    }
}

/// Two items side by side, equal widths.
fn pair(a: impl IntoElement, b: impl IntoElement) -> View {
    view()
        .flex_row()
        .gap_2()
        .child(view().flex_1().child(a))
        .child(view().flex_1().child(b))
}

/// A row that opens something: an icon, a title, the API it shows.
fn link_row(
    icon_name: IconName,
    title: &'static str,
    note: &'static str,
    first: bool,
    on_press: impl Into<Listener<()>>,
) -> impl IntoElement {
    let on_press: Listener<()> = on_press.into();
    press().scale(0.98).label(title).on_press(on_press).child(
        view()
            .min_h(px(60.0))
            .flex_row()
            .items_center()
            .gap_3()
            .px(px(10.0))
            .py_2()
            .when(!first, |v| v.border_t_1().border_t_color(colors::LINE))
            .child(IconTile::new(icon_name).size(34.0))
            .child(
                view()
                    .flex_1()
                    .gap(px(2.0))
                    .child(
                        text(title)
                            .text_size(px(15.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(colors::TEXT),
                    )
                    .child(
                        text(note)
                            .number_of_lines(1)
                            .text_size(px(12.0))
                            .text_color(colors::FAINT)
                            .font_family(MONO),
                    ),
            )
            .child(
                icon()
                    .name(IconName::Chevron)
                    .size(14.0)
                    .tint(colors::FAINT),
            ),
    )
}

/// How dragging the form treats the keyboard: its segment and its name.
const MODES: [(KeyboardDismissMode, &str, &str); 3] = [
    (KeyboardDismissMode::None, "None", "none"),
    (KeyboardDismissMode::OnDrag, "On drag", "on-drag"),
    (
        KeyboardDismissMode::Interactive,
        "Interactive",
        "interactive",
    ),
];

/// How many inputs return moves through.
const CHAIN: usize = 15;

/// The form's fields, by their [`FieldFx`].
mod f {
    pub(super) const NAME: usize = 0;
    pub(super) const EMAIL: usize = 1;
    pub(super) const PASSWORD: usize = 2;
    pub(super) const PHONE: usize = 3;
    pub(super) const WEBSITE: usize = 4;
    pub(super) const AGE: usize = 5;
    pub(super) const AMOUNT: usize = 6;
    pub(super) const OFFSET: usize = 7;
    pub(super) const CODE: usize = 8;
    pub(super) const STREET: usize = 9;
    pub(super) const CITY: usize = 10;
    pub(super) const POSTAL: usize = 11;
    pub(super) const COUNTRY: usize = 12;
    pub(super) const SHOUT: usize = 13;
    pub(super) const READ_ONLY: usize = 14;
    pub(super) const COLORS: usize = 15;
    pub(super) const NOTES: usize = 16;
    pub(super) const CARET: usize = 17;
    /// The sheet's seven fields follow.
    pub(super) const SHEET: usize = 18;
    pub(super) const COUNT: usize = SHEET + 7;
}

/// The sheet's fields.
const SHEET_FIELDS: [&str; 7] = [
    "First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh",
];

/// `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`.
fn is_email(s: &str) -> bool {
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    let plain = |part: &str| {
        !part.is_empty() && !part.contains(['@']) && !part.contains(char::is_whitespace)
    };
    plain(local)
        && plain(domain)
        && domain
            .char_indices()
            .any(|(i, c)| c == '.' && i > 0 && i + 1 < domain.len())
}

/// 0–4: length, mixed case, a digit, a symbol.
fn strength(p: &str) -> usize {
    if p.is_empty() {
        return 0;
    }
    [
        p.encode_utf16().count() >= 8,
        p.chars().any(|c| c.is_ascii_lowercase()) && p.chars().any(|c| c.is_ascii_uppercase()),
        p.chars().any(|c| c.is_ascii_digit()),
        p.chars()
            .any(|c| !(c.is_ascii_alphanumeric() || c == '_' || c.is_whitespace())),
    ]
    .into_iter()
    .filter(|&b| b)
    .count()
}

const STRENGTH_LABEL: [&str; 5] = ["Empty", "Weak", "Fair", "Good", "Strong"];
const STRENGTH_TONE: [Tone; 5] = [
    Tone::Neutral,
    Tone::Danger,
    Tone::Warn,
    Tone::Info,
    Tone::Up,
];

/// The fields that were left (or submitted): only those show errors.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Touched {
    name: bool,
    email: bool,
    password: bool,
}

/// The name's error, once it was left.
fn name_error(touched: Touched, name: &str) -> Option<&'static str> {
    (touched.name && name.trim().is_empty()).then_some("Enter your name")
}

/// The e-mail's error, once it was left.
fn email_error(touched: Touched, email: &str) -> Option<&'static str> {
    (touched.email && !is_email(email)).then_some(if email.is_empty() {
        "Enter your e-mail"
    } else {
        "That address needs an @ and a domain"
    })
}

/// The password's error, once it was left.
fn password_error(touched: Touched, password: &str) -> Option<&'static str> {
    (touched.password && password.encode_utf16().count() < 8).then_some("Use at least 8 characters")
}

/// The demo's page: the form's cards in a scroll view whose keyboard
/// dismiss mode the page picks, and its sheet of inputs.
#[component]
pub(crate) fn Form() -> impl IntoElement {
    let name = signal(String::new());
    let email = signal(String::new());
    let password = signal(String::new());
    let code = signal(String::new());
    let shout = signal(String::new());
    let notes = signal(String::new());
    // How dragging the scroll view treats the keyboard, an index into
    // MODES: on drag.
    let mode = signal(1_usize);
    // What submitting found: up (sent) or danger, and what it says.
    let status = signal(None::<(Tone, String)>);
    let sheet = signal(false);
    let touched = signal(Touched::default());
    // The inputs in return-key order.
    let refs: [ElementRef; CHAIN] = std::array::from_fn(|_| element_ref());
    let fx: [FieldFx; f::COUNT] = std::array::from_fn(|_| FieldFx::new());
    let name_err = computed(move || name.with(|n| name_error(touched.get(), n)));
    let email_err = computed(move || email.with(|e| email_error(touched.get(), e)));
    let password_err = computed(move || password.with(|p| password_error(touched.get(), p)));
    let touch = move |f: fn(&mut Touched)| move || touched.update(f);

    // Input `i` of the return-key order: return focuses the next one.
    let chained = move |i: usize, input: Input| {
        let input = input.element_ref(&refs[i]);
        if i + 1 == CHAIN {
            return input;
        }
        input
            .return_key_type(ReturnKeyType::Next)
            .on_submit(move |_: &str| {
                if let Some(next) = refs.get(i + 1) {
                    next.focus();
                }
            })
    };
    let set = |text: Signal<String>| move |v: &str| text.set(v.to_owned());

    let keyboard = move || {
        Card::new()
            .icon(IconName::Form)
            .title("Keyboard")
            .subtitle("keyboardDismissMode while dragging")
            .right(
                Badge::new(move || format!("{} pt", keyboard_height().0.round())).tone(move || {
                    if keyboard_height() > px(0.0) {
                        Tone::Accent
                    } else {
                        Tone::Neutral
                    }
                }),
            )
            .child(
                segmented()
                    .options(MODES.map(|m| Segment::new(m.1)))
                    .selected(move || mode.get() as u32)
                    .on_change(move |&i: &u32| {
                        mode.set(i as usize);
                    }),
            )
            .child(caption(
                hint(
                    "Drag the form with the keyboard up",
                    "Desktops have no on-screen keyboard to dismiss",
                ),
                Some(move || MODES[mode.get()].2),
            ))
    };

    let score = computed(move || password.with(|p| strength(p)));
    let account = move || {
        Section::new("Account")
            .note("autoComplete")
            .child(
                field(&fx[f::NAME], "Name")
                    .error(name_err)
                    .on_blur(touch(|t| t.name = true))
                    .render(|i| {
                        chained(0, i)
                            .value(move || name.get())
                            .on_change(set(name))
                            .auto_capitalize(AutoCapitalize::Words)
                            .auto_fill(AutoFill::Name)
                            .placeholder("Ada Lovelace")
                    }),
            )
            .child(
                field(&fx[f::EMAIL], "E-mail")
                    .api("email-address")
                    .error(email_err)
                    .on_blur(touch(|t| t.email = true))
                    .render(|i| {
                        chained(1, i)
                            .value(move || email.get())
                            .on_change(set(email))
                            .keyboard_type(KeyboardType::Email)
                            .auto_capitalize(AutoCapitalize::None)
                            .auto_correct(false)
                            .auto_fill(AutoFill::Email)
                            .placeholder("ada@example.com")
                    }),
            )
            .child(
                view()
                    .gap_2()
                    .child(
                        field(&fx[f::PASSWORD], "Password")
                            .api("masked")
                            .error(password_err)
                            .on_blur(touch(|t| t.password = true))
                            .render(|i| {
                                chained(2, i)
                                    .value(move || password.get())
                                    .on_change(move |v: &str| {
                                        if strength(v) != score.get_untracked() {
                                            animate_layout(LayoutAnimation::EASE_IN_EASE_OUT);
                                        }
                                        password.set(v.to_owned());
                                    })
                                    .masked(true)
                                    .auto_fill(AutoFill::NewPassword)
                                    .placeholder("At least 8 characters")
                            }),
                    )
                    .child(
                        view()
                            .flex_row()
                            .items_center()
                            .gap(px(10.0))
                            .child(
                                view().flex_1().child(
                                    Meter::new(move || score.get() as f32 / 4.0)
                                        .tone(move || STRENGTH_TONE[score.get()]),
                                ),
                            )
                            .child(
                                text(move || STRENGTH_LABEL[score.get()])
                                    .w(px(52.0))
                                    .text_right()
                                    .text_size(px(13.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(move || {
                                        let score = score.get();
                                        if score > 0 {
                                            STRENGTH_TONE[score].color()
                                        } else {
                                            colors::FAINT
                                        }
                                    }),
                            ),
                    ),
            )
            .child(field(&fx[f::PHONE], "Phone").api("phone-pad").render(|i| {
                chained(3, i)
                    .keyboard_type(KeyboardType::Phone)
                    .auto_fill(AutoFill::Tel)
                    .placeholder("+1 555 0100")
            }))
            .child(field(&fx[f::WEBSITE], "Website").api("url").render(|i| {
                chained(4, i)
                    .keyboard_type(KeyboardType::Url)
                    .auto_capitalize(AutoCapitalize::None)
                    .auto_correct(false)
                    .placeholder("https://")
            }))
    };

    let numbers = move || {
        Section::new("Numbers")
            .note("keyboardType")
            .child(pair(
                field(&fx[f::AGE], "Age").hint("3 digits").render(|i| {
                    chained(5, i)
                        .keyboard_type(KeyboardType::Number)
                        .max_length(3)
                        .placeholder("36")
                }),
                field(&fx[f::AMOUNT], "Amount")
                    .api("decimal-pad")
                    .prefix("$")
                    .render(|i| {
                        chained(6, i)
                            .keyboard_type(KeyboardType::Decimal)
                            .placeholder("0.00")
                    }),
            ))
            .child(
                field(&fx[f::OFFSET], "Offset")
                    .api("numbers-and-punctuation")
                    .hint("dark keyboard (iOS)")
                    .render(|i| {
                        i.keyboard_type(KeyboardType::NumbersAndPunctuation)
                            .keyboard_appearance(KeyboardAppearance::Dark)
                            .placeholder("-12.5")
                    }),
            )
            .child(
                field(&fx[f::CODE], "Verification code")
                    .hint(move || format!("{}/6", code.with(|c| c.encode_utf16().count())))
                    .render(|i| {
                        chained(7, i)
                            .value(move || code.get())
                            .on_change(set(code))
                            .keyboard_type(KeyboardType::Number)
                            .max_length(6)
                            .placeholder("······")
                            .letter_spacing(px(10.0))
                            .text_size(px(22.0))
                            .font_weight(FontWeight::MEDIUM)
                            .tabular_nums()
                            .text_center()
                    }),
            )
    };

    let address = move || {
        Section::new("Shipping address")
            .note("scrolls into view")
            .child(field(&fx[f::STREET], "Street").render(|i| {
                chained(8, i)
                    .auto_fill(AutoFill::StreetAddress)
                    .placeholder("12 Analytical Way")
            }))
            .child(pair(
                field(&fx[f::CITY], "City").render(|i| chained(9, i).placeholder("London")),
                field(&fx[f::POSTAL], "Postal code").render(|i| {
                    chained(10, i)
                        .auto_capitalize(AutoCapitalize::Characters)
                        .auto_fill(AutoFill::PostalCode)
                        .placeholder("SW1A 1AA")
                }),
            ))
            .child(
                field(&fx[f::COUNTRY], "Country")
                    .render(|i| chained(11, i).placeholder("United Kingdom")),
            )
    };

    let note_count = computed(move || notes.with(|n| n.encode_utf16().count()));
    let texts = move || {
        Section::new("Text")
            .note("Input props")
            .child(
                field(&fx[f::SHOUT], "Controlled")
                    .hint("Uppercased as you type")
                    .render(|i| {
                        chained(12, i)
                            .value(move || shout.get())
                            .on_change(move |t: &str| shout.set(t.to_uppercase()))
                            .placeholder("TYPE IN LOWER CASE")
                    }),
            )
            .child(
                field(&fx[f::READ_ONLY], "Read only")
                    .api("readonly")
                    .read_only()
                    .render(|i| i.value("Not editable")),
            )
            .child(
                field(&fx[f::COLORS], "Custom colors")
                    .api("selectionColor")
                    .render(|i| {
                        chained(13, i)
                            .placeholder("A blue placeholder, an amber selection")
                            .placeholder_color(|| color(colors::INFO))
                            .selection_color(|| color(colors::WARN))
                    }),
            )
            .child(
                view()
                    .gap_2()
                    .child(
                        field(&fx[f::NOTES], "Notes")
                            .hint(move || format!("{}/280", note_count.get()))
                            .multiline()
                            .render(|i| {
                                chained(14, i)
                                    .max_length(280)
                                    .value(move || notes.get())
                                    .on_change(set(notes))
                                    .placeholder("Return adds a line")
                                    .min_h(px(100.0))
                            }),
                    )
                    .child(
                        Meter::new(move || note_count.get() as f32 / 280.0).tone(move || {
                            if note_count.get() > 250 {
                                Tone::Warn
                            } else {
                                Tone::Accent
                            }
                        }),
                    ),
            )
            .child(auto_grow())
            .child(
                field(&fx[f::CARET], "No caret")
                    .api("caret")
                    .render(|i| i.caret(false).default_value("No caret here")),
            )
    };

    let submit = move |_: &()| {
        touched.set(Touched {
            name: true,
            email: true,
            password: true,
        });
        let all = touched.get_untracked();
        let (name, email) = (name.get_untracked(), email.get_untracked());
        let issues = [
            name_error(all, &name),
            email_error(all, &email),
            password.with_untracked(|p| password_error(all, p)),
        ]
        .iter()
        .flatten()
        .count();
        animate_layout(LayoutAnimation::EASE_IN_EASE_OUT);
        status.set(Some(if issues > 0 {
            (
                Tone::Danger,
                format!(
                    "{issues} {} attention",
                    if issues == 1 {
                        "field needs"
                    } else {
                        "fields need"
                    }
                ),
            )
        } else {
            (Tone::Up, format!("Account created for {name} <{email}>"))
        }));
    };
    let submit_card = move || {
        Card::new()
            .icon(IconName::Check)
            .title("Create the account")
            .subtitle("Submitting checks every field")
            .right(dynamic(move || {
                status.with(|s| {
                    s.as_ref().map(|&(tone, _)| {
                        Badge::new(if tone == Tone::Up { "Sent" } else { "Check" }).tone(tone)
                    })
                })
            }))
            .child(dynamic(move || {
                status.with(|s| {
                    s.as_ref().map(|(tone, message)| {
                        let up = *tone == Tone::Up;
                        let fg = if up { colors::UP } else { colors::DANGER };
                        view()
                            .flex_row()
                            .items_center()
                            .gap_2()
                            .p_3()
                            .rounded(px(radius::CONTROL))
                            .bg(if up { tints::UP } else { tints::DANGER })
                            .child(
                                icon()
                                    .name(if up { IconName::Check } else { IconName::Bell })
                                    .size(16.0)
                                    .tint(fg),
                            )
                            .child(
                                text(message.clone())
                                    .flex_1()
                                    .text_size(px(14.0))
                                    .line_height(px(19.0))
                                    .text_color(fg),
                            )
                    })
                })
            }))
            .child(pair(
                Button::new("Submit", submit),
                Button::new("Hide keyboard", |_: &()| dismiss_keyboard())
                    .variant(ButtonVariant::Secondary),
            ))
    };

    let more = move || {
        Card::new()
            .title("More keyboards")
            .subtitle("Sheets and bars that ride on the keyboard")
            .flush()
            .child(
                Inset::new()
                    .padding(0.0)
                    .gap(0.0)
                    .child(link_row(
                        IconName::Components,
                        "Inputs in a sheet",
                        "presentationStyle=\"pageSheet\"",
                        true,
                        move |_: &()| sheet.set(true),
                    ))
                    .child(link_row(
                        IconName::Text,
                        "A message bar at the bottom",
                        "env(keyboard-inset-height)",
                        false,
                        |_: &()| {
                            nav::push("message-bar", || titled("Message bar").child(message_bar()));
                        },
                    )),
            )
    };

    DemoPage::new()
        .keyboard_dismiss_mode(move || MODES[mode.get()].0)
        .card(keyboard)
        .card(account)
        .card(numbers)
        .card(address)
        .card(|| {
            Section::new("Selection and keys")
                .note("onSelectionChange")
                .child(selection_demo())
        })
        .card(texts)
        .card(submit_card)
        .card(more)
        .child(when(sheet, move || sheet_view(sheet, &fx[f::SHEET..])))
}

/// The sheet of inputs (`open` while it shows), its fields animated by
/// `fx`.
fn sheet_view(open: Signal<bool>, fx: &[FieldFx]) -> Modal {
    let close = move |_: &()| open.set(false);
    let fields = SHEET_FIELDS
        .iter()
        .zip(fx)
        .map(|(label, fx)| field(fx, *label).render(|i| i.placeholder(format!("{label} field"))));
    dialog()
        .presentation(ModalPresentation::PageSheet)
        .on_cancel(close)
        .child(
            view().p_safe_area().flex_1().bg(colors::BACKGROUND).child(
                scroll()
                    .flex_1()
                    .keyboard_dismiss_mode(KeyboardDismissMode::Interactive)
                    .child(
                        view()
                            .p_4()
                            .pb(px(40.0))
                            .gap_4()
                            .child(
                                view()
                                    .flex_row()
                                    .items_center()
                                    .gap_3()
                                    .pt_2()
                                    .pl_1()
                                    .child(
                                        view()
                                            .flex_1()
                                            .gap(px(2.0))
                                            .child(
                                                text("A sheet")
                                                    .text_size(px(24.0))
                                                    .font_weight(FontWeight::BOLD)
                                                    .letter_spacing(px(-0.4))
                                                    .text_color(colors::TEXT),
                                            )
                                            .child(
                                                text("Its inputs stay above the keyboard too")
                                                    .text_size(px(13.0))
                                                    .text_color(colors::MUTED),
                                            ),
                                    )
                                    .child(
                                        Button::new("Done", close)
                                            .variant(ButtonVariant::Secondary),
                                    ),
                            )
                            .child(Inset::new().children(fields)),
                    ),
            ),
        )
}

/// A multiline input that grows with its text (`on_content_size_change`),
/// up to 5 lines.
#[component]
fn AutoGrow() -> impl IntoElement {
    let height = signal(0.0_f32);
    let size = signal("–".to_owned());
    field(&FieldFx::new(), "Grows with its text")
        .hint(move || size.get())
        .multiline()
        .render(|i| {
            i.placeholder("Type several lines")
                .on_content_size_change(move |e: &Size<Points>| {
                    size.set(format!("{}×{}", e.width.0.round(), e.height.0.round()));
                    height.set(e.height.min(px(110.0)).0);
                })
                .h(move || px(height.get().max(20.0) + 26.0))
        })
}

/// `start..end` of `text` in UTF-16 units (as inputs count).
fn utf16_slice(text: &str, start: u32, end: u32) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let end = (end as usize).min(units.len());
    let start = (start as usize).min(end);
    String::from_utf16_lossy(&units[start..end])
}

/// The selection and the keys of an input, and selecting from code: the
/// controlled selection ("Select all") and the ref's `set_selection`.
#[component]
fn SelectionDemo() -> impl IntoElement {
    let content = signal("Select part of this text".to_owned());
    let range = signal(Selection::default());
    // The selection "Select all" asks for (TS: the `selection` prop's
    // signal): set on the input when it changes.
    let selection = signal(None::<Selection>);
    // The last keys pressed.
    let keys = signal(Vec::<String>::new());
    let input = element_ref();
    let fx = [FieldFx::new(), FieldFx::new()];
    effect(move || {
        if let Some(s) = selection.get() {
            input.set_selection(s.start, s.end);
        }
    });
    let keys_view = view()
        .flex_row()
        .flex_wrap()
        .items_center()
        .gap(px(6.0))
        .min_h(px(28.0))
        .child(when(
            move || keys.with(Vec::is_empty),
            || {
                text("Keys you press show here")
                    .text_size(px(13.0))
                    .text_color(colors::FAINT)
            },
        ))
        .child(each(
            move || keys.with(|k| k.iter().cloned().enumerate().collect::<Vec<_>>()),
            |(i, _): &(usize, String)| *i,
            |key, _| {
                view()
                    .min_w(px(28.0))
                    .h(px(28.0))
                    .px_2()
                    .rounded(px(7.0))
                    .items_center()
                    .justify_center()
                    .bg(colors::RAISED)
                    .border_1()
                    .border_color(colors::BORDER)
                    .finish(Finish::Raised)
                    .child(
                        text(move || {
                            key.with(|(_, key)| {
                                if key == " " {
                                    "␣".to_owned()
                                } else {
                                    key.clone()
                                }
                            })
                        })
                        .text_size(px(13.0))
                        .text_color(colors::TEXT),
                    )
            },
        ));
    view()
        .gap_3()
        .child(
            field(&fx[0], "Text")
                .hint(move || {
                    let Selection { start, end } = range.get();
                    format!("{start}–{end}")
                })
                .render(|i| {
                    i.element_ref(&input)
                        .value(move || content.get())
                        .on_change(move |v: &str| content.set(v.to_owned()))
                        .on_selection_change(move |s: &Selection| {
                            range.set(*s);
                            // The input has it: "Select all" sets it again.
                            selection.set(None);
                        })
                        .on_key_press(move |key: &str| {
                            keys.update(|keys| {
                                keys.push(key.to_owned());
                                let extra = keys.len().saturating_sub(8);
                                keys.drain(..extra);
                            });
                        })
                        .auto_fill(AutoFill::Off)
                }),
        )
        .child(caption(
            "Selected",
            Some(move || {
                let Selection { start, end } = range.get();
                content.with(|t| format!("\"{}\"", utf16_slice(t, start, end)))
            }),
        ))
        .child(keys_view)
        .child(pair(
            Button::new("Select all", move |_: &()| {
                let end = content.with_untracked(|t| t.encode_utf16().count() as u32);
                selection.set(Some(Selection { start: 0, end }));
            }),
            Button::new("Caret to start", move |_: &()| {
                input.set_selection(0, 0);
            })
            .variant(ButtonVariant::Secondary),
        ))
        .child(
            field(&fx[1], "One-time code")
                .api("one-time-code")
                .render(|i| {
                    i.keyboard_type(KeyboardType::Number)
                        .auto_fill(AutoFill::OneTimeCode)
                        .max_length(6)
                        .placeholder("123456")
                }),
        )
}

/// A message of the message bar's page: mine, and what it says.
type Message = (bool, String);

/// An input pinned to the bottom (outside any scroll view): it rides on the
/// keyboard.
#[component]
fn MessageBar(cx: Scope<NoEvent>) -> impl IntoElement {
    let messages = signal::<Vec<Message>>(vec![
        (
            false,
            "The bar below sits outside the scroll view.".to_owned(),
        ),
        (
            false,
            "Its bottom padding, env(keyboard-inset-height), lifts it with the keyboard. Say something.".to_owned(),
        ),
    ]);
    let draft = signal(String::new());
    let send = move || {
        if draft.with_untracked(|d| d.trim().is_empty()) {
            return;
        }
        let text = draft.get_untracked();
        batch(|| {
            messages.update(|m| m.push((true, text)));
            draft.set(String::new());
        });
    };
    // Messages are only added: a bubble is known by its place.
    let bubbles = each(
        move || messages.with(|m| m.iter().cloned().enumerate().collect::<Vec<_>>()),
        |(i, _): &(usize, Message)| *i,
        |m, _| {
            let mine = m.with_untracked(|(_, (mine, _))| *mine);
            appear().index(0).child(
                view()
                    .map(|v| if mine { v.self_end() } else { v.self_start() })
                    .max_w(relative(0.8))
                    .px(px(14.0))
                    .py(px(10.0))
                    .rounded(px(18.0))
                    .border_curve(BorderCurve::Continuous)
                    .rounded_br(px(if mine { 6.0 } else { 18.0 }))
                    .rounded_bl(px(if mine { 18.0 } else { 6.0 }))
                    .map(|v| {
                        if mine {
                            v.bg(colors::ACCENT_FILL).finish(Finish::Accent)
                        } else {
                            v.bg(colors::RAISED).finish(Finish::Raised)
                        }
                    })
                    .child(
                        text(move || m.with(|(_, (_, text))| text.clone()))
                            .text_size(px(15.0))
                            .line_height(px(20.0))
                            .text_color(if mine {
                                colors::ON_ACCENT
                            } else {
                                colors::TEXT
                            }),
                    ),
            )
        },
    );
    view().flex_1().child(
        view()
            .pb_keyboard()
            .flex_1()
            .bg(colors::BACKGROUND)
            .child(
                scroll()
                    .flex_1()
                    .keyboard_dismiss_mode(KeyboardDismissMode::Interactive)
                    .child(
                        view()
                            .p_4()
                            .gap_2()
                            .child(
                                text("Today")
                                    .self_center()
                                    .text_size(px(12.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(colors::FAINT)
                                    .pb_2(),
                            )
                            .child(bubbles),
                    ),
            )
            .child(
                view()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .px_4()
                    .pt_2()
                    // Above the home indicator, unless the keyboard covers
                    // it.
                    .pb(move || {
                        px(8.0
                            + if keyboard_height() > px(0.0) {
                                0.0
                            } else {
                                cx.insets().bottom.0
                            })
                    })
                    .bg(colors::SURFACE)
                    .border_t_1()
                    .border_t_color(colors::BORDER)
                    .child(
                        input()
                            .value(move || draft.get())
                            .on_change(move |v: &str| draft.set(v.to_owned()))
                            .on_submit(move |_: &str| send())
                            .submit_behavior(SubmitBehavior::Submit)
                            .placeholder("Message")
                            .placeholder_color(|| color(colors::FAINT))
                            .selection_color(|| color(colors::ACCENT))
                            .return_key_type(ReturnKeyType::Send)
                            .flex_1()
                            .h(px(44.0))
                            .px_4()
                            .text_size(px(15.0))
                            .text_color(colors::TEXT)
                            .bg(colors::INSET)
                            .border_1()
                            .border_color(colors::BORDER)
                            .rounded(px(22.0))
                            .finish(Finish::Inset),
                    )
                    .child(RoundButton::new(
                        IconName::ArrowUp,
                        "Send",
                        move |_: &()| send(),
                    )),
            ),
    )
}
