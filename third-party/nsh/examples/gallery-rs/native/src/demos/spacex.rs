//! The gallery's photographs: SpaceX's launches, one set for every demo, so
//! a session downloads few images (as `nsh-gallery-ui/photos.ts`).

pub(crate) const ARC: &str = "HUgxtn0WYAAHEl8";
pub(crate) const BOOSTER: &str = "HTpJzwHWMAAIOgb";
pub(crate) const DRAGON: &str = "HTiUp_2WsAAwokS";
pub(crate) const TRANSPORTER: &str = "HTbXRu9XcAEKwGr";
pub(crate) const RAYS: &str = "HS7_82eXsAAa-Hx";
pub(crate) const SUNRISE: &str = "HS8AAMSWwAEg-aG";
pub(crate) const DAY: &str = "HS8AFH2WsAASxLk";
pub(crate) const SILVER: &str = "HS6UGjvXkAAyHtp";
pub(crate) const ROLLOUT: &str = "HS6UIKjWcAAIFCz";
pub(crate) const LIFTOFF: &str = "HR4knefbgAAKXHH";
pub(crate) const MOON: &str = "HQ6i3NMW0AAA-TS";
pub(crate) const FAIRING: &str = "HQ6j_THXoAAGLRX";

/// Every photo, for what needs many (a long list, a reload).
pub(crate) const ALL: [&str; 12] = [
    ARC,
    BOOSTER,
    DRAGON,
    TRANSPORTER,
    RAYS,
    SUNRISE,
    DAY,
    SILVER,
    ROLLOUT,
    LIFTOFF,
    MOON,
    FAIRING,
];

/// The URL of a photo at a size the image server has by name (`360x360`,
/// `small`, `900x900`, `medium`, `large`, `4096x4096`).
pub(crate) fn url(id: &str, size: &str) -> String {
    format!("https://pbs.twimg.com/media/{id}?format=jpg&name={size}")
}
