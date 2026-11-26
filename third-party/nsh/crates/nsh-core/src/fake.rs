//! Stand-ins native modules give headless runs for what only a device
//! does: a microphone that hears the user, a camera, a push service.
//!
//! A module registers its [`Fake`] by name from its `#[native_module]`
//! entry ([`Registry::fake`](crate::element::Registry::fake)). Nothing uses
//! it in an app: only the headless driver (`nsh test`, `nsh_testing`'s
//! `Headless`) does, which installs the fakes of the app's sets before the
//! app starts, so the module answers in place of the platform, and routes a
//! test's calls to them by name (TS: `app.fake(name, method, ...args)`).
//!
//! A fake usually installs itself through the module's own backend hook
//! (`nsh_extra::speech::set_backend`), the one an embedding app gives its
//! own implementation through: the module runs the same code with a test
//! as with a device, and only what the backend answers differs. Every
//! module of `nsh-extra` with a backend hook (the camera, push) can give
//! one the same way.

use crate::JsonValue;

/// A native module's stand-in for headless runs
/// ([`Registry::fake`](crate::element::Registry::fake)).
pub trait Fake: Send + Sync {
    /// Takes the platform's place from now on: the headless driver calls
    /// it when it starts an app whose sets register the fake, before the
    /// app runs, and again for each app it starts after the earlier ones
    /// are gone. Process-wide state is reset here (what an earlier app
    /// left). Apps running together with the same fake (below) share what
    /// the first one installed: it is not installed again for the others.
    ///
    /// A fake may install itself process-wide (a module's backend), so the
    /// headless driver never runs apps with different fakes at once in one
    /// process: an app whose sets give fakes waits to start until the apps
    /// running with other fakes are gone (two `#[test]`s, each launching
    /// its app with a registry of its own, take turns). Apps started with
    /// the same fakes, clones of one registry (the apps one `nsh test`
    /// file opens), run together and share them.
    fn install(&self);

    /// What a test asks of it: `method` with `args`, the test's arguments
    /// as JSON; the answer as JSON (`null` for none), or why it failed,
    /// which fails the test's step.
    fn call(&self, method: &str, args: &[JsonValue]) -> Result<JsonValue, String>;
}
