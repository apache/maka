//! Terminal components supplied by the embedding app (`nsh/native`).
//!
//! Each mounted leaf receives a fresh component from its surface's registry.
//! Components render into the same Ratatui buffer as Native Shell, at their
//! position in the paint order, and take terminal input while focused or hit.
//! Props, commands and input return events for that leaf: the surface sends
//! them through the shared engine's existing native-event protocol. No engine
//! or process-wide state is needed by a component.

use std::{collections::BTreeMap, sync::Arc};

use crossterm::event::Event;
use nsh_core::{Bounds, EventPayload, JsonValue, Points, Size};
use ratatui::{buffer::Buffer, layout::Rect as CellRect};

use crate::CellMetrics;

/// Geometry and focus of a terminal component for one paint or input event.
///
/// Point coordinates are relative to the Native Shell surface. Cell
/// coordinates are relative to the destination buffer, including the origin
/// supplied by the embedding app. The frame can extend outside its clip;
/// components draw only inside [`Self::clip_area`] and the buffer's area.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ComponentContext {
    /// The component's complete frame, in shared layout points.
    pub frame: Bounds<Points>,
    /// The visible part of the frame after ancestor and surface clipping.
    pub clip: Bounds<Points>,
    /// The component's frame projected into addressable destination cells.
    ///
    /// When the frame starts outside the surface, this rectangle begins at
    /// the surface edge. Use `frame` for the original point coordinates.
    pub area: CellRect,
    /// The visible terminal cells the component can paint into.
    pub clip_area: CellRect,
    /// The relationship between terminal cells and shared layout points.
    pub metrics: CellMetrics,
    /// Whether the surface has assigned keyboard focus to this leaf.
    pub focused: bool,
}

/// An event emitted by a host component to its `on<Name>` handler.
#[derive(Debug, Clone, PartialEq)]
pub struct ComponentEvent {
    /// The declared native event's name, such as `change`.
    pub name: String,
    /// The JSON data delivered to the handler.
    pub data: JsonValue,
}

impl ComponentEvent {
    /// Creates an event with JSON data for the component's app.
    pub fn new(name: impl Into<String>, data: JsonValue) -> Self {
        Self {
            name: name.into(),
            data,
        }
    }
}

impl From<ComponentEvent> for EventPayload {
    fn from(event: ComponentEvent) -> Self {
        EventPayload::Native {
            name: event.name.into(),
            data: event.data,
        }
    }
}

/// Effects of a prop update, command or terminal input event.
///
/// The surface delivers every emitted event to this component's node. For
/// terminal input, `handled` also prevents the surface's ordinary input
/// handling. A default response leaves the event available to that handling.
#[derive(Debug, Default)]
pub struct ComponentResponse {
    /// Whether a terminal input event was consumed by the component.
    pub handled: bool,
    /// Native events to send to the app, in order.
    pub events: Vec<ComponentEvent>,
}

impl ComponentResponse {
    /// Consumes terminal input without emitting an app event.
    pub fn handled() -> Self {
        Self {
            handled: true,
            events: Vec::new(),
        }
    }

    /// Emits one app event and consumes the terminal input that caused it.
    pub fn event(name: impl Into<String>, data: JsonValue) -> Self {
        Self {
            handled: true,
            events: vec![ComponentEvent::new(name, data)],
        }
    }
}

/// A terminal component the embedding app places in a Native Shell layout.
///
/// Components use their own Rust state, Ratatui widgets or buffer drawing.
/// The surface applies props and commands in mount order before rendering.
/// Each factory invocation makes an independent component; dropping its node
/// drops that instance. Hosts drive redraws through the embedding app's usual
/// terminal loop, so rendering can borrow component state without mutation.
pub trait NativeComponent {
    /// Paints the component inside `context.clip_area`.
    ///
    /// The buffer can cover other content owned by the embedding app. Respect
    /// both the clip area and the buffer's area, including at wide grapheme
    /// boundaries; Ratatui widgets can render into their intersection.
    fn render(&self, context: &ComponentContext, buffer: &mut Buffer);

    /// Updates an app prop; `None` removes it.
    ///
    /// All initial props arrive immediately after the factory creates the
    /// instance. Only changed props arrive afterward.
    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) -> ComponentResponse {
        let _ = (name, value);
        ComponentResponse::default()
    }

    /// Handles the app's `ref.command(name, args)` call.
    fn command(&mut self, name: &str, args: &JsonValue) -> ComponentResponse {
        let _ = (name, args);
        ComponentResponse::default()
    }

    /// Handles terminal input while focused or while the pointer hits it.
    ///
    /// Mouse events retain the terminal's cell coordinates. Use `context.area`
    /// to locate them within this component. Return `handled: true` to consume
    /// the event, and emit native events to notify the app afterward.
    fn handle_event(&mut self, event: &Event, context: &ComponentContext) -> ComponentResponse {
        let _ = (event, context);
        ComponentResponse::default()
    }

    /// Whether this component participates in keyboard focus traversal.
    fn focusable(&self) -> bool {
        false
    }

    /// Natural size in shared layout points, for dimensions left open by style.
    ///
    /// It may change after props, commands or input. Both dimensions must be
    /// finite and positive; `None` leaves measurement to the app's style.
    fn intrinsic_size(&self) -> Option<Size<Points>> {
        None
    }
}

/// Creates an independent terminal component for a mounted native leaf.
pub type ComponentFactory = Arc<dyn Fn() -> Box<dyn NativeComponent> + Send + Sync>;

/// The terminal component factories available to one app or surface.
///
/// A clone copies registrations and shares only their immutable factory
/// closures. Registering or replacing a name affects this registry's future
/// instances. Existing component instances keep their state until unmounted.
#[derive(Clone, Default)]
pub struct Components {
    factories: BTreeMap<Arc<str>, ComponentFactory>,
}

impl std::fmt::Debug for Components {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_set().entries(self.factories.keys()).finish()
    }
}

impl Components {
    /// Registers a factory by the app's `nativeComponent` name.
    ///
    /// Registering an existing name replaces its factory for future leaves. Names
    /// under `nsh/` are NSH's own: registering one logs a warning and changes nothing.
    pub fn register(
        &mut self,
        name: &str,
        factory: impl Fn() -> Box<dyn NativeComponent> + Send + Sync + 'static,
    ) {
        if nsh_core::platform::is_reserved_component(name) {
            log::warn!("native component `{name}` is not registered: names under `nsh/` are NSH's");
            return;
        }
        self.factories.insert(Arc::from(name), Arc::new(factory));
    }

    /// Instantiates the named component, if the host registered it.
    pub(crate) fn create(&self, name: &str) -> Option<Box<dyn NativeComponent>> {
        self.factories.get(name).map(|factory| factory())
    }
}

#[cfg(test)]
mod tests {
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use nsh_core::{Point, geometry::px};
    use serde_json::json;

    use super::*;

    #[derive(Default)]
    struct Counter {
        value: i64,
    }

    impl NativeComponent for Counter {
        fn render(&self, context: &ComponentContext, buffer: &mut Buffer) {
            let area = context.clip_area.intersection(buffer.area);
            if !area.is_empty() {
                buffer.set_stringn(
                    area.x,
                    area.y,
                    self.value.to_string(),
                    area.width as usize,
                    ratatui::style::Style::default(),
                );
            }
        }

        fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) -> ComponentResponse {
            if name == "value" {
                self.value = value.and_then(JsonValue::as_i64).unwrap_or_default();
            }
            ComponentResponse::default()
        }

        fn command(&mut self, name: &str, args: &JsonValue) -> ComponentResponse {
            if name == "add" {
                self.value += args.as_i64().unwrap_or_default();
                return ComponentResponse::event("change", json!({ "value": self.value }));
            }
            ComponentResponse::default()
        }

        fn handle_event(&mut self, event: &Event, _: &ComponentContext) -> ComponentResponse {
            if let Event::Key(key) = event
                && key.code == KeyCode::Enter
            {
                return self.command("add", &json!(1));
            }
            ComponentResponse::default()
        }

        fn focusable(&self) -> bool {
            true
        }

        fn intrinsic_size(&self) -> Option<Size<Points>> {
            Some(Size::new(px(32.0), px(16.0)))
        }
    }

    fn context() -> ComponentContext {
        ComponentContext {
            frame: Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(32.0), px(16.0))),
            clip: Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(32.0), px(16.0))),
            area: CellRect::new(3, 2, 4, 1),
            clip_area: CellRect::new(3, 2, 4, 1),
            metrics: CellMetrics::default(),
            focused: true,
        }
    }

    fn painted_value(component: &dyn NativeComponent) -> String {
        let mut buffer = Buffer::empty(CellRect::new(0, 0, 8, 4));
        component.render(&context(), &mut buffer);
        (3..7)
            .map(|x| buffer[(x, 2)].symbol())
            .collect::<String>()
            .trim()
            .to_owned()
    }

    #[test]
    fn host_registration_preserves_reserved_native_components() {
        let mut registry = Components::default();
        registry.factories.insert(
            Arc::from(nsh_core::platform::TAB_BAR_COMPONENT),
            Arc::new(|| Box::new(Counter { value: 7 })),
        );
        registry.register(nsh_core::platform::TAB_BAR_COMPONENT, || {
            Box::new(Counter { value: 99 })
        });
        assert_eq!(
            painted_value(
                &*registry
                    .create(nsh_core::platform::TAB_BAR_COMPONENT)
                    .unwrap()
            ),
            "7"
        );
        registry.register("nsh/future-component", || Box::<Counter>::default());
        assert!(registry.create("nsh/future-component").is_none());
        // Only the reserved namespace is excluded; host names still work.
        registry.register("nsh-custom", || Box::new(Counter { value: 3 }));
        assert_eq!(painted_value(&*registry.create("nsh-custom").unwrap()), "3");
    }

    #[test]
    fn factories_make_independent_components_and_registries() {
        let mut registry = Components::default();
        registry.register("host.counter", || Box::<Counter>::default());
        let original = registry.clone();
        registry.register("host.counter", || Box::new(Counter { value: 10 }));

        let mut first = original.create("host.counter").unwrap();
        let second = original.create("host.counter").unwrap();
        first.set_prop("value", Some(&json!(7)));

        assert_eq!(painted_value(&*first), "7");
        assert_eq!(painted_value(&*second), "0");
        assert_eq!(
            painted_value(&*registry.create("host.counter").unwrap()),
            "10"
        );
        assert!(registry.create("host.unknown").is_none());
        assert_eq!(format!("{registry:?}"), r#"{"host.counter"}"#);
    }

    #[test]
    fn props_commands_and_terminal_input_keep_native_event_data() {
        let mut component = Counter::default();
        component.set_prop("value", Some(&json!(3)));
        let response = component.command("add", &json!(2));
        assert!(response.handled);
        assert_eq!(
            response.events,
            vec![ComponentEvent::new("change", json!({ "value": 5 }))]
        );

        let response = component.handle_event(
            &Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            &context(),
        );
        assert!(response.handled);
        let EventPayload::Native { name, data } =
            response.events.into_iter().next().unwrap().into()
        else {
            panic!("component event must use the shared native-event protocol");
        };
        assert_eq!(&*name, "change");
        assert_eq!(data, json!({ "value": 6 }));
        assert!(component.focusable());
        assert_eq!(
            component.intrinsic_size(),
            Some(Size::new(px(32.0), px(16.0)))
        );

        component.set_prop("value", None);
        assert_eq!(painted_value(&component), "0");
        assert!(!component.command("unknown", &JsonValue::Null).handled);
    }

    #[test]
    fn components_render_with_the_embedding_region_origin_and_clip() {
        let component = Counter { value: 12345 };
        let mut context = context();
        context.clip_area = CellRect::new(4, 2, 2, 1);
        let mut buffer = Buffer::empty(CellRect::new(2, 1, 6, 3));
        component.render(&context, &mut buffer);

        assert_eq!(buffer[(3, 2)].symbol(), " ");
        assert_eq!(buffer[(4, 2)].symbol(), "1");
        assert_eq!(buffer[(5, 2)].symbol(), "2");
        assert_eq!(buffer[(6, 2)].symbol(), " ");
    }

    #[test]
    fn mounted_components_receive_props_commands_focus_and_input() {
        use nsh_core::{Command, EventKind, EventMask, MountBatch, MountItem, ROOT_ID, ViewKind};

        use crate::{Surface, SurfaceEvent};

        let mut registry = Components::default();
        registry.register("host.counter", || Box::<Counter>::default());
        let mut surface = Surface::new(12, 4, CellMetrics::default());
        surface.set_components(registry);
        let mut events = EventMask::default();
        events.set(EventKind::NativeEvent, true);
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::Native,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(
                        Point::new(px(8.0), px(16.0)),
                        Size::new(px(32.0), px(16.0)),
                    ),
                },
                MountItem::Events { id: 2, events },
                MountItem::Component {
                    id: 2,
                    name: "host.counter".into(),
                },
                MountItem::ComponentProps {
                    id: 2,
                    props: vec![("value".into(), Some(json!(4)))],
                },
                MountItem::Command {
                    id: 2,
                    command: Command::Native {
                        name: "add".into(),
                        args: json!(3),
                    },
                },
            ],
        });
        let events = surface.drain_events().collect::<Vec<_>>();
        assert!(events.iter().any(|event| matches!(
            event,
            SurfaceEvent::ComponentSize(2, size) if *size == Size::new(px(32.0), px(16.0))
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            SurfaceEvent::Event(2, EventKind::NativeEvent, EventPayload::Native { name, data })
                if &**name == "change" && data == &json!({ "value": 7 })
        )));

        let region = CellRect::new(2, 3, 12, 4);
        let mut buffer = Buffer::empty(region);
        surface.render(region, &mut buffer);
        assert_eq!(buffer[(3, 4)].symbol(), "7");

        surface.handle_event(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
        assert_eq!(surface.focused(), Some(2));
        surface.handle_event(Event::Key(KeyEvent::new(
            KeyCode::Enter,
            KeyModifiers::NONE,
        )));
        assert!(surface.drain_events().any(|event| matches!(
            event,
            SurfaceEvent::Event(2, EventKind::NativeEvent, EventPayload::Native { data, .. })
                if data == json!({ "value": 8 })
        )));

        surface.apply(MountBatch {
            items: vec![MountItem::Delete { id: 2 }],
        });
        assert_eq!(surface.focused(), None);
    }
}
