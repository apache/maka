/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! The Workbar's terminal, as `maka-desktop`'s `TerminalState` and
//! `Terminal`: a VT emulator (alacritty's) per terminal, retained across
//! renders, drawn on a cell grid ported from maka-gpui's terminal.
//!
//! The script owns everything that talks to the Host: it reads the Host's
//! screen, follows the output, holds the controller and sends input. This
//! side never decodes or sends anything itself. `feed` hands the Host's
//! base64 straight to a background parser, so a stream of output costs the
//! script one call per event and the window one frame per batch; the view
//! turns keys, the IME's text, pastes and mouse reports into the Host's
//! input actions and reports them with `on_event`, for the script to send
//! with `control`. The Host answers the program's queries (cursor position,
//! device attributes) itself, so the emulator's replies are dropped.
//!
//! A retained state lives as long as the script's application, so a
//! terminal the script is done with is `close`d: that ends its parser and
//! lets its emulator and scrollback go.

mod box_drawing;
mod element;
mod emulator;
mod grid;
mod input;
mod palette;
mod view;

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use gpui_shell::gpui::{
    AnyElement, App, AppContext as _, Entity, ParentElement as _, Styled as _, Subscription,
    Window, div,
};
use gpui_shell::{
    ArgumentDescriptor, ArgumentSchema, ComponentArgument, ComponentCallback, ComponentDataValue,
    ComponentDescriptor, ComponentMaterializer, ComponentPayload, ComponentRegistry,
    ConstructorDescriptor, MaterializeRequest, MethodDescriptor, RegistryError, StateDescriptor,
    StateMethodDescriptor, anyhow,
};

use emulator::{GridSize, Snapshot};
use palette::TerminalPalette;
use view::{Options, TerminalEvent, TerminalView};

pub(crate) use view::init;

/// What a `TerminalState` holds: the view, what the element's methods set
/// on it, and the script's event callback, which each render replaces.
#[derive(Clone)]
struct TerminalHandle {
    view: Entity<TerminalView>,
    options: Rc<Cell<Options>>,
    listener: Rc<RefCell<Option<ComponentCallback>>>,
    _events: Rc<Subscription>,
}

impl TerminalHandle {
    fn new(window: &mut Window, cx: &mut App) -> Self {
        let options = Rc::new(Cell::new(Options::default()));
        let view = cx.new(|cx| TerminalView::new(options.clone(), window, cx));
        let listener = Rc::new(RefCell::new(None::<ComponentCallback>));
        let slot = listener.clone();
        // Events arrive after the view's update, so the script is never
        // called while the view is borrowed and may call back into it.
        let events = window.subscribe(&view, cx, move |_, event: &TerminalEvent, window, cx| {
            let listener = slot.borrow().clone();
            let Some(listener) = listener else { return };
            if let Err(error) = listener.invoke_data_with(&[event_data(event)], window, cx) {
                // A terminal the script no longer renders keeps the callback
                // of its last render: what it reports then has nobody to go
                // to.
                let error = format!("{error:#}");
                if !error.contains("superseded render") {
                    eprintln!("maka-terminal: the event callback failed: {error}");
                }
            }
        });
        Self {
            view,
            options,
            listener,
            _events: Rc::new(events),
        }
    }
}

/// An event as the script's `on_event` callback receives it.
fn event_data(event: &TerminalEvent) -> ComponentDataValue {
    let kind = |kind: &str| ("kind".to_owned(), ComponentDataValue::String(kind.into()));
    ComponentDataValue::Object(match event {
        TerminalEvent::Input(actions) => vec![
            kind("input"),
            (
                "actions".into(),
                ComponentDataValue::Array(actions.iter().map(|action| action.to_data()).collect()),
            ),
        ],
        TerminalEvent::Resize(size) => vec![
            kind("resize"),
            ("cols".into(), ComponentDataValue::Number(size.cols.into())),
            ("rows".into(), ComponentDataValue::Number(size.rows.into())),
        ],
        TerminalEvent::Activate => vec![kind("activate")],
        TerminalEvent::Scrolled { at_bottom } => vec![
            kind("scrolled"),
            ("atBottom".into(), ComponentDataValue::Boolean(*at_bottom)),
        ],
    })
}

fn string<'a>(value: &'a ComponentDataValue, what: &str) -> anyhow::Result<&'a str> {
    match value {
        ComponentDataValue::String(value) => Ok(value),
        _ => anyhow::bail!("{what} expects text"),
    }
}

/// A whole number from `min` to `max`.
fn whole(value: &ComponentDataValue, min: u16, max: u16) -> Option<u16> {
    match value {
        ComponentDataValue::Number(value)
            if value.is_finite()
                && value.fract() == 0.
                && (f64::from(min)..=f64::from(max)).contains(value) =>
        {
            Some(*value as u16)
        }
        _ => None,
    }
}

/// A grid size from the script, within what the Host's `TerminalSize`
/// allows (2–240 columns, 1–100 rows); anything else is refused, as the
/// Host refuses it, rather than handed to the emulator.
fn grid_size(
    cols: &ComponentDataValue,
    rows: &ComponentDataValue,
    what: &str,
) -> anyhow::Result<GridSize> {
    let (Some(cols), Some(rows)) = (
        whole(cols, GridSize::MIN_COLS, GridSize::MAX_COLS),
        whole(rows, GridSize::MIN_ROWS, GridSize::MAX_ROWS),
    ) else {
        anyhow::bail!(
            "{what} expects {}–{} columns and {}–{} rows",
            GridSize::MIN_COLS,
            GridSize::MAX_COLS,
            GridSize::MIN_ROWS,
            GridSize::MAX_ROWS
        );
    };
    Ok(GridSize::new(cols, rows))
}

fn field<'a>(
    fields: &'a [(String, ComponentDataValue)],
    name: &str,
) -> Option<&'a ComponentDataValue> {
    fields
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value))
}

/// The Host's `read` output (`screen`, `scrollback`, `cols`, `rows`,
/// `cursor`, `alternateScreen`), as the snapshot to paint.
fn snapshot(value: &ComponentDataValue) -> anyhow::Result<Snapshot> {
    let ComponentDataValue::Object(fields) = value else {
        anyhow::bail!("paint expects the Host's screen");
    };
    let text = |name: &str| match field(fields, name) {
        Some(ComponentDataValue::String(text)) => Ok(text.clone()),
        None | Some(ComponentDataValue::Null) => Ok(String::new()),
        _ => anyhow::bail!("paint expects `{name}` as text"),
    };
    let number = |fields: &[(String, ComponentDataValue)], name: &str| match field(fields, name) {
        Some(ComponentDataValue::Number(value)) if value.is_finite() && *value >= 0. => {
            Ok(value.min(f64::from(u16::MAX)) as u16)
        }
        _ => anyhow::bail!("paint expects `{name}` as a number"),
    };
    let cursor = match field(fields, "cursor") {
        Some(ComponentDataValue::Object(cursor)) => cursor.as_slice(),
        _ => anyhow::bail!("paint expects a `cursor`"),
    };
    let (Some(cols), Some(rows)) = (field(fields, "cols"), field(fields, "rows")) else {
        anyhow::bail!("paint expects `cols` and `rows`");
    };
    Ok(Snapshot {
        size: grid_size(cols, rows, "paint")?,
        screen: text("screen")?,
        scrollback: text("scrollback")?,
        cursor: (number(cursor, "x")?, number(cursor, "y")?),
        cursor_visible: !matches!(
            field(cursor, "visible"),
            Some(ComponentDataValue::Boolean(false))
        ),
        alternate_screen: matches!(
            field(fields, "alternateScreen"),
            Some(ComponentDataValue::Boolean(true))
        ),
    })
}

fn state_method(
    name: &'static str,
    signature: &'static str,
    call: impl Fn(&TerminalHandle, &[ComponentDataValue], &mut Window, &mut App) -> anyhow::Result<()>
    + Send
    + Sync
    + 'static,
) -> StateMethodDescriptor {
    StateMethodDescriptor::new::<TerminalHandle>(
        name,
        signature,
        move |handle, args, window, cx| {
            call(handle, args, window, cx).map(|()| ComponentDataValue::Null)
        },
    )
}

fn state_methods() -> Vec<StateMethodDescriptor> {
    vec![
        state_method(
            "feed",
            "(dataBase64: string): void",
            |handle, args, _, cx| {
                let [data] = args else {
                    anyhow::bail!("feed expects the Host's dataBase64");
                };
                let data = string(data, "feed")?.to_owned();
                handle.view.read(cx).feed_output(data);
                Ok(())
            },
        ),
        state_method(
            "resize",
            "(cols: number, rows: number): void",
            |handle, args, _, cx| {
                let [cols, rows] = args else {
                    anyhow::bail!("resize expects cols and rows");
                };
                handle
                    .view
                    .read(cx)
                    .resize(grid_size(cols, rows, "resize")?);
                Ok(())
            },
        ),
        state_method(
            "reset",
            "(cols: number, rows: number): void",
            |handle, args, _, cx| {
                let [cols, rows] = args else {
                    anyhow::bail!("reset expects cols and rows");
                };
                let size = grid_size(cols, rows, "reset")?;
                handle.view.update(cx, |view, cx| view.reset(size, cx));
                Ok(())
            },
        ),
        state_method(
            "paint",
            "(screen: { screen: string; scrollback: string; cols: number; rows: number; cursor: { x: number; y: number; visible: boolean } }): void",
            |handle, args, _, cx| {
                let [screen] = args else {
                    anyhow::bail!("paint expects the Host's screen");
                };
                let snapshot = snapshot(screen)?;
                handle.view.update(cx, |view, cx| view.paint(snapshot, cx));
                Ok(())
            },
        ),
        state_method("focus", "(): void", |handle, _, window, cx| {
            handle.view.update(cx, |view, cx| view.focus(window, cx));
            Ok(())
        }),
        state_method("scroll_to_bottom", "(): void", |handle, _, _, cx| {
            handle.view.read(cx).scroll_to_bottom();
            Ok(())
        }),
        state_method("close", "(): void", |handle, _, _, cx| {
            handle.listener.borrow_mut().take();
            handle.view.update(cx, |view, cx| view.close(cx));
            Ok(())
        }),
        StateMethodDescriptor::new::<TerminalHandle>("text", "(): string", |handle, _, _, cx| {
            Ok(ComponentDataValue::String(handle.view.read(cx).text()))
        })
        .with_readonly(true),
    ]
}

/// What the element's methods recorded.
#[derive(Clone)]
enum Op {
    Palette(Box<TerminalPalette>),
    Cursor(bool),
    Controlled(bool),
    OnEvent(ComponentArgument),
}

struct Materializer;

impl ComponentMaterializer for Materializer {
    fn materialize(&self, request: MaterializeRequest<'_>) -> anyhow::Result<AnyElement> {
        let argument = request
            .payload()
            .downcast_ref::<ComponentArgument>()
            .ok_or_else(|| anyhow::anyhow!("Terminal received an incompatible payload"))?
            .clone();
        let handle = request.with_state::<TerminalHandle, _>(&argument, Clone::clone)?;
        let mut options = Options::default();
        let mut listener = None;
        for op in request
            .methods()
            .filter_map(|method| method.payload().downcast_ref::<Op>())
        {
            match op {
                Op::Palette(palette) => options.palette = **palette,
                Op::Cursor(cursor) => options.cursor = *cursor,
                Op::Controlled(held) => options.controlled = *held,
                Op::OnEvent(callback) => listener = Some(request.resolve_callback(callback)?),
            }
        }
        anyhow::ensure!(
            request.children_len() == 0,
            "Terminal does not accept children"
        );
        handle.options.set(options);
        *handle.listener.borrow_mut() = listener;
        request.finish(div().flex().flex_col().child(handle.view))
    }
}

fn palette_method() -> MethodDescriptor {
    MethodDescriptor::new(
        "palette",
        vec![
            ArgumentDescriptor::new("ansi", ArgumentSchema::Array(Box::new(ArgumentSchema::String))),
            ArgumentDescriptor::new("foreground", ArgumentSchema::String),
            ArgumentDescriptor::new("background", ArgumentSchema::String),
            ArgumentDescriptor::new("cursor", ArgumentSchema::String),
            ArgumentDescriptor::new("selection", ArgumentSchema::String),
        ],
        |args| {
            let [
                ComponentArgument::Array(ansi),
                ComponentArgument::String(foreground),
                ComponentArgument::String(background),
                ComponentArgument::String(cursor),
                ComponentArgument::String(selection),
            ] = args
            else {
                return Err(
                    "Terminal.palette expects 16 ANSI colours, foreground, background, cursor and selection"
                        .into(),
                );
            };
            let ansi = ansi
                .iter()
                .map(|colour| match colour {
                    ComponentArgument::String(colour) => Ok(colour.clone()),
                    _ => Err("Terminal.palette expects colours as #rrggbb text".to_owned()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            let palette = TerminalPalette::parse(&ansi, foreground, background, cursor, selection)?;
            Ok(ComponentPayload::new(Op::Palette(Box::new(palette))))
        },
    )
    .with_documentation(
        "Sets the 16 ANSI colours, the default foreground and background, the cursor and the selection, as #rrggbb or #rrggbbaa.",
    )
}

pub(crate) fn register(registry: &mut ComponentRegistry) -> Result<(), RegistryError> {
    registry.register_state(
        StateDescriptor::new(
            "TerminalState",
            "TerminalState",
            Vec::new(),
            |_, window, cx| Ok(Box::new(TerminalHandle::new(window, cx))),
        )
        .with_methods(state_methods())
        .with_documentation(
            "One terminal's emulator and view, retained across renders. `feed` takes the Host's output as it arrives (base64, decoded off the main thread), `paint` the Host's screen; `close` lets it go.",
        ),
    )?;
    registry.register(
        ComponentDescriptor::new("Terminal", Arc::new(Materializer))
            .with_constructors(vec![ConstructorDescriptor::new(
                "Terminal",
                vec![ArgumentDescriptor::new(
                    "state",
                    ArgumentSchema::Entity("TerminalState"),
                )],
                |args| match args {
                    [argument @ ComponentArgument::Entity { .. }] => {
                        Ok(ComponentPayload::new(argument.clone()))
                    }
                    _ => Err("Terminal expects one TerminalState".into()),
                },
            )])
            .with_methods(vec![
                palette_method(),
                MethodDescriptor::new(
                    "cursor",
                    vec![ArgumentDescriptor::new("show", ArgumentSchema::Boolean)],
                    |args| match args {
                        [ComponentArgument::Boolean(show)] => {
                            Ok(ComponentPayload::new(Op::Cursor(*show)))
                        }
                        _ => Err("Terminal.cursor expects a boolean".into()),
                    },
                )
                .with_documentation("Whether to draw the cursor; an ended terminal hides it."),
                MethodDescriptor::new(
                    "controlled",
                    vec![ArgumentDescriptor::new("held", ArgumentSchema::Boolean)],
                    |args| match args {
                        [ComponentArgument::Boolean(held)] => {
                            Ok(ComponentPayload::new(Op::Controlled(*held)))
                        }
                        _ => Err("Terminal.controlled expects a boolean".into()),
                    },
                )
                .with_documentation(
                    "Whether the script holds the terminal's controller. Only then does the mouse go to a program that asked for it, and the wheel and Shift-Page Up/Down to a full-screen one; otherwise a press selects and the wheel scrolls the scrollback. The keyboard's input is reported either way.",
                ),
                MethodDescriptor::new(
                    "on_event",
                    vec![ArgumentDescriptor::new(
                        "listener",
                        ArgumentSchema::Callback(
                            "(event: { kind: 'input'; actions: ({ type: 'text' | 'paste'; text: string } | { type: 'key'; key: string; modifiers: ('ctrl' | 'alt' | 'shift')[] } | { type: 'mouse'; event: 'press' | 'release' | 'move' | 'scroll'; x: number; y: number; button?: 'left' | 'middle' | 'right'; direction?: 'up' | 'down'; modifiers: ('ctrl' | 'alt' | 'shift')[] })[] } | { kind: 'resize'; cols: number; rows: number } | { kind: 'activate' } | { kind: 'scrolled'; atBottom: boolean }, cx: Context) => void",
                        ),
                    )],
                    |args| match args {
                        [callback @ ComponentArgument::Callback(_)] => {
                            Ok(ComponentPayload::new(Op::OnEvent(callback.clone())))
                        }
                        _ => Err("Terminal.on_event expects a listener".into()),
                    },
                )
                .with_documentation(
                    "Reports input as the Host's control actions, the grid the element holds, a press in it, and whether it shows the bottom of the output.",
                ),
            ])
            .with_documentation(
                "A TerminalState's screen and scrollback, drawn in the inherited monospace font. It takes the keyboard when pressed; it accepts no children.",
            ),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(fields: &[(&str, ComponentDataValue)]) -> ComponentDataValue {
        ComponentDataValue::Object(
            fields
                .iter()
                .map(|(key, value)| ((*key).to_owned(), value.clone()))
                .collect(),
        )
    }

    #[test]
    fn the_hosts_screen_is_a_snapshot() {
        let screen = object(&[
            ("screen", ComponentDataValue::String("$ ls\r\na  b".into())),
            ("scrollback", ComponentDataValue::String(String::new())),
            ("cols", ComponentDataValue::Number(80.)),
            ("rows", ComponentDataValue::Number(24.)),
            (
                "cursor",
                object(&[
                    ("x", ComponentDataValue::Number(4.)),
                    ("y", ComponentDataValue::Number(1.)),
                    ("visible", ComponentDataValue::Boolean(false)),
                ]),
            ),
            ("alternateScreen", ComponentDataValue::Boolean(false)),
        ]);
        let painted = snapshot(&screen).unwrap();
        assert_eq!(painted.size, GridSize::new(80, 24));
        assert_eq!(painted.screen, "$ ls\r\na  b");
        assert_eq!(painted.cursor, (4, 1));
        assert!(!painted.cursor_visible);
        assert!(!painted.alternate_screen);
        assert!(snapshot(&ComponentDataValue::Null).is_err());
    }

    #[test]
    fn events_have_the_scripts_shape() {
        assert_eq!(
            event_data(&TerminalEvent::Resize(GridSize::new(100, 30))),
            object(&[
                ("kind", ComponentDataValue::String("resize".into())),
                ("cols", ComponentDataValue::Number(100.)),
                ("rows", ComponentDataValue::Number(30.)),
            ])
        );
        assert_eq!(
            event_data(&TerminalEvent::Scrolled { at_bottom: false }),
            object(&[
                ("kind", ComponentDataValue::String("scrolled".into())),
                ("atBottom", ComponentDataValue::Boolean(false)),
            ])
        );
    }

    #[test]
    fn sizes_outside_the_hosts_range_are_refused() {
        let size = |cols: f64, rows: f64| {
            grid_size(
                &ComponentDataValue::Number(cols),
                &ComponentDataValue::Number(rows),
                "t",
            )
        };
        assert_eq!(size(80., 24.).unwrap(), GridSize::new(80, 24));
        assert_eq!(size(2., 1.).unwrap(), GridSize::new(2, 1));
        assert_eq!(size(240., 100.).unwrap(), GridSize::new(240, 100));
        for (cols, rows) in [
            (1., 24.),
            (0., 24.),
            (241., 24.),
            (1e9, 24.),
            (80., 0.),
            (80., 101.),
            (80.5, 24.),
            (f64::NAN, 24.),
        ] {
            assert!(size(cols, rows).is_err(), "{cols} x {rows}");
        }
        assert!(
            grid_size(
                &ComponentDataValue::String("80".into()),
                &ComponentDataValue::Number(24.),
                "t"
            )
            .is_err()
        );
    }

    #[test]
    fn a_screen_outside_the_hosts_range_is_refused() {
        let screen = |cols: f64| {
            object(&[
                ("screen", ComponentDataValue::String("中".into())),
                ("cols", ComponentDataValue::Number(cols)),
                ("rows", ComponentDataValue::Number(24.)),
                (
                    "cursor",
                    object(&[
                        ("x", ComponentDataValue::Number(0.)),
                        ("y", ComponentDataValue::Number(0.)),
                    ]),
                ),
            ])
        };
        assert!(snapshot(&screen(80.)).is_ok());
        for cols in [0., 1., 241., 1e9] {
            assert!(snapshot(&screen(cols)).is_err(), "{cols} columns");
        }
    }
}
