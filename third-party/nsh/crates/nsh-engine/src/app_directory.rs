//! Portable app data directory isolation.
/// The directory of app `id` in a data directory: the id, or `default` for
/// an app without one, or one that is no directory name.
pub fn app_dir_name(id: Option<&str>) -> &str {
    id.filter(|id| is_app_dir_name(id)).unwrap_or("default")
}

/// Whether app id `id` names a directory of its own: not empty, no path
/// separator, not `.` or `..`, so an app's storage stays in the directory
/// its id names.
fn is_app_dir_name(id: &str) -> bool {
    !id.is_empty() && !id.contains(['/', '\\', '\0']) && id != "." && id != ".."
}
