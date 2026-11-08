//! The terminal's test agent posts work to the view, which executes it after drawing a complete frame.

use std::{sync::Arc, time::Duration};

use crossbeam_channel::{Receiver, Sender};
use nsh_core::{Bounds, NodeId, Point, Points, ROOT_ID, Size, TextEngine, ViewKind};
use nsh_testing::agent::{Key, Model, Native};
use ratatui_core::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier},
};
use serde_json::{Value, json};

use super::AppView;
use crate::{
    Appearance, CellTextEngine, Input, Modifiers, MouseButton, MouseInput, MouseKind,
    geometry::CellBounds, surface::Wake,
};

const REPLY_TIMEOUT: Duration = Duration::from_secs(10);
const CLICK: Duration = Duration::from_millis(60);
const FRAME: Duration = Duration::from_millis(16);

type Request = Box<dyn FnOnce(&mut AppView, &Buffer) + Send>;

pub(super) struct TestSession {
    pub(super) model: Arc<Model>,
    pub(super) inbox: Receiver<Request>,
}

impl TestSession {
    pub(super) fn new(model: Arc<Model>, wake: Arc<Wake>) -> (Self, TuiNative) {
        let (sender, inbox) = crossbeam_channel::unbounded();
        (Self { model, inbox }, TuiNative { sender, wake })
    }
}

pub(super) struct TuiNative {
    sender: Sender<Request>,
    wake: Arc<Wake>,
}

impl TuiNative {
    fn on_view<R: Send + 'static>(
        &self,
        action: impl FnOnce(&mut AppView, &Buffer) -> R + Send + 'static,
    ) -> Result<R, String> {
        let (sender, receiver) = crossbeam_channel::bounded(1);
        self.sender
            .send(Box::new(move |view, buffer| {
                let _ = sender.send(action(view, buffer));
            }))
            .map_err(|_| "the terminal surface is gone".to_owned())?;
        self.wake.notify();
        receiver
            .recv_timeout(REPLY_TIMEOUT)
            .map_err(|_| "the terminal surface did not render".to_owned())
    }

    fn input(&self, input: Input) -> Result<(), String> {
        self.on_view(move |view, _| {
            view.handle(input);
        })
    }

    fn pointer(&self, at: Point<Points>, kind: MouseKind) -> Result<(), String> {
        self.on_view(move |view, _| {
            let cells = view.options.cells;
            let mouse = MouseInput {
                column: (f32::from(view.area.x) + (at.x / cells.width()).floor())
                    .clamp(0.0, f32::from(u16::MAX)) as u16,
                row: (f32::from(view.area.y) + (at.y / cells.height()).floor())
                    .clamp(0.0, f32::from(u16::MAX)) as u16,
                kind,
                ..Default::default()
            };
            view.handle(Input::Mouse(mouse));
        })
    }

    fn click(&self, at: Point<Points>, hold: Duration, button: MouseButton) -> Result<(), String> {
        self.pointer(at, MouseKind::Move)?;
        self.pointer(at, MouseKind::Down(button))?;
        std::thread::sleep(hold);
        self.pointer(at, MouseKind::Up(button))
    }

    fn press_key(&self, key: String, modifiers: Modifiers) -> Result<(), String> {
        self.input(Input::Key {
            key: key.clone(),
            modifiers,
            release: false,
        })?;
        self.input(Input::Key {
            key,
            modifiers,
            release: true,
        })
    }
}

impl Native for TuiNative {
    fn bounds(&self, id: NodeId) -> Option<Bounds<Points>> {
        self.on_view(move |view, _| {
            let bounds = view
                .geometry
                .iter()
                .find(|geometry| geometry.id == id)?
                .bounds;
            let cells = view.options.cells;
            Some(Bounds::new(
                bounds.origin(cells, view.area),
                Size::new(
                    cells.width() * (bounds.right - bounds.left) as f32,
                    cells.height() * (bounds.bottom - bounds.top) as f32,
                ),
            ))
        })
        .ok()
        .flatten()
    }

    fn text_bounds(&self, id: NodeId, start: u32, end: u32) -> Option<Bounds<Points>> {
        self.on_view(move |view, _| {
            let (_, visible) = displayed(view, id)?;
            let (layout, _) = view.tree.get(id)?.text.as_ref()?;
            let mut ranges = Vec::new();
            CellTextEngine::new(view.options.cells).range_rects(layout, start..end, &mut ranges);
            let range = ranges.first()?;
            let content = CellBounds::new(
                view.geometry
                    .iter()
                    .find(|geometry| geometry.id == id)?
                    .text_frame?,
                view.options.cells,
                view.area,
            );
            let range = CellBounds::new(
                Bounds::new(
                    content.origin(view.options.cells, view.area) + range.origin,
                    range.size,
                ),
                view.options.cells,
                view.area,
            )
            .clipped(visible);
            (!range.is_empty()).then(|| points(view, range))
        })
        .ok()
        .flatten()
    }

    fn viewport(&self) -> Size<Points> {
        self.on_view(|view, _| view.size()).unwrap_or_default()
    }

    fn press(&self, at: Point<Points>) {
        let _ = self.click(at, CLICK, MouseButton::Left);
    }

    fn long_press(&self, at: Point<Points>, hold: Duration) {
        let _ = self.click(at, hold, MouseButton::Left);
    }

    fn scroll(&self, at: Point<Points>, delta: Point<Points>) {
        let Ok((x, y)) = self.on_view(move |view, _| {
            let steps = |amount: f32| {
                amount
                    .abs()
                    .ceil()
                    .copysign(amount)
                    .clamp(-32767.0, 32767.0) as i16
            };
            (
                steps(delta.x / (view.options.cells.width() * crate::input::WHEEL_COLUMNS)),
                steps(delta.y / (view.options.cells.height() * crate::input::WHEEL_ROWS)),
            )
        }) else {
            return;
        };
        let count = x.unsigned_abs().max(y.unsigned_abs());
        for step in 0..count {
            let kind = MouseKind::Wheel {
                x: if step < x.unsigned_abs() {
                    x.signum()
                } else {
                    0
                },
                y: if step < y.unsigned_abs() {
                    y.signum()
                } else {
                    0
                },
            };
            if self.pointer(at, kind).is_err() {
                break;
            }
            std::thread::sleep(FRAME);
        }
    }

    fn drag(&self, from: Point<Points>, to: Point<Points>) {
        let _ = self.pointer(from, MouseKind::Move);
        let _ = self.pointer(from, MouseKind::Down(MouseButton::Left));
        std::thread::sleep(nsh_testing::agent::LANDING);
        let mut last = from;
        for at in nsh_testing::agent::drag_path(from, to) {
            std::thread::sleep(FRAME);
            let _ = self.pointer(at, MouseKind::Move);
            last = at;
        }
        let _ = self.pointer(last, MouseKind::Up(MouseButton::Left));
    }

    fn type_text(&self, text: &str) {
        for character in text.chars() {
            let _ = self.press_key(character.to_string(), Modifiers::default());
        }
    }

    fn key(&self, key: Key) {
        let (key, modifiers) = match key {
            Key::Return => ("Enter", Modifiers::default()),
            Key::Backspace => ("Backspace", Modifiers::default()),
            Key::SelectAll => (
                "a",
                Modifiers {
                    ctrl: true,
                    shift: true,
                    ..Default::default()
                },
            ),
        };
        let _ = self.press_key(key.into(), modifiers);
    }

    fn press_keys(&self, keys: &str) -> Result<(), String> {
        let stroke =
            nsh_core::keymap::Keystroke::parse(keys, super::OS).map_err(|e| e.to_string())?;
        let name = match stroke.key {
            nsh_core::keymap::Key::Char(c) => c.to_string(),
            nsh_core::keymap::Key::F(n) => format!("F{n}"),
            key => format!("{key:?}"),
        };
        self.press_key(name, stroke.modifiers)
    }

    fn mouse(&self) -> bool {
        true
    }

    fn hover(&self, at: Point<Points>) -> Result<(), String> {
        self.pointer(at, MouseKind::Move)
    }

    fn right_click(&self, at: Point<Points>) -> Result<(), String> {
        self.click(at, CLICK, MouseButton::Right)
    }

    fn paste(&self, content: &nsh_core::PasteEvent) -> Result<(), String> {
        self.input(Input::Paste(content.text.clone()))
    }

    fn input_text(&self, id: NodeId) -> Option<String> {
        self.on_view(move |view, _| {
            view.tree
                .get(id)?
                .field
                .as_ref()
                .map(|field| field.model.text().to_owned())
        })
        .ok()
        .flatten()
    }

    fn back(&self) -> Result<(), String> {
        self.press_key("Escape".into(), Modifiers::default())
    }

    fn answer_dialog(&self, _button: Option<&str>) -> Result<(), String> {
        Err("terminal system dialogs are not implemented".into())
    }

    fn animating(&self) -> bool {
        self.on_view(|view, _| view.tree.animator.animating())
            .unwrap_or(false)
    }

    fn screenshot(&self) -> Result<Vec<u8>, String> {
        self.on_view(|view, buffer| cell_dump(buffer, view.area))?
    }

    fn resize(&self, _width: Points, _height: Points) -> Result<(), String> {
        Err("set the terminal viewport with open(entry, { width, height })".into())
    }

    fn set_dark(&self, dark: bool) -> Result<(), String> {
        self.on_view(move |view, _| {
            view.set_appearance(if dark {
                Appearance::Dark
            } else {
                Appearance::Light
            });
        })
    }

    fn quit(&self) {
        let _ = self.on_view(|view, _| view.tree.exit = true);
    }
}

// Use the renderer's rounded parent origins and scroll offsets, including ancestors outside the area.
fn displayed(view: &AppView, id: NodeId) -> Option<(Point<Points>, Rect)> {
    let mut ancestors = vec![id];
    let mut node = id;
    while node != ROOT_ID {
        node = view.tree.get(node)?.parent?;
        ancestors.push(node);
    }
    let mut origin = Point::default();
    let mut clip = view.area;
    let mut opacity = 1.0;
    for &node in ancestors.iter().rev() {
        let state = view.tree.get(node)?;
        opacity *= state.style.opacity;
        if state.concealed || state.style.hidden || opacity <= 0.0 {
            return None;
        }
        let bounds = CellBounds::new(
            Bounds::new(origin + state.frame.origin, state.frame.size),
            view.options.cells,
            view.area,
        );
        origin = bounds.origin(view.options.cells, view.area);
        let visible = bounds.clipped(clip);
        if node == id {
            return (!visible.is_empty()).then_some((origin, visible));
        }
        if state.style.overflow_hidden
            || matches!(
                state.kind,
                ViewKind::Scroll | ViewKind::Stack | ViewKind::Screen
            )
        {
            clip = visible;
        }
        origin -= state
            .scroll
            .as_ref()
            .map_or_else(Point::default, |scroll| scroll.origin());
    }
    None
}

fn points(view: &AppView, area: Rect) -> Bounds<Points> {
    let cells = view.options.cells;
    Bounds::new(
        Point::new(
            cells.width() * f32::from(area.x - view.area.x),
            cells.height() * f32::from(area.y - view.area.y),
        ),
        Size::new(
            cells.width() * f32::from(area.width),
            cells.height() * f32::from(area.height),
        ),
    )
}

fn cell_dump(buffer: &Buffer, area: Rect) -> Result<Vec<u8>, String> {
    let area = area.intersection(buffer.area);
    let rows: Vec<Vec<Value>> = (area.y..area.bottom())
        .map(|y| {
            (area.x..area.right())
                .map(|x| {
                    let cell = &buffer[(x, y)];
                    let modifiers: Vec<_> = [
                        (Modifier::BOLD, "bold"),
                        (Modifier::DIM, "dim"),
                        (Modifier::ITALIC, "italic"),
                        (Modifier::UNDERLINED, "underlined"),
                        (Modifier::SLOW_BLINK, "slow_blink"),
                        (Modifier::RAPID_BLINK, "rapid_blink"),
                        (Modifier::REVERSED, "reversed"),
                        (Modifier::HIDDEN, "hidden"),
                        (Modifier::CROSSED_OUT, "crossed_out"),
                    ]
                    .into_iter()
                    .filter_map(|(flag, name)| cell.modifier.contains(flag).then_some(name))
                    .collect();
                    json!({
                        "symbol": cell.symbol(), "fg": color(cell.fg), "bg": color(cell.bg),
                        "underline": color(cell.underline_color), "modifiers": modifiers,
                    })
                })
                .collect()
        })
        .collect();
    serde_json::to_vec(&json!({
        "format": "nsh-tui-cells", "version": 1,
        "width": area.width, "height": area.height, "rows": rows,
    }))
    .map_err(|e| e.to_string())
}

fn color(color: Color) -> String {
    match color {
        Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
        Color::Indexed(index) => format!("indexed:{index}"),
        named => format!("{named:?}").to_ascii_lowercase(),
    }
}
