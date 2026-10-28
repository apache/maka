//! Encodes a [`MountBatch`] for `Mounter.java`: a little-endian stream of
//! 32-bit ints and floats, plus an object table for strings and text
//! layouts. One JNI call per commit, no per-item crossings.
//!
//! Animation items (graph ops, bindings, drag and scroll values) are not
//! encoded: they go to the UI-thread animator ([`crate::animation`]).
//!
//! The opcodes must match `Mounter.java`.
//!
//! The Android data flow: the engine thread typesets with `StaticLayout`
//! through cached JNI method ids (`java.rs`; classes are cached in
//! `JNI_OnLoad`, as native threads only see the system class loader). Each
//! commit is encoded here into one `byte[]` plus the object table and handed
//! to `NshView.submit` → `Mounter.java` on the UI thread. Java calls
//! `Native.afterBatch(seq)` after applying a batch and `Native.tick` on
//! `Choreographer` frames; both return `[animating, (view, prop, value)*]`
//! float arrays. Units cross as dp; Java converts to px.

use jni::objects::GlobalRef;
use nsh_core::{
    AccessibilityRole, AudioSession, AutoCapitalize, AutoFill, BorderStyle, Checked, Color,
    Command, DialogButtonStyle, InputConfig, KeyboardDismissMode, KeyboardTaps, KeyboardType,
    LayoutCurve, LayoutProperty, LayoutTransition, LiveRegion, ModalAnimation, ModalPresentation,
    MountBatch, MountItem, NativeProps, PointerEvents, ResizeMode, ReturnKeyType, ScreenAnimation,
    ScreenConfig, SnapAlignment, StatusBarStyle, SubmitBehavior, TextAlign, ViewKind, ViewProps,
    ViewStyle, WebSource,
    geometry::{DefiniteLength, REM_SIZE},
};

use crate::{
    animation::view_transform,
    text::{AndroidLayout, argb},
};

const CREATE: i32 = 0;
const INSERT: i32 = 1;
const REMOVE: i32 = 2;
const DELETE: i32 = 3;
const FRAME: i32 = 4;
const VIEW_STYLE: i32 = 5;
const TEXT: i32 = 6;
const EVENTS: i32 = 7;
const IMAGE: i32 = 8;
const SCROLL_CONFIG: i32 = 9;
const SCROLL_CONTENT: i32 = 10;
const SCROLL_BY: i32 = 11;
const REFRESHING: i32 = 12;
const DYNAMIC: i32 = 13;
const GESTURES: i32 = 14;
const INPUT: i32 = 15;
const INPUT_VALUE: i32 = 16;
const INPUT_CONTENT: i32 = 17;
const COMMAND: i32 = 18;
const VIEW_PROPS: i32 = 19;
const LAYOUT_ANIMATION: i32 = 20;
const SCREEN_CONFIG: i32 = 21;
const MODAL_CONFIG: i32 = 22;
const NATIVE_PROPS: i32 = 23;
const STICKY_CELLS: i32 = 24;
const SCROLL_BEHAVIOR: i32 = 25;
const LAYOUT_DIRECTION: i32 = 26;
const TRACK_STATES: i32 = 27;
const CANVAS: i32 = 28;
const COMPONENT: i32 = 29;
const COMPONENT_PROPS: i32 = 30;
const OVERFLOW: i32 = 31;
const ACCESSIBILITY_LABEL: i32 = 32;
const APPEARANCE: i32 = 33;
const RETIRE_LIST_CELL: i32 = 34;
const PROJECT_ROOT: i32 = 35;
const COMPONENT_PROP_SLOTS: i32 = 36;
const SHADER: i32 = 37;

/// An entry of the object table.
pub(crate) enum Obj {
    Str(String),
    Layout(GlobalRef),
}

/// An encoded batch.
#[derive(Default)]
pub(crate) struct Encoded {
    pub(crate) bytes: Vec<u8>,
    pub(crate) objects: Vec<Obj>,
    /// Items for the UI-thread animator, in order.
    pub(crate) animation: Vec<MountItem>,
    /// The app's keyboard shortcuts, when the batch changed them: matched
    /// natively (`crate::keymap`), never sent to Java.
    pub(crate) keymap: Option<std::sync::Arc<nsh_core::keymap::Keymap>>,
}

impl Encoded {
    #[inline]
    fn int(&mut self, v: i32) {
        self.bytes.extend_from_slice(&v.to_le_bytes());
    }

    #[inline]
    fn float(&mut self, v: f32) {
        self.bytes.extend_from_slice(&v.to_le_bytes());
    }

    #[inline]
    fn bool(&mut self, v: bool) {
        self.int(v as i32);
    }

    fn string(&mut self, s: String) {
        let index = self.objects.len() as i32;
        self.objects.push(Obj::Str(s));
        self.int(index);
    }

    /// An optional string: its object index, or -1.
    fn opt_string(&mut self, s: Option<&str>) {
        match s {
            Some(s) => self.string(s.to_owned()),
            None => self.int(-1),
        }
    }
}

pub(crate) fn encode(batch: MountBatch) -> Encoded {
    let mut e = Encoded {
        bytes: Vec::with_capacity(batch.items.len() * 16),
        ..Encoded::default()
    };
    for item in batch.items {
        match item {
            MountItem::Create { id, kind } => {
                e.int(CREATE);
                e.int(id as i32);
                e.int(match kind {
                    ViewKind::View => 0,
                    ViewKind::Text => 1,
                    ViewKind::Image => 2,
                    ViewKind::Scroll => 3,
                    ViewKind::Input => 4,
                    ViewKind::Stack => 5,
                    ViewKind::Screen => 6,
                    ViewKind::Modal => 7,
                    ViewKind::HeaderItem => 8,
                    ViewKind::WebView => 12,
                    ViewKind::Video => 13,
                    // The runtime renders no input accessories on Android
                    // (as React Native).
                    ViewKind::InputAccessory => 0,
                    ViewKind::Canvas => 14,
                    ViewKind::Native => 15,
                });
            }
            MountItem::Insert {
                parent,
                child,
                before,
            } => {
                e.int(INSERT);
                e.int(parent as i32);
                e.int(child as i32);
                e.int(before.map_or(-1, |b| b as i32));
            }
            MountItem::ProjectRoot {
                parent,
                id,
                following,
            } => {
                e.int(PROJECT_ROOT);
                e.int(parent as i32);
                e.int(id as i32);
                e.int(following.len() as i32);
                for sibling in following {
                    e.int(sibling as i32);
                }
            }
            MountItem::Remove { id } => {
                e.int(REMOVE);
                e.int(id as i32);
            }
            MountItem::RetireListCell { id, request, roots } => {
                e.int(RETIRE_LIST_CELL);
                e.int(id as i32);
                e.bytes.extend_from_slice(&request.to_le_bytes());
                e.int(roots.len() as i32);
                for root in roots {
                    e.int(root as i32);
                }
            }
            MountItem::ListCellRetired { .. } => {}
            MountItem::Delete { id } => {
                e.int(DELETE);
                e.int(id as i32);
                // The animator forgets the view too.
                e.animation.push(MountItem::Delete { id });
            }
            MountItem::Frame { id, frame } => {
                e.int(FRAME);
                e.int(id as i32);
                for v in [
                    frame.origin.x.0,
                    frame.origin.y.0,
                    frame.size.width.0,
                    frame.size.height.0,
                ] {
                    e.float(v);
                }
            }
            MountItem::ViewStyle { id, style } => {
                e.int(VIEW_STYLE);
                e.int(id as i32);
                view_style(&mut e, &style);
                // The animator composes animated values with the static ones.
                e.animation.push(MountItem::ViewStyle { id, style });
            }
            MountItem::Text {
                id,
                layout,
                content,
                text,
            } => {
                let Some(AndroidLayout(layout)) = layout.downcast::<AndroidLayout>() else {
                    continue;
                };
                e.int(TEXT);
                e.int(id as i32);
                e.int(e.objects.len() as i32);
                e.objects.push(Obj::Layout(layout.clone()));
                for v in [
                    content.origin.x.0,
                    content.origin.y.0,
                    content.size.width.0,
                    content.size.height.0,
                ] {
                    e.float(v);
                }
                // Pressable spans: start, end, node, events (four ints,
                // lowest first).
                e.int(text.links.len() as i32);
                for l in &text.links {
                    e.int(l.start as i32);
                    e.int(l.end as i32);
                    e.int(l.node as i32);
                    mask(&mut e, l.events);
                }
                // `selectable`: 1 asked for, 0 refused (`false`: out of
                // selectable views too), 2 unset.
                e.int(match text.selectable {
                    Some(true) => 1,
                    Some(false) => 0,
                    None => 2,
                });
                opt_color(&mut e, text.selection_color);
            }
            MountItem::Events { id, events } => {
                e.int(EVENTS);
                e.int(id as i32);
                mask(&mut e, events);
            }
            MountItem::Image {
                id,
                source,
                resize_mode,
                options,
            } => {
                e.int(IMAGE);
                e.int(id as i32);
                match source {
                    Some(source) => e.string(source.uri.to_string()),
                    None => e.int(-1),
                }
                e.int(match resize_mode {
                    ResizeMode::Cover => 0,
                    ResizeMode::Contain => 1,
                    ResizeMode::Stretch => 2,
                    ResizeMode::Center => 3,
                    ResizeMode::ScaleDown => 4,
                });
                e.opt_string(options.placeholder.as_ref().map(|p| &*p.uri));
                e.float(options.blur_radius.0);
                e.float(options.fade_ms.unwrap_or(-1.0));
                // `objectPosition`, per axis: flags (1 from the end edge,
                // 2 a fraction of the free space) and the value (points or
                // the fraction).
                for axis in [options.position.x, options.position.y] {
                    let (fraction, value) = match axis.offset {
                        DefiniteLength::Absolute(p) => (0, p.to_points(REM_SIZE).0),
                        DefiniteLength::Fraction(f) => (2, f.0),
                    };
                    e.int(i32::from(axis.from_end) | fraction);
                    e.float(value);
                }
            }
            MountItem::ScrollConfig {
                id,
                horizontal,
                scrollbar_visible,
                scroll_value,
                pull_value,
                keyboard_dismiss,
                mirrored,
            } => {
                e.int(SCROLL_CONFIG);
                e.int(id as i32);
                e.bool(horizontal);
                e.bool(scrollbar_visible);
                e.int(match keyboard_dismiss {
                    KeyboardDismissMode::None => 0,
                    KeyboardDismissMode::OnDrag => 1,
                    KeyboardDismissMode::Interactive => 2,
                });
                e.bool(mirrored);
                e.animation.push(MountItem::ScrollConfig {
                    id,
                    horizontal,
                    scrollbar_visible,
                    scroll_value,
                    pull_value,
                    keyboard_dismiss,
                    mirrored,
                });
            }
            MountItem::ScrollContent { id, size } => {
                e.int(SCROLL_CONTENT);
                e.int(id as i32);
                e.float(size.width.0);
                e.float(size.height.0);
            }
            MountItem::StickyCells { id, cells } => {
                e.int(STICKY_CELLS);
                e.int(id as i32);
                e.int(cells.len() as i32);
                for c in &cells {
                    e.int(c.cell as i32);
                    e.float(c.start.0);
                    e.float(c.end.0);
                }
                // Animated offsets are the UI thread's graph's (`animation.rs`).
                e.animation.push(MountItem::StickyCells { id, cells });
            }
            MountItem::LayoutDirection { rtl } => {
                e.int(LAYOUT_DIRECTION);
                e.bool(rtl);
            }
            MountItem::Keymap(keymap) => e.keymap = Some(keymap),
            MountItem::Appearance { appearance } => {
                e.int(APPEARANCE);
                e.int(appearance as i32);
            }
            MountItem::Canvas { id, drawing } => {
                e.int(CANVAS);
                e.int(id as i32);
                canvas(&mut e, &drawing);
            }
            MountItem::Shader { id, layer } => {
                // Java learns only whether the view shows a shader; the
                // layer goes to the UI-thread renderer (`crate::shader`).
                e.int(SHADER);
                e.int(id as i32);
                e.bool(layer.is_some());
                e.animation.push(MountItem::Shader { id, layer });
            }
            MountItem::Overflow { id, extent } => {
                e.int(OVERFLOW);
                e.int(id as i32);
                e.bool(extent.is_some());
                let r = extent.unwrap_or_default();
                e.float(r.origin.x.0);
                e.float(r.origin.y.0);
                e.float(r.size.width.0);
                e.float(r.size.height.0);
            }
            MountItem::TrackStates { id, states } => {
                e.int(TRACK_STATES);
                e.int(id as i32);
                e.int(states as i32);
            }
            MountItem::ScrollBehavior { id, behavior } => {
                let b = &*behavior;
                e.int(SCROLL_BEHAVIOR);
                e.int(id as i32);
                e.bool(b.paging);
                e.float(b.snap_interval.0);
                e.int(b.snap_offsets.len() as i32);
                for &o in &b.snap_offsets {
                    e.float(o.0);
                }
                e.int(match b.snap_alignment {
                    SnapAlignment::Start => 0,
                    SnapAlignment::Center => 1,
                    SnapAlignment::End => 2,
                });
                e.float(b.deceleration);
                e.bool(b.enabled);
                e.bool(b.bounces);
                let i = b.content_inset;
                e.float(i.top.0);
                e.float(i.right.0);
                e.float(i.bottom.0);
                e.float(i.left.0);
                e.int(match b.keyboard_taps {
                    KeyboardTaps::Never => 0,
                    KeyboardTaps::Always => 1,
                    KeyboardTaps::Handled => 2,
                });
                e.bool(b.one_step);
                e.bool(b.zooms());
                e.float(b.min_zoom);
                e.float(b.max_zoom.max(b.min_zoom));
                e.bool(b.bounces_zoom);
                e.bool(b.pinch);
                e.bool(b.center_content);
                e.bool(b.refresh_indicator.is_some());
                e.float(b.refresh_indicator.map_or(0.0, |h| h.0));
            }
            MountItem::ScrollBy { id, dx, dy } => {
                e.int(SCROLL_BY);
                e.int(id as i32);
                e.float(dx.0);
                e.float(dy.0);
            }
            MountItem::Refreshing { id, refreshing } => {
                e.int(REFRESHING);
                e.int(id as i32);
                e.bool(refreshing);
            }
            MountItem::AnimationBindings { id, bindings } => {
                // Java restores the static style; the animator then writes
                // the bound properties.
                e.int(DYNAMIC);
                e.int(id as i32);
                e.animation
                    .push(MountItem::AnimationBindings { id, bindings });
            }
            MountItem::Gestures { id, values } => {
                e.int(GESTURES);
                e.int(id as i32);
                e.bool(values.pan_x.is_some() || values.pan_y.is_some());
                // Axis lock: a pan with only one value starts on movement
                // along that axis, so it coexists with scrolling.
                e.int(match (values.pan_x.is_some(), values.pan_y.is_some()) {
                    (true, false) => 1,
                    (false, true) => 2,
                    _ => 0,
                });
                e.bool(values.pinch.is_some());
                e.bool(values.rotation.is_some());
                e.animation.push(MountItem::Gestures { id, values });
            }
            MountItem::ViewProps { id, props } => {
                e.int(VIEW_PROPS);
                e.int(id as i32);
                view_props(&mut e, &props);
            }
            MountItem::AccessibilityLabel { id, label } => {
                e.int(ACCESSIBILITY_LABEL);
                e.int(id as i32);
                e.opt_string(label.as_deref());
            }
            MountItem::ScreenConfig { id, config } => {
                e.int(SCREEN_CONFIG);
                e.int(id as i32);
                screen_config(&mut e, &config);
            }
            MountItem::NativeProps { id, props } => {
                e.int(NATIVE_PROPS);
                e.int(id as i32);
                native_props(&mut e, &props);
            }
            MountItem::ModalConfig { id, config } => {
                e.int(MODAL_CONFIG);
                e.int(id as i32);
                e.int(match config.animation {
                    ModalAnimation::Slide => 0,
                    ModalAnimation::Fade => 1,
                    ModalAnimation::None => 2,
                });
                e.int(match config.presentation {
                    ModalPresentation::FullScreen => 0,
                    ModalPresentation::PageSheet => 1,
                    ModalPresentation::FormSheet => 2,
                });
                e.bool(config.status_bar_translucent);
                // The back button is Escape (`closeOnEscape`).
                e.bool(config.close_on_escape);
            }
            MountItem::LayoutAnimation(animation) => {
                e.int(LAYOUT_ANIMATION);
                for t in [animation.create, animation.update, animation.delete] {
                    layout_transition(&mut e, t);
                }
            }
            item @ MountItem::Animation(_) => e.animation.push(item),
            MountItem::Input { id, config } => {
                e.int(INPUT);
                e.int(id as i32);
                input(&mut e, &config);
            }
            MountItem::InputValue { id, text, count } => {
                e.int(INPUT_VALUE);
                e.int(id as i32);
                e.string(text);
                e.int(count as i32);
            }
            MountItem::InputContent { id, content } => {
                e.int(INPUT_CONTENT);
                e.int(id as i32);
                for v in [
                    content.origin.x.0,
                    content.origin.y.0,
                    content.size.width.0,
                    content.size.height.0,
                ] {
                    e.float(v);
                }
            }
            MountItem::Component { id, name } => {
                e.int(COMPONENT);
                e.int(id as i32);
                e.string(name.to_string());
            }
            MountItem::ComponentPropSlots { id, names } => {
                e.int(COMPONENT_PROP_SLOTS);
                e.int(id as i32);
                e.int(names.len() as i32);
                for name in names {
                    e.string(name.to_string());
                }
            }
            MountItem::ComponentProps { id, props } => {
                e.int(COMPONENT_PROPS);
                e.int(id as i32);
                e.int(props.len() as i32);
                for (name, value) in props {
                    e.string(name.to_string());
                    e.opt_string(value.map(|v| v.to_string()).as_deref());
                }
            }
            MountItem::Command { id, command } => {
                e.int(COMMAND);
                e.int(id as i32);
                match command {
                    Command::Focus => e.int(0),
                    Command::Blur => e.int(1),
                    Command::ScrollTo { x, y, animated } => {
                        e.int(2);
                        e.float(x.0);
                        e.float(y.0);
                        e.bool(animated);
                    }
                    Command::ExitApp => e.int(3),
                    Command::Back => e.int(24),
                    Command::Reload => e.int(4),
                    Command::GoBack => e.int(5),
                    Command::GoForward => e.int(6),
                    Command::StopLoading => e.int(7),
                    Command::InjectJavaScript(js) => {
                        e.int(8);
                        e.string(js);
                    }
                    Command::PostMessage(data) => {
                        e.int(9);
                        e.string(data);
                    }
                    Command::Seek(seconds) => {
                        e.int(10);
                        e.float(seconds as f32);
                    }
                    Command::StatusBar(c) => {
                        e.int(11);
                        e.int(match c.style {
                            StatusBarStyle::Default => 0,
                            StatusBarStyle::Light => 1,
                            StatusBarStyle::Dark => 2,
                        });
                        e.bool(c.hidden);
                        e.bool(c.animated);
                    }
                    Command::Dialog(d) => {
                        e.int(12);
                        e.int(d.id as i32);
                        e.opt_string(d.title.as_deref());
                        e.opt_string(d.message.as_deref());
                        e.bool(d.cancelable);
                        e.bool(d.sheet);
                        e.int(d.buttons.len() as i32);
                        for b in d.buttons {
                            e.string(b.text);
                            e.int(match b.style {
                                DialogButtonStyle::Default => 0,
                                DialogButtonStyle::Cancel => 1,
                                DialogButtonStyle::Destructive => 2,
                            });
                        }
                    }
                    Command::SetJsResponder { block } => {
                        e.int(14);
                        e.bool(block);
                    }
                    Command::ClearJsResponder => e.int(15),
                    Command::SetSelection { start, end } => {
                        e.int(16);
                        e.int(start as i32);
                        e.int(end as i32);
                    }
                    Command::Announce(text) => {
                        e.int(17);
                        e.string(text);
                    }
                    Command::AccessibilityFocus => e.int(18),
                    Command::ImageInfo { id, uri } => {
                        e.int(19);
                        e.int(id as i32);
                        e.string(uri);
                    }
                    Command::ZoomTo {
                        scale,
                        center,
                        animated,
                    } => {
                        e.int(20);
                        e.float(scale);
                        e.bool(center.is_some());
                        let c = center.unwrap_or_default();
                        e.float(c.x.0);
                        e.float(c.y.0);
                        e.bool(animated);
                    }
                    Command::Native { name, args } => {
                        e.int(21);
                        e.string(name.to_string());
                        e.string(args.to_string());
                    }
                    Command::SetClipboard(text) => {
                        e.int(22);
                        e.string(text);
                    }
                    Command::ReadClipboard { id, has_only } => {
                        e.int(23);
                        e.int(id as i32);
                        e.bool(has_only);
                    }
                    Command::OpenUrl { id, url } => {
                        e.int(26);
                        e.int(id as i32);
                        e.string(url);
                    }
                    // Answered by the sink (`host::answer_clipboard_reads`);
                    // images are not written to Android's clipboard.
                    Command::ReadClipboardImage { .. }
                    | Command::ReadClipboardFiles { .. }
                    | Command::SetClipboardImage(_) => e.int(-1),
                    // `Picker.java`: the request, the limit, the longest
                    // side (0: any), the quality (-1: none), the format.
                    Command::PickImages { id, request } => {
                        e.int(25);
                        e.int(id as i32);
                        e.int(request.limit as i32);
                        e.int(request.max_dimension.map_or(0, |d| d.0.max(1)));
                        e.float(request.quality.map_or(-1.0, |q| q.0));
                        e.bool(request.format == nsh_core::picker::PickFormat::Current);
                    }
                    // Turned into a mount item / `ScrollTo` by the core.
                    Command::LayoutAnimation(_)
                    | Command::SetStatusBar(_)
                    | Command::ScrollToIndex { .. }
                    | Command::Measure { .. }
                    | Command::ScrollToEnd { .. }
                    | Command::ReplaceRange { .. }
                    // Desktops only.
                    | Command::Desktop(_)
                    // No host answers `nsh/host` here (`Environment::host`):
                    // the core rejects the calls first.
                    | Command::HostCall { .. } => e.int(-1),
                }
            }
        }
    }
    e
}

/// The event kind with index `index` (`EventKind as u8`, the order of the
/// constants in `Native.java`).
pub(crate) fn kind_from(index: i32) -> Option<nsh_core::EventKind> {
    nsh_core::EventKind::ALL
        .get(usize::try_from(index).ok()?)
        .copied()
}

fn view_style(e: &mut Encoded, s: &ViewStyle) {
    e.int(argb(s.background_color));
    let radii = s.radii();
    for r in radii.to_array() {
        e.float(r.0);
    }
    e.bool(radii.continuous);
    let b = &s.borders;
    for w in b.widths.to_array() {
        e.float(w.0);
    }
    for c in b.colors {
        e.int(argb(c));
    }
    e.int(match b.style {
        BorderStyle::Solid => 0,
        BorderStyle::Dashed => 1,
        BorderStyle::Dotted => 2,
    });
    e.float(s.opacity);
    e.bool(s.overflow_hidden);
    for v in view_transform(&s.transform, |_| None) {
        e.float(v);
    }
    e.bool(s.tint_color.is_some());
    e.int(s.tint_color.map_or(0, argb));
    e.float(s.elevation.0);
    // Transform origin: kind (0 points, 1 fraction) and value per axis.
    for v in [s.transform_origin.x, s.transform_origin.y] {
        match v {
            DefiniteLength::Absolute(p) => {
                e.int(0);
                e.float(p.to_points(REM_SIZE).0);
            }
            DefiniteLength::Fraction(f) => {
                e.int(1);
                e.float(f.0);
            }
        }
    }
    e.bool(s.backface_hidden);
    effects(e, s);
}

/// An angle in the degrees `Decor.java` takes, rounded to 1e-4 so that
/// whole degrees go as the style wrote them (radians to degrees in `f32`
/// can be an ulp off).
fn degrees(a: nsh_core::geometry::Radians) -> f32 {
    (a.to_degrees() * 1e4).round() / 1e4
}

/// The effects of `Mounter.java` `style`: shadows, gradients, filters,
/// blend mode, outline, visibility, cursor, transition, animation.
fn effects(e: &mut Encoded, s: &ViewStyle) {
    use nsh_core::{
        BlendMode, Cursor, Filter, GradientKind, GradientSize, Keyframes,
        geometry::{DefiniteLength, REM_SIZE, Size},
    };
    let fx = s.effects.as_deref();
    let shadows = fx.map_or(&[][..], |f| &f.box_shadows[..]);
    e.int(shadows.len() as i32);
    for sh in shadows {
        for v in [sh.offset_x, sh.offset_y, sh.blur, sh.spread] {
            e.float(v.0);
        }
        e.int(argb(sh.color));
        e.bool(sh.inset);
    }
    let gradients = fx.map_or(&[][..], |f| &f.background_images[..]);
    e.int(gradients.len() as i32);
    for g in gradients {
        match g.kind {
            GradientKind::Linear { angle } => {
                e.int(0);
                e.float(degrees(angle));
                e.int(0);
                e.int(0);
            }
            GradientKind::LinearCorner { right, bottom } => {
                e.int(1);
                e.float(0.0);
                e.bool(right);
                e.bool(bottom);
            }
            GradientKind::Radial { circle, size, x, y } => {
                e.int(2);
                e.bool(circle);
                e.int(match size {
                    GradientSize::ClosestSide => 0,
                    GradientSize::ClosestCorner => 1,
                    GradientSize::FarthestSide => 2,
                    GradientSize::FarthestCorner => 3,
                });
                e.float(x.0);
                e.float(y.0);
            }
            GradientKind::Conic { from, x, y } => {
                e.int(3);
                e.float(degrees(from));
                e.float(x.0);
                e.float(y.0);
            }
        }
        // Repeated by `Decor.Gradient.place`, over the box it knows.
        e.bool(g.repeating);
        if g.has_lengths() {
            // Stops placed in points depend on the box, which `Decor`
            // knows when it draws: they go as written, their count
            // negated, each with its unit (0 spread, 1 fraction, 2
            // points), and `Decor.Gradient.place` places them.
            e.int(-(g.stops.len() as i32));
            for s in &g.stops {
                e.int(argb(s.color));
                let (unit, v) = match s.position {
                    None => (0, 0.0),
                    Some(DefiniteLength::Fraction(f)) => (1, f.0),
                    Some(DefiniteLength::Absolute(a)) => (2, a.to_points(REM_SIZE).0),
                };
                e.float(v);
                e.int(unit);
            }
        } else {
            // Without lengths the box does not matter.
            let stops = g.resolved_stops(Size::default());
            e.int(stops.len() as i32);
            for (c, p) in stops {
                e.int(argb(c));
                e.float(p.0);
            }
        }
    }
    let filter_list = |e: &mut Encoded, list: &[Filter]| {
        // Color filters as one composed matrix, then blur, then the drop
        // shadow (what Android's render effects take): the widest of the
        // chain's (the last of equals).
        let matrix = nsh_core::compose_color_matrices(list);
        e.bool(matrix.is_some());
        for v in matrix.unwrap_or([0.0; 20]) {
            e.float(v);
        }
        e.float(nsh_core::blur_radius(list).0);
        let shadow = list
            .iter()
            .filter_map(|f| match *f {
                Filter::DropShadow {
                    offset_x,
                    offset_y,
                    blur,
                    color,
                } => Some((offset_x.0, offset_y.0, blur.0, color)),
                _ => None,
            })
            .max_by(|a, b| a.2.total_cmp(&b.2));
        e.bool(shadow.is_some());
        let (x, y, b, c) = shadow.unwrap_or((0.0, 0.0, 0.0, Color::TRANSPARENT));
        e.float(x);
        e.float(y);
        e.float(b);
        e.int(argb(c));
    };
    filter_list(e, fx.map_or(&[][..], |f| &f.filters[..]));
    filter_list(e, fx.map_or(&[][..], |f| &f.backdrop_filters[..]));
    e.int(match s.blend_mode {
        BlendMode::Normal => 0,
        BlendMode::Multiply => 1,
        BlendMode::Screen => 2,
        BlendMode::Overlay => 3,
        BlendMode::Darken => 4,
        BlendMode::Lighten => 5,
        BlendMode::ColorDodge => 6,
        BlendMode::ColorBurn => 7,
        BlendMode::HardLight => 8,
        BlendMode::SoftLight => 9,
        BlendMode::Difference => 10,
        BlendMode::Exclusion => 11,
        BlendMode::Hue => 12,
        BlendMode::Saturation => 13,
        BlendMode::Color => 14,
        BlendMode::Luminosity => 15,
        BlendMode::PlusDarker => 16,
        BlendMode::PlusLighter => 17,
    });
    let o = s.outline;
    e.float(if o.is_visible() { o.width.0 } else { 0.0 });
    e.int(argb(o.color));
    e.int(match o.style {
        BorderStyle::Solid => 0,
        BorderStyle::Dashed => 1,
        BorderStyle::Dotted => 2,
    });
    e.float(o.offset.0);
    e.bool(s.hidden);
    e.int(match s.cursor {
        Cursor::Auto => 0,
        Cursor::Default => 1,
        Cursor::Pointer => 2,
        Cursor::Text => 3,
        Cursor::Wait => 4,
        Cursor::Progress => 5,
        Cursor::Help => 6,
        Cursor::Crosshair => 7,
        Cursor::Move => 8,
        Cursor::Grab => 9,
        Cursor::Grabbing => 10,
        Cursor::NotAllowed => 11,
        Cursor::ZoomIn => 12,
        Cursor::ZoomOut => 13,
        Cursor::ColResize => 14,
        Cursor::RowResize => 15,
        Cursor::None => 16,
    });
    match s.transition.filter(|t| t.duration > 0.0) {
        Some(t) => {
            e.int(t.properties.0 as i32);
            e.float(t.duration);
            e.float(t.delay);
            for v in t.easing {
                e.float(v);
            }
        }
        None => {
            e.int(0);
            for _ in 0..6 {
                e.float(0.0);
            }
        }
    }
    match s.animation {
        Some(a) => {
            e.int(match a.keyframes {
                Keyframes::Spin => 1,
                Keyframes::Ping => 2,
                Keyframes::Pulse => 3,
                Keyframes::Bounce => 4,
            });
            e.float(a.duration);
            e.float(a.delay);
            for v in a.easing {
                e.float(v);
            }
            e.int(a.iterations.map_or(-1, |n| n as i32));
        }
        None => {
            e.int(0);
            for _ in 0..6 {
                e.float(0.0);
            }
            e.int(0);
        }
    }
}

/// An [`nsh_core::EventMask`]: a bit set indexed by `EventKind as u8`, as
/// four ints, lowest first (two Java longs: `Events`).
fn mask(e: &mut Encoded, events: nsh_core::EventMask) {
    let bits = events.bits();
    for word in 0..4 {
        e.int((bits >> (32 * word)) as u32 as i32);
    }
}

fn opt_color(e: &mut Encoded, c: Option<Color>) {
    e.bool(c.is_some());
    e.int(c.map_or(0, argb));
}

/// `Mounter.java` `nativeProps`: a kind, then its fields.
fn native_props(e: &mut Encoded, p: &NativeProps) {
    match p {
        NativeProps::WebView(w) => {
            e.int(3);
            match &w.source {
                WebSource::None => e.int(0),
                WebSource::Uri(uri) => {
                    e.int(1);
                    e.string(uri.to_string());
                }
                WebSource::Html { html, base_url } => {
                    e.int(2);
                    e.string(html.to_string());
                    e.opt_string(base_url.as_deref());
                }
            }
            e.opt_string(w.injected_js.as_deref());
            e.opt_string(w.injected_js_before.as_deref());
            e.opt_string(w.user_agent.as_deref());
            e.bool(w.scrollable);
            e.bool(w.javascript_enabled);
        }
        NativeProps::Video(v) => {
            e.int(4);
            e.opt_string(v.source.as_deref());
            e.bool(v.paused);
            e.bool(v.muted);
            e.float(v.volume);
            e.float(v.rate);
            e.bool(v.repeat);
            e.int(match v.resize_mode {
                ResizeMode::Cover => 0,
                ResizeMode::Stretch => 2,
                _ => 1,
            });
            e.bool(v.controls);
            e.float(v.progress_interval_ms);
            e.int(match v.audio_session {
                AudioSession::Default => 0,
                AudioSession::Playback => 1,
                AudioSession::MixWithOthers => 2,
            });
        }
    }
}

fn screen_config(e: &mut Encoded, c: &ScreenConfig) {
    e.opt_string(c.title.as_deref());
    e.bool(c.header_visible);
    e.bool(c.large_title);
    e.bool(c.header_transparent);
    opt_color(e, c.tint_color);
    opt_color(e, c.background_color);
    opt_color(e, c.title_color);
    e.bool(c.back_visible);
    e.bool(c.gesture_enabled);
    e.bool(c.prevent_back);
    e.int(match c.animation {
        ScreenAnimation::Default => 0,
        ScreenAnimation::Fade => 1,
        ScreenAnimation::None => 2,
    });
    for id in [c.left, c.right, c.title_view] {
        e.int(id.map_or(-1, |i| i as i32));
    }
    e.float(c.header_height.0);
    e.opt_string(c.back_title.as_deref());
}

fn view_props(e: &mut Encoded, p: &ViewProps) {
    e.int(match p.pointer_events {
        PointerEvents::Auto => 0,
        PointerEvents::None => 1,
        PointerEvents::BoxNone => 2,
        PointerEvents::BoxOnly => 3,
    });
    let h = p.hit_slop;
    for v in [h.top, h.right, h.bottom, h.left] {
        e.float(v.0);
    }
    let a = &p.accessibility;
    e.int(match a.accessible {
        None => -1,
        Some(false) => 0,
        Some(true) => 1,
    });
    e.opt_string(a.label.as_deref());
    e.opt_string(a.hint.as_deref());
    e.int(role_index(a.role));
    let s = a.state;
    let mut flags = 0;
    if s.disabled {
        flags |= 1;
    }
    if s.selected {
        flags |= 2;
    }
    if s.busy {
        flags |= 4;
    }
    match s.checked {
        Some(Checked::False) => flags |= 8,
        Some(Checked::True) => flags |= 8 | 16,
        Some(Checked::Mixed) => flags |= 8 | 32,
        None => {}
    }
    match s.expanded {
        Some(false) => flags |= 64,
        Some(true) => flags |= 64 | 128,
        None => {}
    }
    e.int(flags);
    match &a.value {
        Some(v) => {
            e.int(1);
            for n in [v.min, v.max, v.now] {
                e.float(n.unwrap_or(f32::NAN));
            }
            e.opt_string(v.text.as_deref());
        }
        None => e.int(0),
    }
    e.bool(a.hidden);
    e.int(match a.live_region {
        LiveRegion::None => 0,
        LiveRegion::Polite => 1,
        LiveRegion::Assertive => 2,
    });
    e.int(a.actions.len() as i32);
    for action in &a.actions {
        e.string(action.name.to_string());
        e.opt_string(action.label.as_deref());
    }
    e.opt_string(p.test_id.as_deref());
    e.float(p.long_press_delay.unwrap_or(-1.0));
    match p.ripple {
        Some(r) => {
            e.int(1 | (r.borderless as i32) << 1 | (r.foreground as i32) << 2);
            opt_color(e, r.color);
            e.float(r.radius.map_or(-1.0, |r| r.0));
        }
        None => e.int(0),
    }
    match p.pan_activation {
        Some(a) => {
            e.int(1);
            for v in [
                a.active_offset_x,
                a.active_offset_y,
                a.fail_offset_x,
                a.fail_offset_y,
            ] {
                e.float(v.map_or(f32::NAN, |v| v.0));
            }
        }
        None => e.int(0),
    }
    e.bool(p.selectable_view);
}

/// Index of `role` in `A11y.java`'s class name table.
fn role_index(role: AccessibilityRole) -> i32 {
    use AccessibilityRole::*;
    match role {
        None => 0,
        Button => 1,
        Link => 2,
        Search => 3,
        Image => 4,
        ImageButton => 5,
        KeyboardKey => 6,
        Text => 7,
        Adjustable => 8,
        Header => 9,
        Summary => 10,
        Alert => 11,
        Checkbox => 12,
        Combobox => 13,
        Menu => 14,
        Menubar => 15,
        Menuitem => 16,
        Progressbar => 17,
        Radio => 18,
        Radiogroup => 19,
        Scrollbar => 20,
        Spinbutton => 21,
        Switch => 22,
        Tab => 23,
        Tablist => 24,
        Timer => 25,
        Toolbar => 26,
        List => 27,
        Grid => 28,
        Table => 29,
        Row => 30,
        Cell => 31,
        ColumnHeader => 32,
        RowGroup => 33,
        Listbox => 34,
        Option => 35,
    }
}

fn layout_transition(e: &mut Encoded, t: Option<LayoutTransition>) {
    let Some(t) = t else {
        return e.int(0);
    };
    e.int(1);
    let (curve, damping) = match t.curve {
        LayoutCurve::Linear => (0, 0.0),
        LayoutCurve::EaseIn => (1, 0.0),
        LayoutCurve::EaseOut => (2, 0.0),
        LayoutCurve::EaseInEaseOut => (3, 0.0),
        LayoutCurve::Spring { damping } => (4, damping),
        LayoutCurve::Keyboard => (5, 0.0),
    };
    e.int(curve);
    e.float(damping);
    e.int(match t.property {
        LayoutProperty::Opacity => 0,
        LayoutProperty::Scale => 1,
    });
    e.float(t.duration_ms);
    e.float(t.delay_ms);
}

fn input(e: &mut Encoded, c: &InputConfig) {
    let s = &c.style;
    e.float(s.font_size.0);
    e.int(s.font_weight as i32);
    e.bool(s.italic);
    e.int(argb(s.color));
    match s.font_family {
        Some(f) => e.string(f.name().to_string()),
        None => e.int(-1),
    }
    e.float(s.letter_spacing.0);
    e.int(match c.align {
        TextAlign::Auto | TextAlign::Left | TextAlign::Justify => 0,
        TextAlign::Center => 1,
        TextAlign::Right => 2,
    });
    e.string(c.placeholder.clone());
    e.bool(c.placeholder_color.is_some());
    e.int(c.placeholder_color.map_or(0, argb));
    e.bool(c.secure);
    e.int(match c.keyboard {
        KeyboardType::Default => 0,
        KeyboardType::Number => 1,
        KeyboardType::Decimal => 2,
        KeyboardType::Email => 3,
        KeyboardType::Phone => 4,
        KeyboardType::Url => 5,
        KeyboardType::Numeric => 6,
        KeyboardType::NumbersAndPunctuation => 7,
    });
    e.int(match c.return_key {
        ReturnKeyType::Default => 0,
        ReturnKeyType::Done => 1,
        ReturnKeyType::Go => 2,
        ReturnKeyType::Next => 3,
        ReturnKeyType::Search => 4,
        ReturnKeyType::Send => 5,
    });
    e.int(match c.auto_capitalize {
        AutoCapitalize::None => 0,
        AutoCapitalize::Sentences => 1,
        AutoCapitalize::Words => 2,
        AutoCapitalize::Characters => 3,
    });
    e.bool(c.auto_correct);
    e.bool(c.multiline);
    e.int(c.max_length.map_or(-1, |m| m as i32));
    e.bool(c.editable);
    e.bool(c.auto_focus);
    e.bool(c.selection_color.is_some());
    e.int(c.selection_color.map_or(0, argb));
    e.bool(c.caret_color.is_some());
    e.int(c.caret_color.map_or(0, argb));
    // What return does: 0 submit, 1 submit and unfocus, 2 a line break.
    e.int(match c.submit() {
        SubmitBehavior::Submit => 0,
        SubmitBehavior::BlurAndSubmit => 1,
        SubmitBehavior::Newline => 2,
    });
    // Android autofill hints ("" for none).
    e.opt_string(match c.auto_fill {
        AutoFill::Default => None,
        AutoFill::Off => Some(""),
        AutoFill::Username => Some("username"),
        AutoFill::Password => Some("password"),
        AutoFill::NewPassword => Some("newPassword"),
        AutoFill::OneTimeCode => Some("smsOTPCode"),
        AutoFill::Email => Some("emailAddress"),
        AutoFill::Tel => Some("phone"),
        AutoFill::Name => Some("personName"),
        AutoFill::GivenName => Some("personGivenName"),
        AutoFill::FamilyName => Some("personFamilyName"),
        AutoFill::MiddleName => Some("personMiddleName"),
        AutoFill::Nickname => Some("nickname"),
        AutoFill::Organization => Some("organization"),
        AutoFill::StreetAddress => Some("postalAddress"),
        AutoFill::AddressLine1 => Some("streetAddress"),
        AutoFill::AddressLine2 => Some("extendedAddress"),
        AutoFill::City => Some("addressLocality"),
        AutoFill::Region => Some("addressRegion"),
        AutoFill::PostalCode => Some("postalCode"),
        AutoFill::Country => Some("addressCountry"),
        AutoFill::CreditCardNumber => Some("creditCardNumber"),
        AutoFill::CreditCardExpiration => Some("creditCardExpirationDate"),
        AutoFill::CreditCardSecurityCode => Some("creditCardSecurityCode"),
        AutoFill::CreditCardName => Some("creditCardHolderName"),
        AutoFill::Url => Some("url"),
        AutoFill::Birthdate => Some("birthDateFull"),
    });
    e.bool(c.rtl);
    e.bool(c.caret_hidden);
    // `pasteBehavior`: whether a paste inserts its text.
    e.bool(c.paste_behavior == nsh_core::PasteBehavior::Insert);
}

// --- Canvas drawings (`CanvasBox.java`) -------------------------------------
//
// A word count, then the operations as 32-bit words: operation codes as in
// `nsh_core::js::canvas` (`CV_*`), numbers as float bits, animated value
// slots as `SLOT_BITS | slot` (a NaN no arithmetic produces), strings as
// object indices.

/// Marks a word as animated value slot `word & 0xfffff`.
const SLOT_BITS: u32 = 0x7fa0_0000;

impl Encoded {
    fn num(&mut self, n: nsh_core::canvas::Num) {
        match n {
            nsh_core::canvas::Num::Const(v) => self.float(v),
            nsh_core::canvas::Num::Slot(s) => self.int((SLOT_BITS | s as u32) as i32),
        }
    }

    fn nums(&mut self, ns: &[nsh_core::canvas::Num]) {
        for &n in ns {
            self.num(n);
        }
    }
}

fn canvas(e: &mut Encoded, d: &nsh_core::canvas::Drawing) {
    use nsh_core::canvas::CanvasOp as Op;
    let at = e.bytes.len();
    e.int(0);
    for op in &d.ops {
        match op {
            Op::Save => e.int(0),
            Op::Restore => e.int(1),
            Op::Translate(x, y) => {
                e.int(2);
                e.nums(&[*x, *y]);
            }
            Op::Scale(x, y) => {
                e.int(3);
                e.nums(&[*x, *y]);
            }
            Op::Rotate(a) => {
                e.int(4);
                e.num(*a);
            }
            Op::Transform(m) => {
                e.int(5);
                e.nums(m);
            }
            Op::SetTransform(m) => {
                e.int(6);
                e.nums(m);
            }
            Op::BeginPath => e.int(7),
            Op::Path(p) => path_op(e, p),
            Op::Fill(p, rule) => {
                e.int(18);
                e.int(*rule as i32);
                path(e, p.as_deref());
            }
            Op::Stroke(p) => {
                e.int(19);
                path(e, p.as_deref());
            }
            Op::Clip(p, rule) => {
                e.int(20);
                e.int(*rule as i32);
                path(e, p.as_deref());
            }
            Op::FillRect(r) => {
                e.int(21);
                e.nums(r);
            }
            Op::StrokeRect(r) => {
                e.int(22);
                e.nums(r);
            }
            Op::ClearRect(r) => {
                e.int(23);
                e.nums(r);
            }
            Op::FillStyle(p) => {
                e.int(24);
                paint(e, p);
            }
            Op::StrokeStyle(p) => {
                e.int(25);
                paint(e, p);
            }
            Op::LineWidth(w) => {
                e.int(26);
                e.num(*w);
            }
            Op::LineCap(c) => {
                e.int(27);
                e.int(*c as i32);
            }
            Op::LineJoin(j) => {
                e.int(28);
                e.int(*j as i32);
            }
            Op::MiterLimit(m) => {
                e.int(29);
                e.float(*m);
            }
            Op::LineDash(d) => {
                e.int(30);
                e.int(d.len() as i32);
                for &v in d.iter() {
                    e.float(v.0);
                }
            }
            Op::LineDashOffset(o) => {
                e.int(31);
                e.num(*o);
            }
            Op::GlobalAlpha(a) => {
                e.int(32);
                e.num(*a);
            }
            Op::Composite(c) => {
                e.int(33);
                e.int(*c as i32);
            }
            Op::ShadowColor(c) => {
                e.int(34);
                e.int(argb(*c));
            }
            Op::ShadowBlur(b) => {
                e.int(35);
                e.float(b.0);
            }
            Op::ShadowOffset(offset) => {
                e.int(36);
                e.float(offset.x.0);
                e.float(offset.y.0);
            }
            Op::Font(f) => {
                e.int(37);
                e.float(f.size.0);
                e.int(f.weight as i32);
                e.bool(f.italic);
                e.opt_string(f.family.as_deref());
                e.int(f.variant.0 as i32);
            }
            Op::FontVariantNumeric(v) => {
                e.int(43);
                e.int(v.0 as i32);
            }
            Op::TextAlign(a) => {
                e.int(38);
                e.int(*a as i32);
            }
            Op::TextBaseline(b) => {
                e.int(39);
                e.int(*b as i32);
            }
            Op::FillText {
                text,
                x,
                y,
                max_width,
            }
            | Op::StrokeText {
                text,
                x,
                y,
                max_width,
            } => {
                e.int(if matches!(op, Op::FillText { .. }) {
                    40
                } else {
                    41
                });
                e.string(text.to_string());
                e.nums(&[*x, *y]);
                e.float(max_width.map_or(f32::NAN, |m| m.0));
            }
            Op::DrawImage {
                image,
                source,
                dest,
            } => {
                e.int(42);
                e.string(image.uri.to_string());
                e.bool(source.is_some());
                let source = source.map_or([0.0; 4], |s| {
                    [s.origin.x.0, s.origin.y.0, s.size.width.0, s.size.height.0]
                });
                for v in source {
                    e.float(v);
                }
                e.nums(dest);
            }
        }
    }
    let words = ((e.bytes.len() - at - 4) / 4) as i32;
    e.bytes[at..at + 4].copy_from_slice(&words.to_le_bytes());
}

fn path_op(e: &mut Encoded, p: &nsh_core::canvas::PathOp) {
    use nsh_core::canvas::PathOp as P;
    match p {
        P::MoveTo(x, y) => {
            e.int(8);
            e.nums(&[*x, *y]);
        }
        P::LineTo(x, y) => {
            e.int(9);
            e.nums(&[*x, *y]);
        }
        P::QuadTo(v) => {
            e.int(10);
            e.nums(v);
        }
        P::CubicTo(v) => {
            e.int(11);
            e.nums(v);
        }
        P::Arc {
            x,
            y,
            radius,
            start,
            end,
            ccw,
        } => {
            e.int(12);
            e.nums(&[*x, *y, *radius, *start, *end]);
            e.bool(*ccw);
        }
        P::ArcTo(v) => {
            e.int(13);
            e.nums(v);
        }
        P::Ellipse {
            geometry,
            start,
            end,
            ccw,
        } => {
            e.int(14);
            e.nums(geometry);
            e.nums(&[*start, *end]);
            e.bool(*ccw);
        }
        P::Rect(v) => {
            e.int(15);
            e.nums(v);
        }
        P::RoundRect(rect, radii) => {
            e.int(16);
            e.nums(rect);
            e.nums(radii);
        }
        P::Close => e.int(17),
    }
}

/// A path: its operation count (-1: the current path), then them.
fn path(e: &mut Encoded, ops: Option<&[nsh_core::canvas::PathOp]>) {
    match ops {
        None => e.int(-1),
        Some(ops) => {
            e.int(ops.len() as i32);
            for op in ops {
                path_op(e, op);
            }
        }
    }
}

/// 0 color, 1 animated value slot, 2 gradient (shape 0 linear / 1 radial /
/// 2 conic, its numbers, stop count, then offset and color pairs).
fn paint(e: &mut Encoded, p: &nsh_core::canvas::Paint) {
    use nsh_core::canvas::{GradientShape, Paint};
    match p {
        Paint::Color(c) => {
            e.int(0);
            e.int(argb(*c));
        }
        Paint::Slot(s) => {
            e.int(1);
            e.int(*s as i32);
        }
        Paint::Gradient(g) => {
            e.int(2);
            let (kind, values): (i32, &[f32]) = match &g.shape {
                GradientShape::Linear { start, end } => {
                    (0, &[start.x.0, start.y.0, end.x.0, end.y.0])
                }
                GradientShape::Radial {
                    start,
                    start_radius,
                    end,
                    end_radius,
                } => (
                    1,
                    &[
                        start.x.0,
                        start.y.0,
                        start_radius.0,
                        end.x.0,
                        end.y.0,
                        end_radius.0,
                    ],
                ),
                GradientShape::Conic {
                    start_angle,
                    center,
                } => (2, &[start_angle.0, center.x.0, center.y.0]),
            };
            e.int(kind);
            for &v in values {
                e.float(v);
            }
            e.int(g.stops.len() as i32);
            for (offset, color) in &g.stops {
                e.float(offset.0);
                e.int(argb(*color));
            }
        }
    }
}
