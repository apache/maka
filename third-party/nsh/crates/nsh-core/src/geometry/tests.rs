use super::*;

#[test]
fn units_convert_at_their_boundaries() {
    assert_eq!(px(3.0) + px(2.0), px(5.0));
    assert_eq!(px(3.0) * 2.0, px(6.0));
    assert_eq!(px(3.0) / px(2.0), 1.5);
    assert_eq!(rems(1.5).to_points(REM_SIZE), px(24.0));
    assert_eq!(px(10.5).to_device_pixels(2.0), DevicePixels(21));
    assert_eq!(DevicePixels(21).to_points(2.0), px(10.5));
    assert_eq!(percentage(0.25).of(px(80.0)), px(20.0));
    assert!((deg(180.0).0 - std::f32::consts::PI).abs() < 1e-6);
    assert!((turn(0.25).to_degrees() - 90.0).abs() < 1e-4);
    assert!((grad(100.0).to_degrees() - 90.0).abs() < 1e-4);
    assert_eq!(Radians::from(percentage(0.5)), turn(0.5));
}

#[test]
fn lengths_resolve_with_their_context() {
    let parent = AbsoluteLength::Points(px(200.0));
    assert_eq!(relative(0.5).to_points(parent, REM_SIZE), px(100.0));
    assert_eq!(
        DefiniteLength::from(rems(2.0)).to_points(parent, REM_SIZE),
        px(32.0)
    );
    assert_eq!(
        Length::from(px(4.0)).to_points(parent, REM_SIZE),
        Some(px(4.0))
    );
    assert_eq!(auto().to_points(parent, REM_SIZE), None);
    assert_eq!(Length::default(), Length::Auto);
}

#[test]
fn equal_lengths_hash_alike() {
    use std::hash::{BuildHasher, BuildHasherDefault};
    let h = |l: Length| BuildHasherDefault::<rustc_hash::FxHasher>::default().hash_one(l);
    assert_eq!(h(px(0.0).into()), h(px(-0.0).into()));
    assert_ne!(h(px(1.0).into()), h(relative(1.0).into()));
}

#[test]
fn bounds_as_gpui_has_them() {
    let b = bounds(point(px(10.0), px(20.0)), size(px(30.0), px(40.0)));
    assert_eq!(b.right(), px(40.0));
    assert_eq!(b.bottom(), px(60.0));
    assert_eq!(b.center(), point(px(25.0), px(40.0)));
    assert!(b.contains(&point(px(10.0), px(20.0))));
    assert!(!b.contains(&point(px(40.0), px(20.0))));
    let other = bounds(point(px(30.0), px(50.0)), size(px(30.0), px(30.0)));
    assert!(b.intersects(&other));
    assert_eq!(
        b.intersect(&other),
        bounds(point(px(30.0), px(50.0)), size(px(10.0), px(10.0)))
    );
    assert_eq!(b.union(&other).bottom_right(), point(px(60.0), px(80.0)));
    assert_eq!(b.dilate(px(5.0)).size, size(px(40.0), px(50.0)));
    assert_eq!(b.inset(px(5.0)).origin, point(px(15.0), px(25.0)));
    assert_eq!(
        b.localize(&point(px(15.0), px(25.0))),
        Some(point(px(5.0), px(5.0)))
    );
    assert!(Bounds::<Points>::default().is_empty());
    // A new view's first frame differs from every frame, itself included.
    assert_ne!(Bounds::UNSET, Bounds::UNSET);
    assert_eq!(b.size.along(Axis::Vertical), px(40.0));
}

#[test]
fn edges_and_corners() {
    let e = Edges::all(px(2.0));
    assert_eq!(e.map(|p| p.0 * 2.0).left, 4.0);
    assert!(Edges::<Points>::zero().is_zero());
    let c = Corners::all(px(30.0)).clamp_radii_for_quad_size(size(px(40.0), px(100.0)));
    assert_eq!(c.max(), px(20.0));
    let t: ::taffy::Rect<::taffy::LengthPercentage> = Edges::all(relative(0.5)).into();
    assert_eq!(t.top, ::taffy::LengthPercentage::percent(0.5));
}
