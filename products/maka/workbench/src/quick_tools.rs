/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
//! Client-local Quick Tools services. No plugin chooses the storage root.
use nsh_engine::{EngineConfig, JsonValue};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

mod plugins;

const MAX_STORAGE: usize = 42 * 1024 * 1024;
struct Store {
    root: PathBuf,
    serial: Mutex<()>,
}
impl Store {
    fn file(&self, key: &str) -> Result<PathBuf, String> {
        if key.is_empty()
            || key.len() > 100
            || !key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
            || key.starts_with('.')
        {
            return Err("Invalid Quick Tools storage key".into());
        }
        Ok(self.root.join(format!("{key}.json")))
    }
    fn read(&self, key: &str, fallback: JsonValue) -> Result<JsonValue, String> {
        let _guard = self.serial.lock().map_err(|e| e.to_string())?;
        let file = self.file(key)?;
        match fs::symlink_metadata(&file) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(fallback),
            Err(e) => return Err(e.to_string()),
            Ok(info) if !info.is_file() || info.len() > MAX_STORAGE as u64 => {
                return Err("Invalid or oversized Quick Tools storage file".into());
            }
            _ => (),
        }
        serde_json::from_slice(&fs::read(file).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Cannot read {key}; the original file was retained: {e}"))
    }
    fn write(&self, key: &str, value: &JsonValue) -> Result<(), String> {
        let _guard = self.serial.lock().map_err(|e| e.to_string())?;
        let file = self.file(key)?;
        let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_STORAGE {
            return Err("Plugin storage exceeds 42 MiB".into());
        }
        private_directory(&self.root)?;
        let temporary = self
            .root
            .join(format!(".{key}.{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> std::io::Result<()> {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut output = options.open(&temporary)?;
            output.write_all(&bytes)?;
            output.sync_all()?;
            fs::rename(&temporary, &file)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result.map_err(|e| e.to_string())
    }
}
fn private_directory(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    if !fs::symlink_metadata(root)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("Storage root must be a directory, not a symlink".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn words(text: &str) -> Vec<String> {
    let segmenter = icu_segmenter::WordSegmenter::new_auto(Default::default());
    let mut start = 0;
    let mut words = Vec::new();
    for (end, kind) in segmenter.segment_str(text).iter_with_word_type() {
        if kind.is_word_like() {
            words.push(text[start..end].to_owned());
        }
        start = end;
    }
    words
}
/// Attach after the shell has selected its client directory.
pub fn attach(config: &mut EngineConfig) {
    plugins::attach(config);
    let Some(directory) = config.data_dir.as_ref() else {
        return;
    };
    let store = Arc::new(Store {
        root: directory.join("default/quick-tools"),
        serial: Mutex::new(()),
    });
    let runtime = config.runtime.clone().expect("native client runtime");
    let segmentation_runtime = runtime.clone();
    config.host.handle("quickTools.search.words", move |call| {
        segmentation_runtime.spawn_blocking(move || {
            let result = (|| -> Result<JsonValue, String> {
                let texts: Vec<String> =
                    serde_json::from_value(call.data().clone()).map_err(|e| e.to_string())?;
                if texts.len() > 4096
                    || texts.iter().map(String::len).sum::<usize>() > 4 * 1024 * 1024
                {
                    return Err("Search corpus is too large".into());
                }
                Ok(serde_json::json!(
                    texts.iter().map(|text| words(text)).collect::<Vec<_>>()
                ))
            })();
            match result {
                Ok(value) => call.resolve(value),
                Err(error) => call.reject(error),
            }
        });
    });
    for (method, write) in [
        ("quickTools.storage.read", false),
        ("quickTools.storage.write", true),
    ] {
        let store = store.clone();
        let runtime = runtime.clone();
        config.host.handle(method, move |call| {
            let store = store.clone();
            runtime.spawn_blocking(move || {
                let result = (|| {
                    let key = call.data()["key"]
                        .as_str()
                        .ok_or("Expected a storage key")?;
                    if write {
                        store.write(key, &call.data()["value"])?;
                        Ok(JsonValue::Null)
                    } else {
                        store.read(key, call.data()["fallback"].clone())
                    }
                })();
                match result {
                    Ok(value) => call.resolve(value),
                    Err(error) => call.reject(error),
                }
            });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_words_segment_chinese_and_english_without_punctuation() {
        assert_eq!(
            words("搜索文件 hello, world!"),
            ["搜索", "文件", "hello", "world"]
        );
    }
    #[test]
    fn preserves_large_clipboard_history_and_rejects_path_escape() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store {
            root: directory.path().join("quick-tools"),
            serial: Mutex::new(()),
        };
        let value = serde_json::json!({"clips": ["x".repeat(9 * 1024 * 1024)]});
        store.write("maka.clipboard", &value).unwrap();
        assert_eq!(
            store.read("maka.clipboard", JsonValue::Null).unwrap(),
            value
        );
        assert!(store.write("../outside", &JsonValue::Null).is_err());
        fs::write(store.file("broken").unwrap(), b"{").unwrap();
        assert!(store.read("broken", JsonValue::Null).is_err());
        assert_eq!(fs::read(store.file("broken").unwrap()).unwrap(), b"{");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&store.root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(store.file("maka.clipboard").unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
