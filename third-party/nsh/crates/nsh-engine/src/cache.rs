//! Where an app's caches are kept and how much each keeps
//! ([`CacheOptions`], [`crate::EngineConfig::cache`]). The engine opens
//! them for the app it runs: each cache in `<root>/<app id>/<kind>`, so
//! apps never share one. Today the one kind is the images an app
//! downloads ([`nsh_core::image::DiskCache`], `images`).

use std::path::PathBuf;

pub use nsh_core::ByteSize;

/// Where an app's caches are kept and how much each keeps. The default:
/// the system's cache directory, each cache at its default size.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct CacheOptions {
    /// The root of the app's caches: each in `<root>/<app id>/<kind>`.
    pub location: CacheLocation,
    /// The images the app downloads, kept as the server sent them
    /// (`images`).
    pub images: CachePolicy,
}

impl CacheOptions {
    /// Caches in `location`, each at its default size.
    pub fn at(location: CacheLocation) -> Self {
        Self {
            location,
            ..Self::default()
        }
    }

    /// No cache on disk.
    pub fn off() -> Self {
        Self::at(CacheLocation::Off)
    }

    /// These options with `images` for the images the app downloads.
    #[must_use]
    pub fn with_images(mut self, images: CachePolicy) -> Self {
        self.images = images;
        self
    }
}

/// The root directory of an app's caches.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum CacheLocation {
    /// The system's cache directory: Caches on Apple platforms (`nsh` in
    /// it in an embedding iOS app), `%LOCALAPPDATA%` on Windows,
    /// `$XDG_CACHE_HOME` (`~/.cache`) on Linux, `nsh` in the Context's
    /// cache directory on Android. The system may clear it for space.
    #[default]
    System,
    /// A directory of the embedding app's choosing.
    Dir(PathBuf),
    /// Nothing is cached on disk.
    Off,
}

/// How much one cache keeps.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum CachePolicy {
    /// Its default size (the images': 256 MiB,
    /// [`nsh_core::image::DEFAULT_DISK_CACHE_SIZE`]).
    #[default]
    Default,
    /// At most this much; past it the least recently used entries go.
    MaxSize(ByteSize),
    /// Not kept on disk.
    Off,
}

impl CacheOptions {
    /// The directory of the `kind` cache of app `app_id` (`None`: none on
    /// disk), `System` resolved to [`crate::storage`]'s system cache
    /// directory.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn dir(&self, app_id: Option<&str>, kind: &str) -> Option<PathBuf> {
        let root = match &self.location {
            CacheLocation::System => crate::storage::cache_dir()?,
            CacheLocation::Dir(dir) => dir.clone(),
            CacheLocation::Off => return None,
        };
        Some(root.join(crate::app_dir_name(app_id)).join(kind))
    }

    /// The disk cache of the images app `app_id` downloads, if it keeps one.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn open_images(&self, app_id: Option<&str>) -> Option<nsh_core::image::DiskCache> {
        let size = match self.images {
            CachePolicy::Default => nsh_core::image::DEFAULT_DISK_CACHE_SIZE,
            CachePolicy::MaxSize(size) => size,
            CachePolicy::Off => return None,
        };
        nsh_core::image::DiskCache::open(self.dir(app_id, "images")?, size)
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn caches_live_in_their_apps_directory() {
        let options = CacheOptions::at(CacheLocation::Dir("/c".into()));
        let images = options.open_images(Some("com.example.chat")).unwrap();
        assert_eq!(images.dir(), Path::new("/c/com.example.chat/images"));
        assert_eq!(images.max_size(), ByteSize::mib(256));
        // An id that is no directory name stays in the root.
        let odd = options.open_images(Some("a/b")).unwrap();
        assert_eq!(odd.dir(), Path::new("/c/default/images"));
        let small = options
            .clone()
            .with_images(CachePolicy::MaxSize(ByteSize::mib(8)));
        assert_eq!(
            small.open_images(None).unwrap().max_size(),
            ByteSize::mib(8)
        );
        assert!(
            options
                .clone()
                .with_images(CachePolicy::Off)
                .open_images(None)
                .is_none()
        );
        assert!(
            options
                .with_images(CachePolicy::MaxSize(ByteSize::ZERO))
                .open_images(None)
                .is_none()
        );
        assert!(CacheOptions::off().open_images(None).is_none());
    }
}
