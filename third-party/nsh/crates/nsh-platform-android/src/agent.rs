//! The platform's part of `nsh test --target android`
//! (`nsh_testing::agent`): where a node's view is, and what a user's
//! finger and keyboard do there, as `MotionEvent`s and `KeyEvent`s the
//! window's views get (`TestAgent.java`, which does each call's work on
//! the main thread and returns when it is done). Java speaks pixels; the
//! agent points (the display's density apart).

use std::{
    sync::Weak,
    time::{Duration, Instant},
};

use jni::{
    JNIEnv,
    objects::{JByteArray, JClass, JFloatArray, JObject, JObjectArray, JString, JValue},
};
use nsh_core::{
    NodeId,
    geometry::{Bounds, Point, Points, Size, point},
};
use nsh_testing::agent::{Key, Native, SystemName};

use crate::{host::Host, java::with_env};

/// A tap's hold, as a quick tap's.
const TAP: Duration = Duration::from_millis(60);
/// A finger's moves, a display frame apart.
const FRAME: Duration = Duration::from_millis(16);
/// How many times a frame a touchscreen reports a moving finger, as the
/// agent's drags and swipes report it.
const SAMPLES: u32 = 4;
/// How far a swiping finger moves in a frame on average, in points.
const MOVE_STEP: f32 = 20.0;
/// How long a finger rests before it lifts at the end of a scroll, so the
/// scroll view keeps no velocity (no fling after it).
const REST: Duration = Duration::from_millis(120);
/// How long a system menu takes to show a submenu's items or to close, at
/// most.
const MENU_MOVES: Duration = Duration::from_secs(2);
/// `MotionEvent.ACTION_*`.
const DOWN: i32 = 0;
const UP: i32 = 1;
const MOVE: i32 = 2;
/// `KeyEvent.KEYCODE_*`, `KeyEvent.META_CTRL_ON`.
const KEYCODE_A: i32 = 29;
const KEYCODE_DEL: i32 = 67;
const KEYCODE_ENTER: i32 = 66;
const META_CTRL_ON: i32 = 0x1000;

/// The view the agent acts on.
pub(crate) struct AndroidNative {
    host: Weak<Host>,
    density: f32,
}

impl AndroidNative {
    pub(crate) fn new(host: Weak<Host>, density: f32) -> Self {
        AndroidNative { host, density }
    }

    /// `f` with the JNI env, `TestAgent`'s class and the `NshView`.
    fn call<R: Default>(
        &self,
        f: impl FnOnce(&mut JNIEnv<'_>, &JClass<'_>, &JObject<'_>) -> jni::errors::Result<R>,
    ) -> R {
        let Some(host) = self.host.upgrade() else {
            return R::default();
        };
        let java = crate::java::java();
        with_env(|env| f(env, java.test_agent.as_obj().into(), host.view.as_obj()))
    }

    fn px(&self, p: f32) -> f32 {
        p * self.density
    }

    fn finger(&self, action: i32, x: f32, y: f32) {
        let (x, y) = (self.px(x), self.px(y));
        self.call(|env, class, view| {
            env.call_static_method(
                class,
                "touch",
                "(Lcom/longbridge/nsh/NshView;IFF)V",
                &[
                    JValue::Object(view),
                    JValue::Int(action),
                    JValue::Float(x),
                    JValue::Float(y),
                ],
            )
            .map(drop)
        });
    }

    fn tap(&self, x: f32, y: f32, hold: Duration) {
        self.finger(DOWN, x, y);
        std::thread::sleep(hold);
        self.finger(UP, x, y);
    }

    /// A finger down at `from`, moving to `to` easing in and out (a finger
    /// starts from rest, and slows down before it stops), reported
    /// [`SAMPLES`] times a frame, resting there (still reporting where it
    /// is), then lifting (a scroll, a swipe). Its first moves stay within
    /// the touch slop: a scroll view that takes the gesture from a view
    /// under the finger (a field, a button) scrolls from the move past the
    /// slop, and what the finger moved before it is lost.
    fn swipe(&self, from: (f32, f32), to: (f32, f32), rest: Duration) {
        let (dx, dy) = (to.0 - from.0, to.1 - from.1);
        let frames = ((dx.abs().max(dy.abs()) / MOVE_STEP).ceil() as u32).max(1);
        let n = frames * SAMPLES;
        let mut xs = vec![self.px(from.0)];
        let mut ys = vec![self.px(from.1)];
        for i in 1..=n {
            let s = i as f32 / n as f32;
            let t = s * s * (3.0 - 2.0 * s);
            xs.push(self.px(from.0 + dx * t));
            ys.push(self.px(from.1 + dy * t));
        }
        let every = FRAME.as_millis() as u32 / SAMPLES;
        for _ in 0..(rest.as_millis() as u32).div_ceil(every) + 1 {
            xs.push(self.px(to.0));
            ys.push(self.px(to.1));
        }
        self.path(&xs, &ys, every);
    }

    /// A finger along (`xs`, `ys`), in pixels: down at the first point, a
    /// move to each next one `every` milliseconds apart, up at the last;
    /// one call that the UI thread paces, as the display paces a real
    /// finger's events.
    fn path(&self, xs: &[f32], ys: &[f32], every: u32) {
        self.call(|env, class, view| {
            let jx = env.new_float_array(xs.len() as i32)?;
            env.set_float_array_region(&jx, 0, xs)?;
            let jy = env.new_float_array(ys.len() as i32)?;
            env.set_float_array_region(&jy, 0, ys)?;
            env.call_static_method(
                class,
                "drag",
                "(Lcom/longbridge/nsh/NshView;[F[FI)V",
                &[
                    JValue::Object(view),
                    JValue::Object(&jx),
                    JValue::Object(&jy),
                    JValue::Int(every as i32),
                ],
            )
            .map(drop)
        });
    }

    /// The focused input a paste goes to: its node, whether it listens to
    /// `onPaste`, whether a paste inserts its text.
    fn paste_target(&self) -> Option<(NodeId, bool, bool)> {
        self.call(|env, class, view| {
            let a = env
                .call_static_method(
                    class,
                    "pasteTarget",
                    "(Lcom/longbridge/nsh/NshView;)[I",
                    &[JValue::Object(view)],
                )?
                .l()?;
            if a.is_null() {
                return Ok(None);
            }
            let mut v = [0i32; 3];
            env.get_int_array_region(jni::objects::JIntArray::from(a), 0, &mut v)?;
            Ok(Some((v[0] as NodeId, v[1] != 0, v[2] != 0)))
        })
    }

    /// Whether a system menu is open: false once the app is gone.
    fn menu_open(&self) -> bool {
        self.call(|env, class, _| env.call_static_method(class, "menuOpen", "()Z", &[])?.z())
    }

    /// The middle of the open system menu's row labelled `label`, in the
    /// menu's window (pixels).
    fn menu_item_point(&self, label: &str) -> Option<(f32, f32)> {
        self.call(|env, class, _| {
            let label = env.new_string(label)?;
            let array = env
                .call_static_method(
                    class,
                    "menuItemPoint",
                    "(Ljava/lang/String;)[F",
                    &[JValue::Object(&label)],
                )?
                .l()?;
            if array.is_null() {
                return Ok(None);
            }
            let mut at = [0.0f32; 2];
            env.get_float_array_region(JFloatArray::from(array), 0, &mut at)?;
            Ok(Some((at[0], at[1])))
        })
    }

    /// The labels of the open system menu's rows.
    fn menu_labels(&self) -> Vec<String> {
        self.call(|env, class, _| {
            let array = env
                .call_static_method(class, "menuLabels", "()[Ljava/lang/String;", &[])?
                .l()?;
            let array = JObjectArray::from(array);
            let mut labels = Vec::new();
            for i in 0..env.get_array_length(&array)? {
                let label = env.get_object_array_element(&array, i)?;
                labels.push(env.get_string(&JString::from(label))?.into());
            }
            Ok(labels)
        })
    }

    /// A finger's `action` at (`x`, `y`) in the open system menu's window
    /// (pixels).
    fn menu_touch(&self, action: i32, x: f32, y: f32) -> Result<(), String> {
        let done = self.call(|env, class, _| {
            env.call_static_method(
                class,
                "menuTouch",
                "(IFF)Z",
                &[JValue::Int(action), JValue::Float(x), JValue::Float(y)],
            )?
            .z()
        });
        if done {
            Ok(())
        } else {
            Err("the menu closed".into())
        }
    }

    /// Waits for the system menu to go after it was `done`.
    fn menu_closed(&self, done: &str) -> Result<(), String> {
        let since = Instant::now();
        while self.menu_open() {
            if since.elapsed() > MENU_MOVES {
                return Err(format!(
                    "the menu stays open after it was {done} (a disabled item?)"
                ));
            }
            std::thread::sleep(FRAME * 4);
        }
        Ok(())
    }

    fn floats(&self, method: &str, sig: &str, id: Option<NodeId>) -> Option<Vec<f32>> {
        self.call(|env, class, view| {
            let mut args = vec![JValue::Object(view)];
            if let Some(id) = id {
                args.push(JValue::Int(id as i32));
            }
            let array = env.call_static_method(class, method, sig, &args)?.l()?;
            if array.is_null() {
                return Ok(None);
            }
            let array = JFloatArray::from(array);
            let mut out = vec![0.0; env.get_array_length(&array)? as usize];
            env.get_float_array_region(&array, 0, &mut out)?;
            Ok(Some(out))
        })
    }
}

impl Native for AndroidNative {
    fn bounds(&self, id: NodeId) -> Option<Bounds<Points>> {
        let b = self.floats("bounds", "(Lcom/longbridge/nsh/NshView;I)[F", Some(id))?;
        let d = self.density;
        Some(Bounds::new(
            point(Points(b[0] / d), Points(b[1] / d)),
            Size::new(Points(b[2] / d), Points(b[3] / d)),
        ))
    }

    fn scroll_room(&self, id: NodeId, horizontal: bool) -> Option<(Points, Points)> {
        let room = self.floats("scrollRoom", "(Lcom/longbridge/nsh/NshView;I)[F", Some(id))?;
        let at = if horizontal { 0 } else { 2 };
        Some((
            Points(room[at] / self.density),
            Points(room[at + 1] / self.density),
        ))
    }

    fn text_bounds(&self, text: NodeId, start: u32, end: u32) -> Option<Bounds<Points>> {
        let b = self.call(|env, class, view| {
            let array = env
                .call_static_method(
                    class,
                    "textBounds",
                    "(Lcom/longbridge/nsh/NshView;III)[F",
                    &[
                        JValue::Object(view),
                        JValue::Int(text as i32),
                        JValue::Int(start as i32),
                        JValue::Int(end as i32),
                    ],
                )?
                .l()?;
            if array.is_null() {
                return Ok(None);
            }
            let array = JFloatArray::from(array);
            let mut out = [0.0; 4];
            env.get_float_array_region(&array, 0, &mut out)?;
            Ok(Some(out))
        })?;
        let d = self.density;
        Some(Bounds::new(
            point(Points(b[0] / d), Points(b[1] / d)),
            Size::new(Points(b[2] / d), Points(b[3] / d)),
        ))
    }

    fn viewport(&self) -> Size<Points> {
        let v = self
            .floats("viewport", "(Lcom/longbridge/nsh/NshView;)[F", None)
            .unwrap_or_else(|| vec![0.0, 0.0]);
        Size::new(Points(v[0] / self.density), Points(v[1] / self.density))
    }

    fn press(&self, at: Point<Points>) {
        self.tap(at.x.0, at.y.0, TAP);
    }

    fn long_press(&self, at: Point<Points>, hold: Duration) {
        self.tap(at.x.0, at.y.0, hold);
    }

    fn scroll(&self, at: Point<Points>, delta: Point<Points>) {
        // The content moves towards its end as the finger moves the other
        // way.
        let from = (at.x.0, at.y.0);
        self.swipe(from, (from.0 - delta.x.0, from.1 - delta.y.0), REST);
    }

    fn drag(
        &self,
        from: Point<Points>,
        to: Point<Points>,
        options: nsh_testing::DragOptions,
    ) -> Result<(), String> {
        // A touchscreen samples a finger several times a frame: its first
        // moves stay within the touch slop, so the views under it decide
        // who takes the drag as they do for a real one.
        let frame = FRAME.as_millis() as u32;
        let (mut xs, mut ys) = (vec![self.px(from.x.0)], vec![self.px(from.y.0)]);
        // Resting where it landed (for `options.hold`), still reported.
        let hold = options.hold.unwrap_or(nsh_testing::agent::LANDING);
        let landing = hold.as_millis() as u32 / (frame / SAMPLES);
        for _ in 0..landing {
            xs.push(self.px(from.x.0));
            ys.push(self.px(from.y.0));
        }
        let mut last = from;
        for at in nsh_testing::agent::drag_path(from, to) {
            for i in 1..=SAMPLES {
                let t = i as f32 / SAMPLES as f32;
                xs.push(self.px(last.x.0 + (at.x.0 - last.x.0) * t));
                ys.push(self.px(last.y.0 + (at.y.0 - last.y.0) * t));
            }
            last = at;
        }
        // The last move reaches the end, and the finger lifts there.
        xs.push(self.px(to.x.0));
        ys.push(self.px(to.y.0));
        self.path(&xs, &ys, frame / SAMPLES);
        Ok(())
    }

    fn type_text(&self, text: &str) {
        for ch in text.chars() {
            let s = ch.to_string();
            self.call(|env, class, view| {
                let s = env.new_string(&s)?;
                env.call_static_method(
                    class,
                    "type",
                    "(Lcom/longbridge/nsh/NshView;Ljava/lang/String;)V",
                    &[JValue::Object(view), JValue::Object(&s)],
                )
                .map(drop)
            });
        }
    }

    fn key(&self, key: Key) {
        let (code, meta) = match key {
            Key::Return => (KEYCODE_ENTER, 0),
            Key::Backspace => (KEYCODE_DEL, 0),
            Key::SelectAll => (KEYCODE_A, META_CTRL_ON),
        };
        self.call(|env, class, view| {
            env.call_static_method(
                class,
                "key",
                "(Lcom/longbridge/nsh/NshView;II)V",
                &[JValue::Object(view), JValue::Int(code), JValue::Int(meta)],
            )
            .map(drop)
        });
    }

    fn press_keys(&self, keys: &str) -> Result<(), String> {
        use nsh_core::keymap::Keystroke;
        let stroke =
            Keystroke::parse(keys, nsh_core::platform::Os::Android).map_err(|e| e.to_string())?;
        let code = stroke
            .key
            .android_keycode()
            .ok_or_else(|| format!("an Android keyboard has no key {keys:?}"))?;
        // `KeyEvent.META_*_ON`.
        let m = stroke.modifiers;
        let meta = [
            (m.shift, 0x1),
            (m.alt, 0x2),
            (m.ctrl, META_CTRL_ON),
            (m.cmd, 0x10000),
        ]
        .into_iter()
        .filter(|(on, _)| *on)
        .fold(0, |meta, (_, bit)| meta | bit);
        if self.host.upgrade().is_none() {
            return Err("the app is gone".into());
        }
        self.call(|env, class, view| {
            env.call_static_method(
                class,
                "pressKeys",
                "(Lcom/longbridge/nsh/NshView;II)V",
                &[JValue::Object(view), JValue::Int(code), JValue::Int(meta)],
            )
            .map(drop)
        });
        Ok(())
    }

    fn input_text(&self, id: NodeId) -> Option<String> {
        self.call(|env, class, view| {
            let s = env
                .call_static_method(
                    class,
                    "inputText",
                    "(Lcom/longbridge/nsh/NshView;I)Ljava/lang/String;",
                    &[JValue::Object(view), JValue::Int(id as i32)],
                )?
                .l()?;
            if s.is_null() {
                return Ok(None);
            }
            Ok(Some(env.get_string(&JString::from(s))?.into()))
        })
    }

    fn back(&self) -> Result<(), String> {
        let done = self.call(|env, class, view| {
            env.call_static_method(
                class,
                "back",
                "(Lcom/longbridge/nsh/NshView;)Z",
                &[JValue::Object(view)],
            )?
            .z()
        });
        if done {
            Ok(())
        } else {
            Err("the activity is gone".into())
        }
    }

    fn answer_dialog(&self, button: Option<&str>) -> Result<(), String> {
        let Some(text) = button else {
            // Closing it without a button is the back button's.
            return self.back();
        };
        let at = self.call(|env, class, _| {
            let s = env.new_string(text)?;
            let array = env
                .call_static_method(
                    class,
                    "dialogPoint",
                    "(Ljava/lang/String;)[F",
                    &[JValue::Object(&s)],
                )?
                .l()?;
            if array.is_null() {
                return Ok(None);
            }
            let array = JFloatArray::from(array);
            let mut out = [0.0f32; 2];
            env.get_float_array_region(&array, 0, &mut out)?;
            Ok(Some(out))
        });
        let [x, y] = at.ok_or_else(|| format!("the dialog has no button {text:?}"))?;
        self.tap(x / self.density, y / self.density, TAP);
        Ok(())
    }

    fn system_control(&self, name: SystemName<'_>) -> Option<Bounds<Points>> {
        let (test_id, label) = match name {
            SystemName::TestId(id) => (Some(id), None),
            SystemName::Label(label) => (None, Some(label)),
            _ => return None,
        };
        let b = self.call(|env, class, view| {
            let test_id = match test_id {
                Some(id) => JObject::from(env.new_string(id)?),
                None => JObject::null(),
            };
            let label = match label {
                Some(label) => JObject::from(env.new_string(label)?),
                None => JObject::null(),
            };
            let array = env
                .call_static_method(
                    class,
                    "systemControl",
                    "(Lcom/longbridge/nsh/NshView;Ljava/lang/String;Ljava/lang/String;)[F",
                    &[
                        JValue::Object(view),
                        JValue::Object(&test_id),
                        JValue::Object(&label),
                    ],
                )?
                .l()?;
            if array.is_null() {
                return Ok(None);
            }
            let mut out = [0.0f32; 4];
            env.get_float_array_region(JFloatArray::from(array), 0, &mut out)?;
            Ok(Some(out))
        })?;
        let d = self.density;
        Some(Bounds::new(
            point(Points(b[0] / d), Points(b[1] / d)),
            Size::new(Points(b[2] / d), Points(b[3] / d)),
        ))
    }

    fn system_menu_open(&self) -> bool {
        self.menu_open()
    }

    fn choose_menu_item(&self, path: &[String]) -> Result<(), String> {
        for label in path {
            // A submenu's items show in place of its menu's once it opens;
            // a menu that opens slides in: tapped once its row stays put.
            let since = Instant::now();
            let mut last = None;
            let (x, y) = loop {
                let at = self.menu_item_point(label);
                if let Some(at) = at
                    && last == Some(at)
                {
                    break at;
                }
                if at.is_some() {
                    last = at;
                    std::thread::sleep(FRAME * 4);
                    continue;
                }
                last = None;
                if !self.menu_open() {
                    return Err(format!("the menu closed before it showed {label:?}"));
                }
                if since.elapsed() > MENU_MOVES {
                    return Err(format!(
                        "the menu has no item {label:?}; it shows: {}",
                        self.menu_labels().join(", ")
                    ));
                }
                std::thread::sleep(FRAME * 4);
            };
            self.menu_touch(DOWN, x, y)?;
            std::thread::sleep(TAP);
            self.menu_touch(UP, x, y)?;
        }
        self.menu_closed("chosen")
    }

    fn close_menu(&self) -> Result<(), String> {
        let done =
            self.call(|env, class, _| env.call_static_method(class, "closeMenu", "()Z", &[])?.z());
        if !done {
            return Err("no context menu is open".into());
        }
        self.menu_closed("closed")
    }

    fn animating(&self) -> bool {
        if self.host.upgrade().is_some_and(|h| h.animating()) {
            return true;
        }
        self.call(|env, class, view| {
            env.call_static_method(
                class,
                "animating",
                "(Lcom/longbridge/nsh/NshView;)Z",
                &[JValue::Object(view)],
            )?
            .z()
        })
    }

    fn screenshot(&self) -> Result<Vec<u8>, String> {
        let png = self.call(|env, class, view| {
            let bytes = env
                .call_static_method(
                    class,
                    "screenshot",
                    "(Lcom/longbridge/nsh/NshView;)[B",
                    &[JValue::Object(view)],
                )?
                .l()?;
            if bytes.is_null() {
                return Ok(None);
            }
            Ok(Some(env.convert_byte_array(JByteArray::from(bytes))?))
        });
        png.ok_or_else(|| "the window drew no picture".into())
    }

    fn focused(&self) -> Option<NodeId> {
        self.paste_target().map(|(id, _, _)| id)
    }

    fn paste(&self, content: &nsh_core::PasteEvent) -> Result<(), String> {
        // As the user's paste of `content` does (`InputBox.pasted`), without
        // the system's clipboard: reported, then its text inserted in place
        // of the selection while `pasteBehavior` inserts it.
        let host = self.host.upgrade().ok_or("the app is gone")?;
        let (id, listens, inserts) = self
            .paste_target()
            .ok_or("no focused input to paste into")?;
        if listens && let Some(control) = host.control() {
            control.dispatch_event(
                id,
                nsh_core::EventKind::Paste,
                nsh_core::EventPayload::Paste(Box::new(content.clone())),
            );
        }
        if inserts && !content.text.is_empty() {
            let text = content.text.clone();
            let done = self.call(|env, class, view| {
                let s = env.new_string(&text)?;
                env.call_static_method(
                    class,
                    "insertPaste",
                    "(Lcom/longbridge/nsh/NshView;ILjava/lang/String;)Z",
                    &[
                        JValue::Object(view),
                        JValue::Int(id as i32),
                        JValue::Object(&s),
                    ],
                )?
                .z()
            });
            if !done {
                return Err("the focused input is gone".into());
            }
        }
        Ok(())
    }

    fn drag_and_hold(
        &self,
        from: Point<Points>,
        to: Point<Points>,
        options: nsh_testing::DragOptions,
    ) -> Result<(), String> {
        if self.host.upgrade().is_none() {
            return Err("the app is gone".into());
        }
        // The finger stays down at `to` until `drop_at`.
        self.finger(DOWN, from.x.0, from.y.0);
        std::thread::sleep(options.hold.unwrap_or(nsh_testing::agent::LANDING));
        let mut last = from;
        for at in nsh_testing::agent::drag_path(from, to) {
            for i in 1..=SAMPLES {
                let t = i as f32 / SAMPLES as f32;
                self.finger(
                    MOVE,
                    last.x.0 + (at.x.0 - last.x.0) * t,
                    last.y.0 + (at.y.0 - last.y.0) * t,
                );
                std::thread::sleep(FRAME / SAMPLES);
            }
            last = at;
        }
        self.finger(MOVE, to.x.0, to.y.0);
        Ok(())
    }

    fn drop_at(&self, at: Point<Points>) -> Result<(), String> {
        if self.host.upgrade().is_none() {
            return Err("the app is gone".into());
        }
        self.finger(MOVE, at.x.0, at.y.0);
        std::thread::sleep(FRAME);
        self.finger(UP, at.x.0, at.y.0);
        Ok(())
    }

    fn drop_files(&self, at: Point<Points>, uris: Vec<String>) -> Result<(), String> {
        if self.host.upgrade().is_none() {
            return Err("the app is gone".into());
        }
        let (x, y) = (self.px(at.x.0), self.px(at.y.0));
        let dropped = self.call(|env, class, view| {
            let list =
                env.new_object_array(uris.len() as i32, "java/lang/String", JObject::null())?;
            for (i, uri) in uris.iter().enumerate() {
                let s = env.new_string(uri)?;
                env.set_object_array_element(&list, i as i32, s)?;
            }
            env.call_static_method(
                class,
                "dropFiles",
                "(Lcom/longbridge/nsh/NshView;FF[Ljava/lang/String;)Z",
                &[
                    JValue::Object(view),
                    JValue::Float(x),
                    JValue::Float(y),
                    JValue::Object(&list),
                ],
            )?
            .z()
        });
        if dropped {
            Ok(())
        } else {
            Err("no view there listens to `onFileDrop`".into())
        }
    }

    fn resize(&self, _: Points, _: Points) -> Result<(), String> {
        Err("a device's screen keeps its size".into())
    }

    fn set_dark(&self, _: bool) -> Result<(), String> {
        // The system's appearance is the device's, which `nsh test`
        // switches (`cmd uimode night`).
        Err("the device's settings switch its appearance".into())
    }

    fn quit(&self) {
        // The test's side stops the app (`am force-stop`).
    }
}
