use nsh_core::{Bounds, EventMask, NodeId, Points, TextLayout, ViewKind, ViewProps, ViewStyle};

use crate::NativeComponent;

pub(crate) struct NshView {
    pub(crate) tree_order: usize,
    pub(crate) kind: ViewKind,
    pub(crate) concealed: bool,
    pub(crate) stack: Option<Box<nsh_core::navigation::Stack>>,
    pub(crate) screen: Option<Box<crate::navigation::Screen>>,
    pub(crate) modal: Option<Box<crate::navigation::Modal>>,
    pub(crate) parent: Option<NodeId>,
    pub(crate) children: Vec<NodeId>,
    pub(crate) frame: Bounds<Points>,
    pub(crate) style: ViewStyle,
    /// Its background while the pointer is not over it: what a `hover:`
    /// fill of the app's own replaces, so the painter's hover band is a
    /// step over the view at rest, not over that fill as well.
    pub(crate) rest_fill: nsh_core::Color,
    pub(crate) animated: nsh_core::animation::AnimValues,
    pub(crate) props: ViewProps,
    pub(crate) events: EventMask,
    pub(crate) gestures: nsh_core::GestureValues,
    pub(crate) tracked: u16,
    pub(crate) states: u16,
    /// The states it shows as a part of a control (`MountItem::ProjectStates`:
    /// a list's highlighted option), drawn as its own and never reported.
    pub(crate) projected: u16,
    pub(crate) input: Option<Box<nsh_core::InputConfig>>,
    pub(crate) field: Option<Box<crate::text_input::Field>>,
    pub(crate) text_content: Option<std::sync::Arc<nsh_core::AttributedText>>,
    pub(crate) text: Option<(TextLayout, Bounds<Points>)>,
    pub(crate) scroll: Option<Box<nsh_core::scroll::ScrollState>>,
    pub(crate) canvas: Option<Box<crate::canvas::CanvasView>>,
    pub(crate) image: Option<crate::image::ImageMount>,
    pub(crate) component: Option<Box<dyn NativeComponent>>,
    pub(crate) component_name: Option<String>,
}

impl NshView {
    pub(crate) fn new(kind: ViewKind) -> Self {
        Self {
            tree_order: usize::MAX,
            kind,
            concealed: matches!(kind, ViewKind::Screen | ViewKind::HeaderItem),
            stack: (kind == ViewKind::Stack).then(Default::default),
            screen: (kind == ViewKind::Screen).then(Default::default),
            modal: (kind == ViewKind::Modal).then(Default::default),
            parent: None,
            children: Vec::new(),
            frame: Default::default(),
            style: Default::default(),
            rest_fill: nsh_core::Color::TRANSPARENT,
            animated: Default::default(),
            props: Default::default(),
            events: Default::default(),
            gestures: Default::default(),
            tracked: 0,
            states: 0,
            projected: 0,
            input: None,
            field: (kind == ViewKind::Input).then(Default::default),
            text_content: None,
            text: None,
            scroll: (kind == ViewKind::Scroll).then(Default::default),
            canvas: None,
            image: None,
            component: None,
            component_name: None,
        }
    }
}
