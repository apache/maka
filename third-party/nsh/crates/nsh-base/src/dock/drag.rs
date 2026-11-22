//! Drop geometry for the dock: where a drop would land, and what shape the
//! placeholder of a hovering drag occupies.
//!
//! It draws nothing: the drag preview and the drop indicator are the app's
//! (`DockArea`'s `renderDropIndicator`).

use nsh_core::{
    element::Placement,
    geometry::{Bounds, Point, Points, Size, point, px, size},
};

/// The bounds a drop placeholder should occupy within a tab group, given
/// where the drop would land.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
#[non_exhaustive]
pub struct DropPlaceholderBounds {
    origin: Point<Points>,
    size: Size<Points>,
}

impl DropPlaceholderBounds {
    /// The half of `bounds` (or all of it, for `None`) a drop at
    /// `placement` takes, relative to `bounds`' origin.
    pub fn for_placement(bounds: Bounds<Points>, placement: Option<Placement>) -> Self {
        let half_width = bounds.size.width * 0.5;
        let half_height = bounds.size.height * 0.5;

        match placement {
            Some(Placement::Left) => Self {
                origin: Point::default(),
                size: size(half_width, bounds.size.height),
            },
            Some(Placement::Right) => Self {
                origin: point(half_width, px(0.)),
                size: size(half_width, bounds.size.height),
            },
            Some(Placement::Top) => Self {
                origin: Point::default(),
                size: size(bounds.size.width, half_height),
            },
            Some(Placement::Bottom) => Self {
                origin: point(px(0.), half_height),
                size: size(bounds.size.width, half_height),
            },
            None => Self {
                origin: Point::default(),
                size: bounds.size,
            },
        }
    }

    /// Its origin, relative to the group's bounds.
    pub fn origin(&self) -> Point<Points> {
        self.origin
    }

    /// Its size.
    pub fn size(&self) -> Size<Points> {
        self.size
    }
}

/// Which split zone `position` falls into within `bounds`, or `None` for the
/// centre zone (merge into the tab group rather than split).
pub(crate) fn split_placement_at(
    bounds: Bounds<Points>,
    position: Point<Points>,
) -> Option<Placement> {
    if position.x < bounds.left() + bounds.size.width * 0.35 {
        Some(Placement::Left)
    } else if position.x > bounds.left() + bounds.size.width * 0.65 {
        Some(Placement::Right)
    } else if position.y < bounds.top() + bounds.size.height * 0.35 {
        Some(Placement::Top)
    } else if position.y > bounds.top() + bounds.size.height * 0.65 {
        Some(Placement::Bottom)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drop_placeholder_bounds_cover_each_target_placement() {
        let bounds = Bounds {
            origin: point(px(120.), px(80.)),
            size: size(px(400.), px(300.)),
        };

        assert_eq!(
            DropPlaceholderBounds::for_placement(bounds, Some(Placement::Left)),
            DropPlaceholderBounds {
                origin: point(px(0.), px(0.)),
                size: size(px(200.), px(300.)),
            }
        );
        assert_eq!(
            DropPlaceholderBounds::for_placement(bounds, Some(Placement::Right)),
            DropPlaceholderBounds {
                origin: point(px(200.), px(0.)),
                size: size(px(200.), px(300.)),
            }
        );
        assert_eq!(
            DropPlaceholderBounds::for_placement(bounds, Some(Placement::Top)),
            DropPlaceholderBounds {
                origin: point(px(0.), px(0.)),
                size: size(px(400.), px(150.)),
            }
        );
        assert_eq!(
            DropPlaceholderBounds::for_placement(bounds, Some(Placement::Bottom)),
            DropPlaceholderBounds {
                origin: point(px(0.), px(150.)),
                size: size(px(400.), px(150.)),
            }
        );
        assert_eq!(
            DropPlaceholderBounds::for_placement(bounds, None),
            DropPlaceholderBounds {
                origin: point(px(0.), px(0.)),
                size: size(px(400.), px(300.)),
            }
        );
    }

    #[test]
    fn split_placement_follows_the_cursor_zone() {
        let bounds = Bounds {
            origin: point(px(120.), px(80.)),
            size: size(px(400.), px(300.)),
        };
        // 35% / 65% of 400x300 from origin (120, 80).
        let at = |x: f32, y: f32| split_placement_at(bounds, point(px(x), px(y)));

        assert_eq!(at(130., 230.), Some(Placement::Left));
        assert_eq!(at(510., 230.), Some(Placement::Right));
        assert_eq!(at(320., 90.), Some(Placement::Top));
        assert_eq!(at(320., 370.), Some(Placement::Bottom));
        assert_eq!(at(320., 230.), None, "centre merges into the tab group");
    }

    #[test]
    fn split_placement_prefers_horizontal_in_the_corners() {
        let bounds = Bounds {
            origin: Point::default(),
            size: size(px(400.), px(300.)),
        };

        // Top-left corner satisfies both Left and Top; x is tested first.
        assert_eq!(
            split_placement_at(bounds, point(px(10.), px(10.))),
            Some(Placement::Left)
        );
        assert_eq!(
            split_placement_at(bounds, point(px(390.), px(290.))),
            Some(Placement::Right)
        );
    }

    #[test]
    fn split_placement_boundaries_fall_into_the_centre() {
        let bounds = Bounds {
            origin: Point::default(),
            size: size(px(400.), px(300.)),
        };

        // Comparisons are strict, so the threshold itself is the centre zone.
        assert_eq!(split_placement_at(bounds, point(px(140.), px(150.))), None);
        assert_eq!(split_placement_at(bounds, point(px(260.), px(150.))), None);
        assert_eq!(split_placement_at(bounds, point(px(200.), px(105.))), None);
        assert_eq!(split_placement_at(bounds, point(px(200.), px(195.))), None);
    }
}
