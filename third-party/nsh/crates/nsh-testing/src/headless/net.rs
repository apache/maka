//! Assets for headless runs (`nsh test`): from the app's directory and its
//! UI sets' files.

use std::path::PathBuf;

use nsh_engine::Assets;

/// `asset:/…` files: the UI sets' files (`Registry::assets`), else
/// relative to the app's directory (the one its bundle names its assets
/// from, `nsh_bundler::Bundle::asset_root`).
pub struct DirectoryAssets {
    dir: PathBuf,
    /// The sets' files: (path among the app's assets, file).
    files: Vec<(String, PathBuf)>,
}

impl DirectoryAssets {
    /// The assets of the app whose directory is `dir`, with the UI sets'
    /// `files` (path among the app's assets, file).
    pub fn new(dir: PathBuf, files: Vec<(String, PathBuf)>) -> Self {
        Self { dir, files }
    }
}

impl Assets for DirectoryAssets {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        let path = uri
            .strip_prefix("asset:/")
            .ok_or_else(|| format!("not an asset URI: {uri}"))?;
        let file = self
            .files
            .iter()
            .find(|(p, _)| p == path)
            .map_or_else(|| self.dir.join(path), |(_, file)| file.clone());
        std::fs::read(file).map_err(|e| e.to_string())
    }
}
