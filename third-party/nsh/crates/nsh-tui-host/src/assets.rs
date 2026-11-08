//! Bundled resources next to a source bundle, as in the desktop development hosts.

use std::path::{Component, Path, PathBuf};

pub(crate) struct Directory(pub(crate) PathBuf);

impl nsh_engine::Assets for Directory {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        let relative = uri
            .strip_prefix("asset:/")
            .ok_or_else(|| format!("not an asset URI: {uri}"))?;
        if !Path::new(relative)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err(format!("invalid asset path: {uri}"));
        }
        let root = self.0.canonicalize().map_err(|error| error.to_string())?;
        let path = root
            .join(relative)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !path.starts_with(&root) {
            return Err(format!("asset outside bundle directory: {uri}"));
        }
        std::fs::read(path).map_err(|error| error.to_string())
    }
}
