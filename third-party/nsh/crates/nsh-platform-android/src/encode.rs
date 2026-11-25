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
    AccessibilityCurrent, AccessibilityRole, AudioSession, AutoCapitalize, AutoFill, BorderStyle,
    Checked, Color, Command, DialogButtonStyle, EditAction, HeaderTitleAlign, InputConfig,
    KeyCapture, KeyboardDismissMode, KeyboardTaps, KeyboardType, LayoutCurve, LayoutProperty,
    LayoutTransition, LiveRegion, ModalAnimation, ModalPresentation, MountBatch, MountItem,
    NativeProps, PanDirection, PanEdge, PointerEvents, ResizeMode, ReturnKeyType, ScreenAnimation,
    ScreenConfig, SnapAlignment, StatusBarStyle, SubmitBehavior, ViewKind, ViewProps, ViewStyle,
    WebSource,
    audio::AudioCommand,
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
const COMPONENT_PROP_SLOTS: i32 = 34;
const SHADER: i32 = 35;
const SHADER_TRANSITION: i32 = 36;
const SHADER_INPUT: i32 = 37;
const NAV_SHADER: i32 = 38;

/// An entry of the object table.
pub(crate) enum Obj {
    Str(String),
    /// A sound's bytes (`Audio.java`), a `byte[]` on the Java side.
    Bytes(nsh_core::image::ImageData),
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

pub(crate) fn encode(batch: MountBatch, web_generation: u64) -> Encoded {
    let mut e = Encoded {
        bytes: Vec::with_capacity(batch.items.len() * 16),
        ..Encoded::default()
    };
    for item in batch.items {
        match item {
            MountItem::TreeOrder(_) | MountItem::ProjectStates { .. } => {}
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
            MountItem::Remove { id } => {
                e.int(REMOVE);
                e.int(id as i32);
            }
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
                // The one color all of it is drawn in, if there is one: a
                // change of it transitions (`transition-colors`, `TextBox`).
                opt_color(&mut e, text.uniform_color());
                // What attachments copy as: offset, then the string's
                // object (`TextBox.copied`).
                e.int(text.copy_texts.len() as i32);
                for copy in &text.copy_texts {
                    e.int(copy.index as i32);
                    e.string(copy.text.to_string());
                }
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
                replaced,
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
                    replaced,
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
                // Java learns what the view shows (whether a shader, its
                // role, how far it overflows, which pictures it reads); the
                // layer goes to the UI-thread renderer (`crate::shader`).
                e.int(SHADER);
                e.int(id as i32);
                e.bool(layer.is_some());
                let l = layer.as_deref();
                e.int(l.map_or(0, |l| l.role as i32));
                e.float(l.map_or(0.0, |l| l.overflow.0));
                e.int(l.map_or(0, |l| {
                    l.shader
                        .inputs()
                        .iter()
                        .fold(0, |bits, i| bits | 1 << i.index())
                }));
                e.animation.push(MountItem::Shader { id, layer });
            }
            MountItem::ShaderTransition { id, duration } => {
                e.int(SHADER_TRANSITION);
                e.int(id as i32);
                e.float(duration.as_secs_f32() * 1000.0);
            }
            MountItem::ShaderInput { id } => {
                e.int(SHADER_INPUT);
                e.int(id as i32);
            }
            MountItem::NavShader { id, shader } => {
                // Java learns whether the page or dialog has one; the layer
                // waits in the renderer until it comes or goes.
                e.int(NAV_SHADER);
                e.int(id as i32);
                e.bool(shader.is_some());
                e.animation.push(MountItem::NavShader { id, shader });
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
                let i = b.scrollbar_inset;
                e.float(i.top.0);
                e.float(i.right.0);
                e.float(i.bottom.0);
                e.float(i.left.0);
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
                    Command::ClearSelection => e.int(62),
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
                    Command::Evaluate { request, script } => {
                        e.int(51);
                        e.int(request as i32);
                        e.string(web_generation.to_string());
                        let key = format!("__nsh_evaluation_{id}_{request}");
                        e.string(nsh_core::platform::web_evaluation::start_script(&script, &key));
                        e.string(nsh_core::platform::web_evaluation::poll_script(&key));
                        e.string(nsh_core::platform::web_evaluation::cleanup_script(&key));
                    }
                    Command::CancelEvaluate { request } => {
                        e.int(52);
                        e.int(request as i32);
                    }
                    Command::InjectJavaScript(js) => {
                        e.int(8);
                        e.string(js);
                    }
                    Command::PostMessage(data) => {
                        e.int(9);
                        e.string(data);
                    }
                    // `WebBox.load`: the URL, then the headers' count and
                    // each name and value.
                    Command::Load(load) => {
                        e.int(46);
                        e.string(load.src);
                        e.int(load.headers.len() as i32);
                        for (name, value) in load.headers {
                            e.string(name);
                            e.string(value);
                        }
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
                        // Unbox first: moving `buttons` and then `input` out of
                        // a `Box` is not a disjoint move.
                        let d = *d;
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
                        // The text field (`SystemUi.dialog`): an alert's only.
                        match d.input {
                            Some(input) if !d.sheet => {
                                e.bool(true);
                                e.string(input.text);
                                e.opt_string(input.placeholder.as_deref());
                                e.bool(input.select_all);
                                e.bool(input.required);
                            }
                            _ => e.bool(false),
                        }
                    }
                    Command::CloseDialog(dialog) => {
                        e.int(60);
                        e.int(dialog as i32);
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
                    // `Mounter.textLocale`: the language tag.
                    Command::TextLocale(locale) => {
                        e.int(64);
                        e.string(locale.as_str().to_owned());
                    }
                    Command::AccessibilityFocus => e.int(18),
                    // `InputBox.openEditMenu`: the bounds in the root view,
                    // then the actions' bits (cut 1, copy 2, paste 4,
                    // select all 8).
                    Command::OpenEditMenu { bounds, actions } => {
                        e.int(49);
                        e.float(bounds.origin.x.0);
                        e.float(bounds.origin.y.0);
                        e.float(bounds.size.width.0);
                        e.float(bounds.size.height.0);
                        e.int(actions.iter().fold(0, |bits, action| {
                            bits | match action {
                                EditAction::Cut => 1,
                                EditAction::Copy => 2,
                                EditAction::Paste => 4,
                                EditAction::SelectAll => 8,
                                _ => 0,
                            }
                        }));
                    }
                    Command::CloseEditMenu => e.int(50),
                    // `Mounter.haptic` reads the haptic in this order.
                    // API levels of the constants it maps to: CONFIRM /
                    // REJECT from 30 (else VIRTUAL_KEY / LONG_PRESS),
                    // SEGMENT_TICK from 34 (else CLOCK_TICK for selection).
                    Command::Haptic(haptic) => {
                        use nsh_core::{Haptic, HapticImpact, HapticNotification};
                        e.int(48);
                        e.int(match haptic {
                            Haptic::Selection => 0,
                            Haptic::Impact(HapticImpact::Light) => 1,
                            Haptic::Impact(HapticImpact::Medium) => 2,
                            Haptic::Impact(HapticImpact::Heavy) => 3,
                            Haptic::Impact(HapticImpact::Soft) => 4,
                            Haptic::Impact(HapticImpact::Rigid) => 5,
                            Haptic::Notification(HapticNotification::Success) => 6,
                            Haptic::Notification(HapticNotification::Warning) => 7,
                            Haptic::Notification(HapticNotification::Error) => 8,
                            // `Haptic*` are non-exhaustive; Mounter ignores.
                            _ => -1,
                        });
                    }
                    // `Mounter.orientations` reads the `ModalConfig`
                    // bits (0: the app's own).
                    Command::Orientations(bits) => {
                        e.int(54);
                        e.int(i32::from(bits));
                    }
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
                    Command::SetClipboardItem(item) => match item.html {
                        Some(html) => {
                            e.int(56);
                            e.string(item.text);
                            e.string(html);
                        }
                        None => {
                            e.int(22);
                            e.string(item.text);
                        }
                    },
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
                    // `SystemUi.java` `openAppSettings`: the request.
                    Command::OpenAppSettings { id } => {
                        e.int(63);
                        e.int(id as i32);
                    }
                    // `Share.java`: the request, the title and the text
                    // (the text and the URL on lines of their own), each
                    // after whether it is there, then the files. Android's
                    // sheet is no popover: the anchor is not sent.
                    Command::Share { id, sheet } => {
                        e.int(58);
                        e.int(id as i32);
                        e.bool(sheet.title.is_some());
                        e.string(sheet.title.clone().unwrap_or_default());
                        let text = sheet.combined_text();
                        e.bool(text.is_some());
                        e.string(text.unwrap_or_default());
                        e.int(sheet.files.len() as i32);
                        for file in sheet.files {
                            e.string(file);
                        }
                    }
                    // `AuthSession.java`: the request, the page, the callback
                    // scheme and whether it is ephemeral.
                    Command::AuthSession { id, page } => {
                        e.int(59);
                        e.int(id as i32);
                        e.string(page.url);
                        e.string(page.callback_scheme);
                        e.bool(page.ephemeral);
                    }
                    // `AuthSession.java`: the request the app closed.
                    Command::CloseAuthSession(id) => {
                        e.int(61);
                        e.int(id as i32);
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
                    // `Picker.java`: the request, the limit, the extensions
                    // offered (comma-separated; empty: any file) and the
                    // largest file read (at most 512 MiB: an `int`).
                    Command::PickFiles { id, request } => {
                        e.int(45);
                        e.int(id as i32);
                        e.int(request.limit as i32);
                        e.string(nsh_core::file_dialog::extensions(&request.filters).join(","));
                        e.int(i32::try_from(request.size_limit()).unwrap_or(i32::MAX));
                    }
                    // Turned into a mount item / `ScrollTo` by the core.
                    Command::LayoutAnimation(_)
                    | Command::SetStatusBar(_)
                    | Command::CancelPress
                    | Command::ScrollToIndex { .. }
                    | Command::Reveal(_)
                    | Command::Measure { .. }
                    | Command::MeasureScrollPosition { .. }
                    | Command::ScrollToEnd { .. }
                    // Desktops only.
                    | Command::Desktop(_)
                    // The app's address: Android keeps none (App Links only
                    // come in).
                    | Command::SetAppUrl(_)
                    | Command::PushAppUrl(_)
                    // No host answers `nsh/host` here (`Environment::host`):
                    // the core rejects the calls first.
                    | Command::HostCall { .. }
                    | Command::HostPost { .. }
                    // No desktop web view controls (`Environment::webview_requests`):
                    // the core answers these first.
                    | Command::WebViewRequest(_)
                    // No eyedropper (`Environment::screen_color`): the core
                    // answers no color first.
                    | Command::PickScreenColor { .. } => e.int(-1),
                    // Not carried out on Android yet: the app's paste is
                    // lost, so say so.
                    Command::InsertText(_) => {
                        log::warn!("insertText is not supported on Android yet; nothing inserted");
                        e.int(-1);
                    }
                    // `SystemUi.openPath`: the file at the path, a `content:`
                    // URI the app's FilesProvider serves, to the system's
                    // viewer (`ACTION_VIEW`); open dialogs use `Picker.java`
                    // to copy provider streams into app-owned paths.
                    Command::FileRequest { id, request } => match *request {
                        nsh_core::file_dialog::FileRequest::OpenDialog(dialog) => {
                            e.int(57);
                            e.int(id as i32);
                            e.bool(dialog.multiple);
                            e.bool(dialog.kind == nsh_core::file_dialog::OpenDialogKind::Folders);
                            e.string(nsh_core::file_dialog::extensions(&dialog.filters).join(","));
                        }
                        nsh_core::file_dialog::FileRequest::OpenPath(path) => {
                            e.int(28);
                            e.int(id as i32);
                            e.string(path.to_string_lossy().into_owned());
                        }
                        // Every other file request has no Android
                        // implementation. The environment says file
                        // requests exist, so the core waits for an answer:
                        // fail it now (op 30), or the call would hang.
                        _ => {
                            e.int(30);
                            e.int(id as i32);
                        }
                    },
                    // `CanvasRender.java` (`Mounter`'s op 55): the request,
                    // the size in pixels, the scale, the format (0: PNG),
                    // then the drawing as `CANVAS` carries it.
                    Command::RenderCanvas {
                        id,
                        drawing,
                        width,
                        height,
                        scale,
                        format,
                    } => {
                        e.int(55);
                        e.int(id as i32);
                        e.int(width as i32);
                        e.int(height as i32);
                        e.float(scale);
                        e.int(match format {
                            nsh_core::canvas::render::ImageFormat::Png => 0,
                            // `CanvasRender.encode` answers an error for a
                            // format it does not encode.
                            _ => -1,
                        });
                        canvas(&mut e, &drawing);
                    }
                    // Trusted web view input is macOS's for now.
                    | Command::SendInput(_)
                    // No performance monitor on Android yet.
                    | Command::PerfMonitor(_)
                    | Command::PerfMonitorMode(_) => e.int(-1),
                    // `Audio.java`: the sub-opcode, then the command's
                    // fields (see `audio_command`).
                    Command::Audio(command) => {
                        e.int(47);
                        audio_command(&mut e, command);
                    }
                    Command::Notification(command) => {
                        use nsh_core::notifications::NotificationCommand as N;
                        e.int(44);
                        match command {
                            N::Permission { id, ask } => {
                                e.int(0);
                                e.int(id as i32);
                                e.bool(ask);
                            }
                            N::Show { id, notification } => {
                                let sound = notification
                                    .sound_path()
                                    .map(nsh_core::notifications::Notification::sound_resource_name)
                                    .unwrap_or_default();
                                e.int(1);
                                e.int(id as i32);
                                e.string(notification.id);
                                e.string(notification.title);
                                e.string(notification.body);
                                e.bool(notification.silent);
                                // The app's sound as a raw resource name, "" for none.
                                e.string(sound);
                            }
                            N::Close(id) => {
                                e.int(2);
                                e.string(id);
                            }
                            N::Listen => e.int(3),
                            N::SetBadge(count) => {
                                e.int(4);
                                e.int(count as i32);
                            }
                            N::CloseAll => e.int(5),
                            _ => e.int(-1),
                        }
                    }
                    // `SystemUi.dialog` draws alerts and action sheets in
                    // them: each of `DIALOG_TOKENS`, light then dark (0: the
                    // system's). An app without a theme of its own (its
                    // tokens the default theme's) keeps the system's colors.
                    Command::Tokens(tokens) => {
                        e.int(27);
                        let themed = nsh_base::tokens_of(None).is_ok_and(|d| *tokens != d);
                        for name in DIALOG_TOKENS {
                            let color = tokens.color(name).filter(|_| themed);
                            for c in [color.map(|c| c.light), color.map(|c| c.dark)] {
                                e.int(c.map_or(0, |c| argb(c.into())));
                            }
                        }
                    }
                }
            }
        }
    }
    e
}

/// The tokens alerts and action sheets are drawn in (`SystemUi.java`'s
/// order): the dialog, its title, its message, its buttons and a
/// destructive action.
const DIALOG_TOKENS: [&str; 5] = [
    "popover",
    "popover-foreground",
    "muted-foreground",
    "primary",
    "destructive",
];

/// An audio command after its opcode (47), as `Audio.command` reads it:
/// 0 load (id, bytes, hint, max duration in ms), 1 load from a URL (id),
/// 2 play (id, volume, rate), 3 stop (id), 4 unload (id), 5 open (id, src,
/// volume, rate, loop), 6 preload (id), 7 resume (id), 8 pause (id), 9 seek
/// (id, ms), 10 set (id, volume, rate, loop), 11 close (id).
fn audio_command(e: &mut Encoded, command: AudioCommand) {
    let ms = |d: std::time::Duration| d.as_millis().min(i32::MAX as u128) as i32;
    match command {
        AudioCommand::Load {
            id,
            bytes,
            hint,
            max_duration,
        } => {
            e.int(0);
            e.int(id as i32);
            let index = e.objects.len() as i32;
            e.objects.push(Obj::Bytes(bytes));
            e.int(index);
            e.string(hint);
            e.int(ms(max_duration));
        }
        AudioCommand::LoadUrl { id, .. } => {
            e.int(1);
            e.int(id as i32);
        }
        AudioCommand::Play { id, volume, rate } => {
            e.int(2);
            e.int(id as i32);
            e.float(volume);
            e.float(rate);
        }
        AudioCommand::Stop { id } => {
            e.int(3);
            e.int(id as i32);
        }
        AudioCommand::Unload { id } => {
            e.int(4);
            e.int(id as i32);
        }
        AudioCommand::Open { id, src, settings } => {
            e.int(5);
            e.int(id as i32);
            e.string(src);
            e.float(settings.volume);
            e.float(settings.rate);
            e.bool(settings.looped);
        }
        AudioCommand::Preload { id } => {
            e.int(6);
            e.int(id as i32);
        }
        AudioCommand::Resume { id } => {
            e.int(7);
            e.int(id as i32);
        }
        AudioCommand::Pause { id } => {
            e.int(8);
            e.int(id as i32);
        }
        AudioCommand::Seek { id, position } => {
            e.int(9);
            e.int(id as i32);
            e.int(ms(position));
        }
        AudioCommand::Set { id, settings } => {
            e.int(10);
            e.int(id as i32);
            e.float(settings.volume);
            e.float(settings.rate);
            e.bool(settings.looped);
        }
        AudioCommand::Close { id } => {
            e.int(11);
            e.int(id as i32);
        }
        // A command a newer core adds: nothing to do here.
        _ => e.int(-1),
    }
}

/// The event kind with index `index` (`EventKind as u8`, the order of the
/// constants in `Native.java`).
/// `selectionMenu` (Mounter.java `selectionMenu`): the count, then per
/// item its id (-1 a separator), whether it is enabled and its label.
fn selection_menu(e: &mut Encoded, items: &[nsh_core::desktop::MenuItem]) {
    use nsh_core::desktop::MenuItem;
    let items: Vec<_> = items
        .iter()
        .filter(|item| !matches!(item, MenuItem::Submenu { .. }))
        .collect();
    e.int(items.len() as i32);
    for item in items {
        match item {
            MenuItem::Action(action) => {
                e.int(action.id as i32);
                e.bool(action.enabled);
                e.string(action.label.clone());
            }
            _ => {
                e.int(-1);
                e.bool(false);
                e.int(-1);
            }
        }
    }
}

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
    // `clipPath`: whether there is one, then each edge's offset (points)
    // and fraction (top, right, bottom, left), then the radii from the top
    // left (`Mounter.style`).
    let clip = s.clip_path();
    e.bool(clip.is_some());
    let clip = clip.copied().unwrap_or_default();
    for v in clip.offsets.to_array() {
        e.float(v.0);
    }
    for v in clip.fractions.to_array() {
        e.float(v.0);
    }
    for v in clip.radii.to_array() {
        e.float(v.0);
    }
    effects(e, s);
}

/// An angle in the degrees `Decor.java` takes, rounded to 1e-4 so that
/// whole degrees go as the style wrote them (radians to degrees in `f32`
/// can be an ulp off).
fn degrees(a: nsh_core::geometry::Radians) -> f32 {
    (a.to_degrees() * 1e4).round() / 1e4
}

/// A list of gradients, as `Effects.java`'s `gradients` reads it.
fn gradients(e: &mut Encoded, gradients: &[nsh_core::Gradient]) {
    use nsh_core::{
        GradientKind, GradientSize,
        geometry::{DefiniteLength, REM_SIZE, Size},
    };

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
}

/// The effects of `Mounter.java` `style`: shadows, gradients, filters,
/// blend mode, outline, visibility, cursor, transition, animation.
fn effects(e: &mut Encoded, s: &ViewStyle) {
    use nsh_core::{BlendMode, Cursor, Filter, Keyframes};
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
    gradients(e, fx.map_or(&[][..], |f| &f.background_images[..]));
    gradients(e, fx.map_or(&[][..], |f| &f.mask_images[..]));
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
        Cursor::NwseResize => 17,
        Cursor::NeswResize => 18,
    });
    // The duration a spring takes to settle; then the curve: 0 a cubic
    // Bézier's control points, 1 a spring's stiffness, damping and mass.
    match s.transition.filter(|t| t.run_ms() > 0.0) {
        Some(t) => {
            e.int(t.properties.0 as i32);
            e.float(t.run_ms());
            e.float(t.delay);
            let (curve, values) = match t.spring {
                Some(spring) => (1, [spring.stiffness, spring.damping, spring.mass, 0.0]),
                None => (0, t.easing),
            };
            e.int(curve);
            for v in values {
                e.float(v);
            }
        }
        None => {
            e.int(0);
            e.float(0.0);
            e.float(0.0);
            e.int(0);
            for _ in 0..4 {
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
            e.bool(w.incognito);
            e.bool(w.zoomable);
            // Its one written form, which `Native.allowsWebview` reads back.
            let origin = w.allow_origin.as_ref().map(ToString::to_string);
            e.opt_string(origin.as_deref());
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
    e.int(match c.title_align {
        HeaderTitleAlign::Left => 0,
        HeaderTitleAlign::Center => 1,
    });
    e.bool(c.hides_bottom_bar_when_pushed);
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
    // The hint text: the description, then the hint (Android has no
    // description of its own beside the label).
    e.opt_string(a.help_text(None).as_deref());
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
    match s.pressed {
        Some(Checked::False) => flags |= 256,
        Some(Checked::True) => flags |= 256 | 512,
        Some(Checked::Mixed) => flags |= 256 | 1024,
        None => {}
    }
    // The current item's kind, in bits 11 to 13 (`A11yChanges.java`
    // `CURRENT_DESCRIPTIONS`).
    flags |= match s.current {
        None => 0,
        Some(AccessibilityCurrent::True) => 1,
        Some(AccessibilityCurrent::Page) => 2,
        Some(AccessibilityCurrent::Step) => 3,
        Some(AccessibilityCurrent::Location) => 4,
        Some(AccessibilityCurrent::Date) => 5,
        Some(AccessibilityCurrent::Time) => 6,
    } << 11;
    if s.invalid {
        flags |= 1 << 14;
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
    e.opt_string(p.native_id.as_deref());
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
            // The way it activates in and its edge (Mounter.java
            // `panActivation`): -1 none.
            e.int(match a.way() {
                Some(PanDirection::Left) => 0,
                Some(PanDirection::Right) => 1,
                Some(PanDirection::Up) => 2,
                Some(PanDirection::Down) => 3,
                _ => -1,
            });
            e.int(match a.edge {
                Some(PanEdge::Left) => 0,
                Some(PanEdge::Right) => 1,
                Some(PanEdge::Top) => 2,
                Some(PanEdge::Bottom) => 3,
                _ => -1,
            });
        }
        None => e.int(0),
    }
    e.bool(p.selectable_view);
    e.bool(p.continues_text);
    selection_menu(e, &p.selection_menu);
    key_capture(e, &p.key_capture);
    // `focusable` (Mounter.java `focusProps`): -1 unset, 0 false, 1 true.
    e.int(match p.focusable {
        None => -1,
        Some(false) => 0,
        Some(true) => 1,
    });
    // `key_parent` (Mounter.java `keyParents`): a portaled view's logical
    // keyboard ancestor; -1 leaves the native/mounted parent.
    e.int(p.key_parent.map_or(-1, |parent| parent as i32));
}

/// `Mounter.java` `viewProps`: the focused view's `captureKeys` policy, as
/// `KeyCaptures.java` matches it (mode, and for `keys` the count and each
/// canonical key id and its modifiers). A view's policy changes with its
/// other props; the UI thread keeps the latest.
fn key_capture(e: &mut Encoded, capture: &KeyCapture) {
    match capture {
        KeyCapture::None => e.int(0),
        KeyCapture::All => e.int(1),
        KeyCapture::Keys(keys) => {
            e.int(2);
            e.int(keys.len() as i32);
            for key in keys.iter() {
                e.int(crate::keymap::capture_key(key.key));
                e.int(crate::keymap::capture_modifiers(key.modifiers));
            }
        }
        // A future rule this Android runtime does not know captures none.
        _ => e.int(0),
    }
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
        Group => 36,
        Region => 37,
        Navigation => 38,
        Tree => 39,
        TreeItem => 40,
        MenuItemCheckbox => 41,
        MenuItemRadio => 42,
        Dialog => 43,
        AlertDialog => 44,
        Textbox => 45,
        TabPanel => 46,
    }
}

/// The intervals a physical spring's progress is sampled in for Java's interpolator.
const SPRING_SAMPLES: usize = 64;

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
        LayoutCurve::FittedSpring { damping_ratio } => (4, damping_ratio),
        LayoutCurve::Keyboard => (5, 0.0),
        LayoutCurve::Spring(_) => (6, 0.0),
        LayoutCurve::Bezier(_) => (7, 0.0),
    };
    e.int(curve);
    e.float(damping);
    if let LayoutCurve::Spring(spring) = t.curve {
        // The spring's progress, sampled evenly over the time it settles in: Java draws it
        // piecewise linear (`Mounter.Transition`), so the physics stays in Rust.
        e.int(SPRING_SAMPLES as i32 + 1);
        for i in 0..=SPRING_SAMPLES {
            e.float(if i == SPRING_SAMPLES {
                1.0
            } else {
                spring.progress(spring.settle_ms() * i as f32 / SPRING_SAMPLES as f32)
            });
        }
    }
    if let LayoutCurve::Bezier(points) = t.curve {
        // Java's `PathInterpolator` of the same control points.
        for p in points {
            e.float(p);
        }
    }
    e.int(match t.property {
        LayoutProperty::Opacity => 0,
        LayoutProperty::Scale => 1,
    });
    e.float(t.run_ms());
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
    e.int(crate::text::encode_align(c.align));
    e.string(c.placeholder.clone());
    e.bool(c.placeholder_color.is_some());
    e.int(c.placeholder_color.map_or(0, argb));
    e.bool(c.secure);
    e.int(match c.keyboard {
        // A password shown as plain text gets the visible password keyboard.
        KeyboardType::Default if c.visible_password() => 8,
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
    e.bool(c.select_text_on_focus);
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
    // `pasteMaxSize` in bytes (-1: none); a Java array holds at most
    // `i32::MAX` bytes, so a larger limit reads what the heap holds.
    e.int(
        c.paste_max_size
            .map_or(-1, |max| max.min(i32::MAX as u64) as i32),
    );
    // A multiline input's own scroll bar shows; whether it reports how far
    // its text scrolled (a bar of the app's follows it).
    e.bool(c.scrollbar_visible);
    e.bool(c.report_scroll);
    e.int(s.font_variant.0 as i32);
}

// --- Canvas drawings (`CanvasPainter.java`) ---------------------------------
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
                // A missing size is the source's pixels over this many
                // points, never the screen's density.
                e.float(image.density());
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

#[cfg(test)]
mod tests {
    use nsh_core::file_dialog::{self, FileRequest};

    use super::*;

    /// A text box is the edit text class, after the roles `A11y.java`
    /// already names.
    #[test]
    fn a_textbox_follows_the_roles_a11y_java_names() {
        assert_eq!(
            role_index(AccessibilityRole::Textbox),
            role_index(AccessibilityRole::AlertDialog) + 1
        );
    }

    /// `drawImage(uri, 1, 2)` encoded for `CanvasPainter.java`: the URI,
    /// no source, the source's four floats, the file name's density, then
    /// the destination with its missing size NaN.
    #[test]
    fn a_canvas_image_carries_its_file_name_s_density() {
        use nsh_core::canvas::{CanvasImage, CanvasOp, Drawing, Num};
        let nan = Num::Const(f32::NAN);
        for (uri, density) in [("asset:/dot.png", 1.0), ("asset:/dot@3x.png", 3.0)] {
            let drawing = Drawing {
                ops: vec![CanvasOp::DrawImage {
                    image: CanvasImage { uri: uri.into() },
                    source: None,
                    dest: [Num::Const(1.0), Num::Const(2.0), nan, nan],
                }],
                ..Drawing::default()
            };
            let mut e = Encoded::default();
            canvas(&mut e, &drawing);
            let words: Vec<u32> = e
                .bytes
                .as_chunks::<4>()
                .0
                .iter()
                .map(|chunk| u32::from_le_bytes(*chunk))
                .collect();
            // The word count, the code, the URI's object, no source.
            assert_eq!(&words[..4], &[12, 42, 0, 0]);
            let floats: Vec<f32> = words[4..].iter().map(|w| f32::from_bits(*w)).collect();
            assert_eq!(&floats[..7], &[0.0, 0.0, 0.0, 0.0, density, 1.0, 2.0]);
            assert!(floats[7].is_nan() && floats[8].is_nan());
            assert_eq!(floats.len(), 9);
        }
    }

    /// The ints a batch of one file request is encoded as.
    fn ints(request: FileRequest) -> Vec<i32> {
        let batch = MountBatch {
            items: vec![MountItem::Command {
                id: 3,
                command: Command::FileRequest {
                    id: 7,
                    request: Box::new(request),
                },
            }],
        };
        encode(batch, 0)
            .bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| i32::from_le_bytes(*chunk))
            .collect()
    }

    #[test]
    fn open_requests_are_sent_and_the_other_file_requests_fail() {
        // `COMMAND`, the view id, op 28, the request id, the path's
        // object index: `Mounter.java` opens the file and answers.
        assert_eq!(
            ints(FileRequest::OpenPath("/data/user/0/app/files/a.pdf".into())),
            vec![COMMAND, 3, 28, 7, 0]
        );

        assert_eq!(
            ints(FileRequest::OpenDialog(file_dialog::OpenDialog::files())),
            vec![COMMAND, 3, 57, 7, 0, 0, 0]
        );
        assert_eq!(
            ints(FileRequest::OpenDialog(
                file_dialog::OpenDialog::folders().multiple(true)
            )),
            vec![COMMAND, 3, 57, 7, 1, 1, 0]
        );
        // `Environment::file_requests` is set, so the core waits for an
        // answer to every request: op 30 fails the rest instead of leaving
        // `pick_save_path`, `reveal_path` and `move_to_trash`
        // pending forever.
        for request in [
            FileRequest::SaveDialog(file_dialog::SaveDialog::default()),
            FileRequest::RevealPath("a".into()),
            FileRequest::MoveToTrash("a".into()),
        ] {
            assert_eq!(ints(request), vec![COMMAND, 3, 30, 7]);
        }
    }
    #[test]
    fn a_canvas_render_carries_its_size_scale_and_drawing() {
        use nsh_core::canvas::{CanvasOp, Drawing, Num, render::ImageFormat};

        let drawing = Drawing {
            ops: vec![CanvasOp::FillRect([
                Num::Const(1.0),
                Num::Const(2.0),
                Num::Const(3.0),
                Num::Const(4.0),
            ])],
            ..Drawing::default()
        };
        let batch = MountBatch {
            items: vec![MountItem::Command {
                id: nsh_core::ROOT_ID,
                command: Command::RenderCanvas {
                    id: 9,
                    drawing: std::sync::Arc::new(drawing),
                    width: 60,
                    height: 40,
                    scale: 2.0,
                    format: ImageFormat::Png,
                },
            }],
        };
        let ints: Vec<i32> = encode(batch, 0)
            .bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| i32::from_le_bytes(*chunk))
            .collect();
        // `COMMAND`, the root, op 55 (`Mounter.java`), the request, the
        // pixel size, the scale's bits, PNG, then `CANVAS`'s words: their
        // count and fillRect (21) with its four numbers.
        let f = |v: f32| v.to_bits() as i32;
        assert_eq!(
            ints,
            vec![
                COMMAND,
                nsh_core::ROOT_ID as i32,
                55,
                9,
                60,
                40,
                f(2.0),
                0,
                5,
                21,
                f(1.0),
                f(2.0),
                f(3.0),
                f(4.0),
            ]
        );
    }

    #[test]
    fn web_evaluations_carry_the_originating_engine_generation() {
        let encoded = encode(
            MountBatch {
                items: vec![MountItem::Command {
                    id: 3,
                    command: Command::Evaluate {
                        request: u32::MAX,
                        script: "42".into(),
                    },
                }],
            },
            19,
        );
        let ints: Vec<_> = encoded
            .bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| i32::from_le_bytes(*chunk))
            .collect();
        assert_eq!(ints, vec![COMMAND, 3, 51, -1, 0, 1, 2, 3]);
        assert!(matches!(&encoded.objects[0], Obj::Str(generation) if generation == "19"));
    }
    #[test]
    fn view_props_carry_the_key_capture_policy() {
        use nsh_core::keymap::{Key, Keystroke, Modifiers};

        let props = ViewProps {
            key_capture: KeyCapture::keys([
                Keystroke {
                    key: Key::Char('a'),
                    modifiers: Modifiers::default(),
                },
                Keystroke {
                    key: Key::Left,
                    modifiers: Modifiers {
                        shift: true,
                        ..Modifiers::default()
                    },
                },
            ]),
            ..ViewProps::default()
        };
        let encoded = encode(
            MountBatch {
                items: vec![MountItem::ViewProps {
                    id: 2,
                    props: Box::new(props),
                }],
            },
            0,
        );
        let ints: Vec<_> = encoded
            .bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| i32::from_le_bytes(*chunk))
            .collect();
        // The tail `Mounter.java` reads: mode, count, (key, modifiers)*,
        // `focusable` (-1 unset), then `key_parent` (-1 none).
        assert_eq!(
            &ints[ints.len() - 8..],
            &[
                2,
                2,
                'a' as i32,
                0,
                crate::keymap::capture_key(Key::Left),
                4,
                -1,
                -1
            ]
        );

        for (focusable, expected) in [(None, -1), (Some(false), 0), (Some(true), 1)] {
            let props = ViewProps {
                focusable,
                ..ViewProps::default()
            };
            let encoded = encode(
                MountBatch {
                    items: vec![MountItem::ViewProps {
                        id: 2,
                        props: Box::new(props),
                    }],
                },
                0,
            );
            let ints: Vec<_> = encoded
                .bytes
                .as_chunks::<4>()
                .0
                .iter()
                .map(|chunk| i32::from_le_bytes(*chunk))
                .collect();
            assert_eq!(ints[ints.len() - 2], expected);
            assert_eq!(ints[ints.len() - 1], -1);
        }

        let props = ViewProps {
            key_parent: Some(7),
            ..ViewProps::default()
        };
        let encoded = encode(
            MountBatch {
                items: vec![MountItem::ViewProps {
                    id: 2,
                    props: Box::new(props),
                }],
            },
            0,
        );
        let ints: Vec<_> = encoded
            .bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| i32::from_le_bytes(*chunk))
            .collect();
        assert_eq!(ints[ints.len() - 1], 7);
    }

    #[test]
    fn inputs_carry_text_layout_align_letter_spacing_and_font_variant() {
        use nsh_core::{FontVariant, InputConfig, Points, ResolvedTextStyle, TextAlign};

        let config = InputConfig {
            style: ResolvedTextStyle {
                letter_spacing: Points(2.5),
                font_variant: FontVariant(FontVariant::TABULAR_NUMS | FontVariant::SMALL_CAPS),
                ..ResolvedTextStyle::default()
            },
            ..InputConfig::default()
        };
        let ints_for = |cfg: InputConfig| {
            let encoded = encode(
                MountBatch {
                    items: vec![MountItem::Input {
                        id: 5,
                        config: Box::new(cfg),
                    }],
                },
                0,
            );
            encoded
                .bytes
                .as_chunks::<4>()
                .0
                .iter()
                .map(|chunk| i32::from_le_bytes(*chunk))
                .collect::<Vec<_>>()
        };

        // Distinct alignment codes match `TextLayouts.ALIGN_*` (`0..=4`).
        let encoded_aligns: Vec<i32> = [
            TextAlign::Auto,
            TextAlign::Left,
            TextAlign::Center,
            TextAlign::Right,
            TextAlign::Justify,
        ]
        .into_iter()
        .map(|align| {
            let mut cfg = config.clone();
            cfg.align = align;
            ints_for(cfg)[8]
        })
        .collect();
        assert_eq!(encoded_aligns, [0, 1, 2, 3, 4]);

        let with_variant = ints_for(config.clone());
        assert_eq!(with_variant[7], 2.5f32.to_bits() as i32);
        assert_eq!(
            *with_variant.last().unwrap(),
            (FontVariant::TABULAR_NUMS | FontVariant::SMALL_CAPS) as i32
        );

        let mut reset = config;
        reset.style.letter_spacing = Points(0.0);
        reset.style.font_variant = FontVariant(0);
        let reset_ints = ints_for(reset);
        assert_eq!(reset_ints[7], 0.0f32.to_bits() as i32);
        assert_eq!(*reset_ints.last().unwrap(), 0);
    }
}
