use nsh_core::{
    element::PropEnum,
    geometry::{Axis, Points},
};
use serde::{Deserialize, Serialize};

use super::layout::PanelId;

/// A whole dock area as persisted: `gpui-base`'s on-disk format, so a
/// layout file is the same in both.
///
/// This mirrors a persisted, on-disk schema shipped to end users: its field
/// names and the tags of [`PanelInfo`] and [`DockPlacement`] are frozen.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[non_exhaustive]
pub struct DockAreaState {
    /// Marks which structure of the panels' own data the state was written
    /// with, so an app that changed it can tell whether to use the state or
    /// ignore it.
    #[serde(default)]
    pub version: Option<usize>,
    /// The center's layout (always a `StackPanel`).
    pub center: PanelState,
    /// The left dock.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_dock: Option<DockState>,
    /// The right dock.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_dock: Option<DockState>,
    /// The bottom dock.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bottom_dock: Option<DockState>,
}

impl DockAreaState {
    /// The state of the dock at `placement` (`None` for the center).
    pub fn dock(&self, placement: DockPlacement) -> Option<&DockState> {
        match placement {
            DockPlacement::Left => self.left_dock.as_ref(),
            DockPlacement::Right => self.right_dock.as_ref(),
            DockPlacement::Bottom => self.bottom_dock.as_ref(),
            DockPlacement::Center => None,
        }
    }
}

/// One dock as persisted: its layout, placement, size and whether it is
/// open.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[non_exhaustive]
pub struct DockState {
    panel: PanelState,
    placement: DockPlacement,
    size: Points,
    open: bool,
}

impl DockState {
    /// The state of a dock.
    pub fn new(panel: PanelState, placement: DockPlacement, size: Points, open: bool) -> Self {
        Self {
            panel,
            placement,
            size,
            open,
        }
    }

    /// Its layout.
    pub fn panel(&self) -> &PanelState {
        &self.panel
    }

    /// Where it is.
    pub fn placement(&self) -> DockPlacement {
        self.placement
    }

    /// Its size across its edge.
    pub fn size(&self) -> Points {
        self.size
    }

    /// Whether it is open.
    pub fn open(&self) -> bool {
        self.open
    }
}

/// One node of a persisted layout: a split (`StackPanel`), a tab group
/// (`TabPanel`) or a panel.
///
/// This mirrors a persisted, on-disk schema shipped to end users. A panel's
/// `panel_name` is the app's name for its kind, and its `info` is
/// `PanelInfo::Panel` with the panel's key as `"id"`
/// ([`PanelState::for_panel`]) beside whatever else the app keeps.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[non_exhaustive]
pub struct PanelState {
    /// `"StackPanel"`, `"TabPanel"`, or a panel's name.
    pub panel_name: String,
    /// A split's or tab group's children.
    pub children: Vec<PanelState>,
    /// What kind of node it is, with its data.
    pub info: PanelInfo,
}

/// What kind of node a [`PanelState`] is, with its data. The tags are
/// frozen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PanelInfo {
    /// A split.
    #[serde(rename = "stack")]
    Stack {
        /// Each child's slot (`0.0`: unconstrained).
        sizes: Vec<Points>,
        /// 0 for horizontal, 1 for vertical.
        axis: usize,
    },
    /// A tab group.
    #[serde(rename = "tabs")]
    Tabs {
        /// The index of the displayed panel.
        active_index: usize,
    },
    /// A panel: the app's data for it (its key as `"id"`).
    #[serde(rename = "panel")]
    Panel(serde_json::Value),
}

impl PanelInfo {
    /// A split's info.
    pub fn stack(sizes: Vec<Points>, axis: Axis) -> Self {
        Self::Stack {
            sizes,
            axis: if axis == Axis::Horizontal { 0 } else { 1 },
        }
    }

    /// A tab group's info.
    pub fn tabs(active_index: usize) -> Self {
        Self::Tabs { active_index }
    }

    /// A panel's info.
    pub fn panel(info: serde_json::Value) -> Self {
        Self::Panel(info)
    }

    /// A split's axis.
    pub fn axis(&self) -> Option<Axis> {
        match self {
            Self::Stack { axis, .. } => Some(if *axis == 0 {
                Axis::Horizontal
            } else {
                Axis::Vertical
            }),
            _ => None,
        }
    }

    /// A split's sizes.
    pub fn sizes(&self) -> Option<&Vec<Points>> {
        match self {
            Self::Stack { sizes, .. } => Some(sizes),
            _ => None,
        }
    }

    /// A tab group's displayed index.
    pub fn active_index(&self) -> Option<usize> {
        match self {
            Self::Tabs { active_index } => Some(*active_index),
            _ => None,
        }
    }
}

impl Default for PanelState {
    fn default() -> Self {
        Self {
            panel_name: "".to_string(),
            children: Vec::new(),
            info: PanelInfo::Panel(serde_json::Value::Null),
        }
    }
}

impl PanelState {
    /// Create a new leaf state for a panel with the given name.
    pub fn new(panel_name: impl Into<String>) -> Self {
        Self {
            panel_name: panel_name.into(),
            ..Default::default()
        }
    }

    /// The leaf state of panel `panel`, named `panel_name`: its info is
    /// `{"id": key}`.
    pub fn for_panel(panel: &PanelId, panel_name: impl Into<String>) -> Self {
        Self {
            panel_name: panel_name.into(),
            children: Vec::new(),
            info: PanelInfo::Panel(serde_json::json!({ PANEL_KEY: panel.as_str() })),
        }
    }

    /// The key of the panel a leaf state is for: its info's `"id"`.
    pub fn panel_id(&self) -> Option<PanelId> {
        match &self.info {
            PanelInfo::Panel(info) => info
                .get(PANEL_KEY)
                .and_then(serde_json::Value::as_str)
                .map(|key| PanelId::new(key.to_owned())),
            _ => None,
        }
    }

    /// Add a child.
    pub fn add_child(&mut self, panel: PanelState) {
        self.children.push(panel);
    }
}

/// The field of a panel's info that holds its key.
const PANEL_KEY: &str = "id";

/// Where a dock is: `"left"`, `"right"` or `"bottom"` of the center area,
/// or `"center"`, the area itself.
///
/// # Rust
///
/// The placement of a [`Dock`](super::Dock). This mirrors a persisted, on-disk schema shipped to end users: the
/// `#[serde(rename = ...)]` tags below are frozen and must not change.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PropEnum)]
pub enum DockPlacement {
    /// The center area.
    #[serde(rename = "center")]
    Center,
    /// The left dock.
    #[serde(rename = "left")]
    Left,
    /// The bottom dock.
    #[serde(rename = "bottom")]
    Bottom,
    /// The right dock.
    #[serde(rename = "right")]
    Right,
}

impl DockPlacement {
    /// The edge docks, in the order they are listed.
    pub const DOCKS: [DockPlacement; 3] = [Self::Left, Self::Right, Self::Bottom];

    /// The axis the dock is sized along.
    pub fn axis(&self) -> Axis {
        match self {
            Self::Left | Self::Right | Self::Center => Axis::Horizontal,
            Self::Bottom => Axis::Vertical,
        }
    }

    /// The left dock.
    pub fn is_left(&self) -> bool {
        matches!(self, Self::Left)
    }

    /// The bottom dock.
    pub fn is_bottom(&self) -> bool {
        matches!(self, Self::Bottom)
    }

    /// The right dock.
    pub fn is_right(&self) -> bool {
        matches!(self, Self::Right)
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::px;

    use super::*;

    /// The whole of a real user's file, not just its outline: every dock and
    /// the nesting under each one. Ported from the old
    /// `test_deserialize_item_state`, which checked all three docks and their
    /// children — a fixture test that only reads the center and one dock
    /// would keep passing if a dock's shape stopped deserializing at all.
    #[test]
    fn the_shipped_fixture_still_deserializes() {
        let json = include_str!("fixtures/layout.json");
        let state: DockAreaState = serde_json::from_str(json).unwrap();

        assert_eq!(state.version, None);
        assert_eq!(state.center.panel_name, "StackPanel");
        assert_eq!(state.center.children.len(), 2);
        assert_eq!(state.center.children[0].panel_name, "TabPanel");
        assert_eq!(state.center.children[1].panel_name, "TabPanel");
        assert_eq!(state.center.children[1].children.len(), 1);
        assert_eq!(
            state.center.children[1].children[0].panel_name,
            "StoryContainer"
        );

        let left = state.left_dock.unwrap();
        assert!(left.open());
        assert_eq!(left.size(), px(350.0));
        assert_eq!(left.placement(), DockPlacement::Left);
        assert_eq!(left.panel().panel_name, "TabPanel");
        assert_eq!(left.panel().children.len(), 1);
        assert_eq!(left.panel().children[0].panel_name, "StoryContainer");

        let bottom = state.bottom_dock.unwrap();
        assert!(bottom.open());
        assert_eq!(bottom.size(), px(200.0));
        assert_eq!(bottom.placement(), DockPlacement::Bottom);
        assert_eq!(bottom.panel().panel_name, "TabPanel");
        assert_eq!(bottom.panel().children.len(), 2);
        assert_eq!(bottom.panel().children[0].panel_name, "StoryContainer");

        let right = state.right_dock.unwrap();
        assert!(right.open());
        assert_eq!(right.size(), px(320.0));
        assert_eq!(right.placement(), DockPlacement::Right);
        assert_eq!(right.panel().panel_name, "TabPanel");
        assert_eq!(right.panel().children.len(), 1);
        assert_eq!(right.panel().children[0].panel_name, "StoryContainer");
    }

    #[test]
    fn the_serde_tags_are_frozen() {
        let stack = serde_json::to_value(PanelInfo::stack(vec![px(1.)], Axis::Vertical)).unwrap();
        assert_eq!(
            stack,
            serde_json::json!({"stack": {"sizes": [1.0], "axis": 1}})
        );

        let tabs = serde_json::to_value(PanelInfo::tabs(2)).unwrap();
        assert_eq!(tabs, serde_json::json!({"tabs": {"active_index": 2}}));

        let placement = serde_json::to_value(DockPlacement::Bottom).unwrap();
        assert_eq!(placement, serde_json::json!("bottom"));
    }

    #[test]
    fn a_panels_leaf_carries_its_key_as_id() {
        let leaf = PanelState::for_panel(&PanelId::from("files"), "Files");
        assert_eq!(
            serde_json::to_value(&leaf).unwrap(),
            serde_json::json!({"panel_name": "Files", "children": [], "info": {"panel": {"id": "files"}}})
        );
        assert_eq!(leaf.panel_id(), Some(PanelId::from("files")));
        assert_eq!(PanelState::new("Other").panel_id(), None);
    }

    #[test]
    fn optional_docks_are_omitted_not_nulled() {
        let state = DockAreaState::default();
        let json = serde_json::to_value(&state).unwrap();
        assert!(json.get("left_dock").is_none());
        assert!(json.get("right_dock").is_none());
        assert!(json.get("bottom_dock").is_none());
    }
}
