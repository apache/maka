/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! "Import local Skill…": a SKILL.md chosen on this machine copied into
//! the source library the Host reads its `managed_sources` view from, as
//! Desktop's main process does (`importManagedSkillSource` in
//! apps/desktop/src/main/managed-skill-sources.ts), with the front matter
//! checked the way `validateSkillMetadata` does
//! (packages/runtime/src/skills-metadata.ts). Only the checks that make a
//! file invalid are made; Desktop's warnings (an unsupported field, a long
//! name) do not stop an import.
//!
//! Everything here is blocking file I/O: call it on a background thread.

use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

/// The source library: `~/.maka/skill-sources`, one directory per source
/// holding its SKILL.md (`resolveManagedSkillSourcesRoot` in
/// packages/runtime/src/managed-skill-sources.ts).
pub fn skill_sources_root(home: &Path) -> PathBuf {
    home.join(".maka").join("skill-sources")
}

/// A source the import wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ImportedSource {
    /// Its directory in the library, from the file's name.
    pub id: String,
    /// The Skill's `name`.
    pub name: String,
    /// The SKILL.md written.
    pub path: PathBuf,
}

/// Why an import wrote nothing (Desktop's `ImportManagedSkillSourceResult`
/// reasons, but `cancelled`, which is the dialog's).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ImportFailure {
    /// Unreadable, or its front matter does not make a Skill, or its name
    /// gives no usable directory.
    InvalidSkill,
    /// The library already has a source of that name.
    AlreadyExists,
    /// A symlink, not a regular file, or a library that is not a plain
    /// directory.
    BlockedPath,
    WriteFailed,
}

/// What makes a SKILL.md invalid (the `error` severity codes of
/// `SkillValidationCode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum FrontMatterError {
    MissingFrontmatter,
    MalformedFrontmatter,
    MissingName,
    InvalidName,
    MissingDescription,
    InvalidDescription,
    InvalidRequiredTools,
    InvalidRequiredCapabilities,
}

/// The front matter of a valid SKILL.md, as far as the import reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct SkillFrontMatter {
    pub name: String,
    pub description: String,
}

/// Checks `text` as `validateSkillMetadata` does: a YAML front matter block
/// between `---` lines at the top, a mapping (strict, unique keys, no
/// aliases), a non-empty `name` and `description`, and `required-tools` and
/// `required-capabilities` that are a space- or comma-separated string or
/// a list of single words. A broken block reports only that; the field
/// errors are reported together.
pub fn validate_front_matter(text: &str) -> Result<SkillFrontMatter, Vec<FrontMatterError>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> =
        text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
    if !lines.first().is_some_and(|line| is_delimiter(line)) {
        return Err(vec![FrontMatterError::MissingFrontmatter]);
    }
    let Some(close) = lines.iter().skip(1).position(|line| is_delimiter(line)) else {
        return Err(vec![FrontMatterError::MalformedFrontmatter]);
    };
    let block = lines[1..close + 1].join("\n");
    let Some(manifest) = parse_mapping(&block) else {
        return Err(vec![FrontMatterError::MalformedFrontmatter]);
    };
    let mut errors = Vec::new();
    let name = required_string(
        manifest.get("name"),
        FrontMatterError::MissingName,
        FrontMatterError::InvalidName,
        &mut errors,
    );
    let description = required_string(
        manifest.get("description"),
        FrontMatterError::MissingDescription,
        FrontMatterError::InvalidDescription,
        &mut errors,
    );
    if !is_word_list(manifest.get("required-tools")) {
        errors.push(FrontMatterError::InvalidRequiredTools);
    }
    if !is_word_list(manifest.get("required-capabilities")) {
        errors.push(FrontMatterError::InvalidRequiredCapabilities);
    }
    match (name, description) {
        (Some(name), Some(description)) if errors.is_empty() => {
            Ok(SkillFrontMatter { name, description })
        }
        _ => Err(errors),
    }
}

/// `^---[\t ]*$`.
fn is_delimiter(line: &str) -> bool {
    line.strip_prefix("---").is_some_and(|rest| rest.chars().all(|c| c == ' ' || c == '\t'))
}

/// The block as a YAML mapping, parsed as strictly as Desktop's
/// `parseDocument(…, { merge: false, strict: true, uniqueKeys: true })`
/// with `toJS({ maxAliasCount: 0 })`: a duplicate key or any alias fails,
/// `<<` is an ordinary key, and only `true` and `false` are booleans.
fn parse_mapping(block: &str) -> Option<Map<String, Value>> {
    let mut budget = serde_saphyr::Budget::default();
    budget.max_aliases = 0;
    let mut options = serde_saphyr::Options::default();
    options.budget = Some(budget);
    options.duplicate_keys = serde_saphyr::DuplicateKeyPolicy::Error;
    options.merge_keys = serde_saphyr::MergeKeyPolicy::AsOrdinary;
    options.strict_booleans = true;
    options.with_snippet = false;
    match serde_saphyr::from_str_with_options::<Value>(block, options) {
        Ok(Value::Object(mapping)) => Some(mapping),
        _ => None,
    }
}

/// `cleanPromptText`: control characters unsafe in prompt text removed.
fn clean(text: &str) -> String {
    text.chars()
        .filter(|&c| {
            !matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}')
        })
        .collect()
}

/// `readRequiredSkillString`.
fn required_string(
    value: Option<&Value>,
    missing: FrontMatterError,
    invalid: FrontMatterError,
    errors: &mut Vec<FrontMatterError>,
) -> Option<String> {
    let text = match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(clean(text).trim().to_owned()),
        Some(_) => {
            errors.push(invalid);
            return None;
        }
    };
    match text {
        Some(text) if !text.is_empty() => Some(text),
        _ => {
            errors.push(missing);
            None
        }
    }
}

/// `readSkillStringList` without its result: whether the field is absent,
/// empty, or a list of words.
fn is_word_list(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) if text.is_empty() => true,
        Some(Value::String(text)) => {
            // `split(/[\s,]+/)`: a run of separators is one, so only an
            // empty token at either end (a leading or trailing comma) is
            // an empty entry.
            let tokens: Vec<&str> =
                text.trim().split(|c: char| c.is_whitespace() || c == ',').collect();
            let last = tokens.len() - 1;
            tokens.iter().enumerate().all(|(ix, token)| {
                if token.is_empty() {
                    ix != 0 && ix != last
                } else {
                    !clean(token).trim().is_empty()
                }
            })
        }
        Some(Value::Array(items)) => items.iter().all(|item| match item {
            Value::String(text) => {
                let token = clean(text);
                let token = token.trim();
                !token.is_empty() && !token.chars().any(char::is_whitespace)
            }
            _ => false,
        }),
        Some(_) => false,
    }
}

/// The source's directory name (`sourceIdFromPath`): a `SKILL.md` is named
/// for its folder, any other file for its stem, lowercased, every run of
/// characters outside `a-z0-9._-` turned into one `-`, trimmed of `-`, at
/// most 80 characters, and a safe Skill id. Desktop decomposes the name
/// (NFKD) first, so an accented Latin letter keeps its base letter there;
/// here it becomes a `-` like any other letter outside the set.
pub fn source_id_from_path(path: &Path) -> Option<String> {
    let file_name = path.file_name()?.to_string_lossy();
    let base = if file_name.to_lowercase() == "skill.md" {
        path.parent()?.file_name()?.to_string_lossy().into_owned()
    } else {
        path.file_stem()?.to_string_lossy().into_owned()
    };
    let mut normalized = String::new();
    let mut in_run = false;
    for c in base.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
            normalized.push(c);
            in_run = false;
        } else if !in_run {
            normalized.push('-');
            in_run = true;
        }
    }
    let id: String = normalized.trim_matches('-').chars().take(80).collect();
    is_safe_skill_id(&id).then_some(id)
}

/// `isSafeSkillId`: `^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$`.
pub fn is_safe_skill_id(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && value.len() <= 81
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Copies `source_file` into the library at `root` as
/// `<root>/<id>/SKILL.md`, refusing a symlink, an invalid Skill, a name the
/// library already has, and a library or source directory that is not a
/// plain directory inside it. The file is written to a temporary name in
/// the source directory first and renamed into place.
pub fn import_skill_source(
    root: &Path,
    source_file: &Path,
) -> Result<ImportedSource, ImportFailure> {
    let metadata = fs::symlink_metadata(source_file).map_err(|_| ImportFailure::InvalidSkill)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ImportFailure::BlockedPath);
    }
    let mut bytes = Vec::new();
    File::open(source_file)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|_| ImportFailure::InvalidSkill)?;
    let front_matter = validate_front_matter(&String::from_utf8_lossy(&bytes))
        .map_err(|_| ImportFailure::InvalidSkill)?;
    let id = source_id_from_path(source_file).ok_or(ImportFailure::InvalidSkill)?;
    let source_dir = root.join(&id);
    let target = source_dir.join("SKILL.md");

    let write_failure = |error: std::io::Error| match error.kind() {
        ErrorKind::AlreadyExists => ImportFailure::AlreadyExists,
        _ => ImportFailure::WriteFailed,
    };
    private_dir_builder(true).create(root).map_err(write_failure)?;
    let root_real = plain_directory(root).ok_or(ImportFailure::BlockedPath)?;
    private_dir_builder(false).create(&source_dir).map_err(write_failure)?;
    let source_dir_real = plain_directory(&source_dir)
        .filter(|real| real.starts_with(&root_real))
        .ok_or(ImportFailure::BlockedPath)?;
    if !write_new_file(&source_dir_real, &target, &bytes) {
        return Err(ImportFailure::WriteFailed);
    }
    Ok(ImportedSource { id, name: front_matter.name, path: target })
}

/// `directory`'s canonical path when it is a directory and not a symlink.
fn plain_directory(directory: &Path) -> Option<PathBuf> {
    let metadata = fs::symlink_metadata(directory).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    fs::canonicalize(directory).ok()
}

/// A directory builder that creates directories only this user can open.
fn private_dir_builder(recursive: bool) -> fs::DirBuilder {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder
}

/// `writeContainedBufferFile` with `failIfExists`: `bytes` written to a
/// temporary file in `directory` (a canonical path) and renamed to `target`,
/// unless `target` exists or the temporary file is not a regular file in
/// `directory`. Whether it was written.
fn write_new_file(directory: &Path, target: &Path, bytes: &[u8]) -> bool {
    match fs::symlink_metadata(target) {
        Ok(_) => return false,
        Err(error) if error.kind() != ErrorKind::NotFound => return false,
        Err(_) => {}
    }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis());
    let temp = directory.join(format!(".maka-source-write.{}.{stamp}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let written = options.open(&temp).and_then(|mut file| file.write_all(bytes)).is_ok()
        && fs::symlink_metadata(&temp)
            .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        && fs::canonicalize(&temp).is_ok_and(|real| real.starts_with(directory))
        && fs::rename(&temp, target).is_ok();
    if !written {
        let _ = fs::remove_file(&temp);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    use FrontMatterError::*;

    #[test]
    fn a_skill_needs_front_matter_with_a_name_and_a_description() {
        let valid = "---\nname: Research brief\ndescription: Prepare a research brief\n---\nBody\n";
        assert_eq!(
            validate_front_matter(valid),
            Ok(SkillFrontMatter {
                name: "Research brief".into(),
                description: "Prepare a research brief".into()
            })
        );
        // A BOM, CRLF lines, spaces after the delimiter, a folded
        // description, lists, and fields Desktop only warns about.
        let tolerant = "\u{feff}---  \r\nname: \"Brief\"\r\ndescription: >\r\n  Two\r\n  lines\r\n\
             required-tools: Read, Grep\r\nrequired-capabilities: [web]\r\nlicense: MIT\r\n\
             author: me\r\n---\r\n";
        assert_eq!(
            validate_front_matter(tolerant).map(|skill| skill.description),
            Ok("Two lines".to_owned())
        );
        for (text, errors) in [
            ("name: x\ndescription: y\n", vec![MissingFrontmatter]),
            ("---\nname: x\ndescription: y\n", vec![MalformedFrontmatter]),
            ("---\nname: [x\n---\n", vec![MalformedFrontmatter]),
            ("---\n- a\n- b\n---\n", vec![MalformedFrontmatter]),
            ("---\n---\n", vec![MalformedFrontmatter]),
            ("---\nname: x\nname: y\ndescription: z\n---\n", vec![MalformedFrontmatter]),
            ("---\nname: &n x\ndescription: *n\n---\n", vec![MalformedFrontmatter]),
            ("---\ndescription: y\n---\n", vec![MissingName]),
            ("---\nname: \"  \"\ndescription: y\n---\n", vec![MissingName]),
            ("---\nname: 12\ndescription: y\n---\n", vec![InvalidName]),
            ("---\nname: true\n---\n", vec![InvalidName, MissingDescription]),
            ("---\nname: x\ndescription: [y]\n---\n", vec![InvalidDescription]),
            (
                "---\nname: x\ndescription: y\nrequired-tools: [Read, 3]\n---\n",
                vec![InvalidRequiredTools],
            ),
            (
                "---\nname: x\ndescription: y\nrequired-tools: \",Read\"\n---\n",
                vec![InvalidRequiredTools],
            ),
            (
                "---\nname: x\ndescription: y\nrequired-capabilities: [\"two words\"]\n---\n",
                vec![InvalidRequiredCapabilities],
            ),
        ] {
            assert_eq!(validate_front_matter(text), Err(errors), "{text:?}");
        }
        // `yes` is a string in YAML 1.2, so it names the Skill.
        assert!(validate_front_matter("---\nname: yes\ndescription: y\n---\n").is_ok());
    }

    #[test]
    fn a_source_is_named_for_its_folder_or_its_file() {
        let id = |path: &str| source_id_from_path(Path::new(path));
        assert_eq!(id("/skills/Research Brief/SKILL.md").as_deref(), Some("research-brief"));
        assert_eq!(id("/skills/research/skill.MD").as_deref(), Some("research"));
        assert_eq!(id("/tmp/My  Notes!.md").as_deref(), Some("my-notes"));
        assert_eq!(id("/tmp/v1.2_draft.markdown").as_deref(), Some("v1.2_draft"));
        assert_eq!(id("/tmp/研究.md"), None, "nothing usable is left");
        assert_eq!(id(&format!("/tmp/{}.md", "a".repeat(100))).map(|id| id.len()), Some(80));
    }
}
