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

//! Capability-scoped workspace declaration, reference, and signature-hover index.

use super::{
    CodeBackend, CodeDefinitionResult, CodeHoverResult, CodeLocation, CodePosition, CodeRange,
    CodeReferencesResult,
};
use crate::{
    files::{Directory, FileCapture},
    path::WorkspacePath,
};
use std::{collections::HashSet, io, sync::atomic::AtomicBool};

const MAX_SCAN_FILE_BYTES: u64 = 512 * 1024;
const MAX_SCAN_FILES: usize = 4096;
const MAX_DEFINITIONS: usize = 16;
const MAX_REFERENCES: usize = 200;
const MAX_PREVIEW_CHARS: usize = 160;

#[derive(Clone, Debug)]
pub struct TargetSymbol {
    pub name: String,
    pub range: Option<CodeRange>,
    pub source_text: Option<String>,
}

pub fn resolve_target(
    directory: &Directory,
    path: &WorkspacePath,
    position: CodePosition,
    explicit_symbol: Option<&str>,
    cancel: &AtomicBool,
) -> io::Result<Option<TargetSymbol>> {
    if let Some(raw) = explicit_symbol {
        let trimmed = raw.trim();
        if is_valid_symbol(trimmed) {
            let source_text = read_text(directory, path, cancel)?;
            return Ok(Some(TargetSymbol {
                name: trimmed.to_owned(),
                range: None,
                source_text,
            }));
        }
    }
    let Some(text) = read_text(directory, path, cancel)? else {
        return Ok(None);
    };
    let Some((name, range)) = symbol_at(&text, position) else {
        return Ok(None);
    };
    Ok(Some(TargetSymbol {
        name,
        range: Some(range),
        source_text: Some(text),
    }))
}

pub fn definition(
    directory: &Directory,
    origin_path: &WorkspacePath,
    target: &TargetSymbol,
    cancel: &AtomicBool,
) -> io::Result<CodeDefinitionResult> {
    let origin_display = path_string(origin_path);
    let origin_dir = parent_dir(&origin_display);
    let import_hints = target
        .source_text
        .as_deref()
        .map(|text| extract_import_hints(text, &target.name))
        .unwrap_or_default();

    let mut ranked: Vec<(i32, String, CodeLocation)> = Vec::new();

    if let Some(source_text) = target.source_text.as_deref() {
        for cand in find_declarations_in_file(
            origin_path,
            &origin_display,
            source_text,
            &target.name,
            true,
        ) {
            let score = cand.score + 40;
            ranked.push((score, origin_display.clone(), cand.location));
        }
    }

    directory.visit_text_files(
        MAX_SCAN_FILE_BYTES,
        MAX_SCAN_FILES,
        cancel,
        |ws_path, display, content| {
            if ws_path == *origin_path && target.source_text.is_some() {
                return Ok(true);
            }
            if !content.contains(&target.name) {
                return Ok(true);
            }
            let same_file = ws_path == *origin_path;
            for cand in
                find_declarations_in_file(&ws_path, &display, &content, &target.name, same_file)
            {
                let mut bonus = 0;
                if same_file {
                    bonus += 40;
                } else if parent_dir(&display) == origin_dir && !origin_dir.is_empty() {
                    bonus += 15;
                }
                if import_hints.iter().any(|hint| display.contains(hint)) {
                    bonus += 30;
                }
                ranked.push((cand.score + bonus, display.clone(), cand.location));
            }
            Ok(true)
        },
    )?;

    ranked.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.range.start.line.cmp(&right.2.range.start.line))
    });

    let mut seen = HashSet::new();
    let mut locations = Vec::new();
    for (_, display, loc) in ranked {
        if seen.insert((display, loc.range.start.line, loc.range.start.column)) {
            locations.push(loc);
            if locations.len() >= MAX_DEFINITIONS {
                break;
            }
        }
    }

    Ok(CodeDefinitionResult {
        backend: CodeBackend::Indexed,
        symbol: target.name.clone(),
        origin_range: target.range,
        locations,
    })
}

pub fn references(
    directory: &Directory,
    origin_path: &WorkspacePath,
    target: &TargetSymbol,
    include_declaration: bool,
    cancel: &AtomicBool,
) -> io::Result<CodeReferencesResult> {
    let origin_display = path_string(origin_path);
    let origin_dir = parent_dir(&origin_display);
    let mut entries: Vec<(u8, String, CodeLocation)> = Vec::new();
    let mut truncated = false;

    let mut collect_file =
        |ws_path: &WorkspacePath, display: &str, content: &str, tier: u8| -> bool {
            if !content.contains(&target.name) {
                return true;
            }
            let file_decls: HashSet<(u64, u64)> = if include_declaration {
                HashSet::new()
            } else {
                find_declarations_in_file(ws_path, display, content, &target.name, tier == 0)
                    .into_iter()
                    .map(|d| (d.location.range.start.line, d.location.range.start.column))
                    .collect()
            };
            for (line_idx, raw_line) in content.lines().enumerate() {
                if !raw_line.contains(&target.name) {
                    continue;
                }
                let code_slice = strip_line_comment(raw_line, display);
                for byte_col in word_matches(code_slice, &target.name) {
                    let start_col = byte_to_utf16_col(raw_line, byte_col);
                    let end_col = byte_to_utf16_col(raw_line, byte_col + target.name.len());
                    let line_u64 = line_idx as u64;
                    if !include_declaration && file_decls.contains(&(line_u64, start_col)) {
                        continue;
                    }
                    if entries.len() >= MAX_REFERENCES {
                        truncated = true;
                        return false;
                    }
                    entries.push((
                        tier,
                        display.to_owned(),
                        CodeLocation {
                            path: ws_path.clone(),
                            range: CodeRange {
                                start: CodePosition {
                                    line: line_u64,
                                    column: start_col,
                                },
                                end: CodePosition {
                                    line: line_u64,
                                    column: end_col,
                                },
                            },
                            preview: trim_preview(raw_line),
                        },
                    ));
                }
            }
            true
        };

    // Always collect tier-0 current-file matches first so truncation never drops local references.
    let keep_scanning = match target.source_text.as_deref() {
        Some(source_text) => collect_file(origin_path, &origin_display, source_text, 0),
        None => true,
    };

    if keep_scanning {
        directory.visit_text_files(
            MAX_SCAN_FILE_BYTES,
            MAX_SCAN_FILES,
            cancel,
            |ws_path, display, content| {
                if ws_path == *origin_path && target.source_text.is_some() {
                    return Ok(true);
                }
                let tier = if ws_path == *origin_path {
                    0
                } else if parent_dir(&display) == origin_dir && !origin_dir.is_empty() {
                    1
                } else {
                    2
                };
                Ok(collect_file(&ws_path, &display, &content, tier))
            },
        )?;
    }

    entries.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.range.start.line.cmp(&right.2.range.start.line))
            .then_with(|| left.2.range.start.column.cmp(&right.2.range.start.column))
    });

    Ok(CodeReferencesResult {
        backend: CodeBackend::Indexed,
        symbol: target.name.clone(),
        locations: entries.into_iter().map(|(_, _, loc)| loc).collect(),
        truncated,
    })
}

pub fn hover(
    directory: &Directory,
    origin_path: &WorkspacePath,
    target: &TargetSymbol,
    cancel: &AtomicBool,
) -> io::Result<Option<CodeHoverResult>> {
    let defs = definition(directory, origin_path, target, cancel)?;
    let Some(best) = defs.locations.first() else {
        return Ok(None);
    };
    let content = if *origin_path == best.path {
        match target.source_text.clone() {
            Some(text) => Some(text),
            None => read_text(directory, &best.path, cancel)?,
        }
    } else {
        read_text(directory, &best.path, cancel)?
    };
    let Some(text) = content else {
        return Ok(None);
    };
    let display = path_string(&best.path);
    let lang = language_fence(&display);
    let lines: Vec<&str> = text.lines().collect();
    let idx = best.range.start.line as usize;
    if idx >= lines.len() {
        return Ok(None);
    }

    let docs = extract_leading_docs(&lines, idx);
    let sig = extract_signature(&lines, idx);
    let mut md = format!("```{lang}\n{sig}\n```");
    if !docs.is_empty() {
        md.push_str("\n\n");
        md.push_str(&docs);
    }
    md.push_str(&format!("\n\n*{display}:{}*", idx + 1));

    Ok(Some(CodeHoverResult {
        backend: CodeBackend::Indexed,
        symbol: target.name.clone(),
        range: target.range,
        markdown: md,
    }))
}

pub fn read_text(
    directory: &Directory,
    path: &WorkspacePath,
    cancel: &AtomicBool,
) -> io::Result<Option<String>> {
    match directory.read_file(path, None, cancel) {
        Ok(FileCapture::Ready(snapshot)) => Ok(String::from_utf8(snapshot.data).ok()),
        Ok(_) => Ok(None),
        Err(err) => {
            let msg = err.to_string();
            if msg == "files_cancelled" || msg == "files_changed" {
                Err(err)
            } else {
                Ok(None)
            }
        }
    }
}

pub fn line_preview(text: &str, line: u64) -> String {
    text.lines()
        .nth(line as usize)
        .map(trim_preview)
        .unwrap_or_default()
}

pub fn symbol_at(text: &str, position: CodePosition) -> Option<(String, CodeRange)> {
    let line_str = text.lines().nth(position.line as usize)?;
    let byte_pos = utf16_col_to_byte(line_str, position.column);
    let chars: Vec<(usize, char)> = line_str.char_indices().collect();
    if chars.is_empty() {
        return None;
    }
    let mut pivot = chars
        .iter()
        .position(|(idx, _)| *idx >= byte_pos)
        .unwrap_or(chars.len() - 1);
    if !is_ident_char(chars[pivot].1) {
        if pivot > 0 && chars[pivot].0 == byte_pos && is_ident_char(chars[pivot - 1].1) {
            pivot -= 1;
        } else {
            return None;
        }
    }
    let mut start = pivot;
    while start > 0 && is_ident_char(chars[start - 1].1) {
        start -= 1;
    }
    let mut end = pivot;
    while end + 1 < chars.len() && is_ident_char(chars[end + 1].1) {
        end += 1;
    }
    let start_byte = chars[start].0;
    let end_byte = chars[end].0 + chars[end].1.len_utf8();
    let candidate = &line_str[start_byte..end_byte];
    if !is_valid_symbol(candidate) {
        return None;
    }
    Some((
        candidate.to_owned(),
        CodeRange {
            start: CodePosition {
                line: position.line,
                column: byte_to_utf16_col(line_str, start_byte),
            },
            end: CodePosition {
                line: position.line,
                column: byte_to_utf16_col(line_str, end_byte),
            },
        },
    ))
}

pub fn utf16_col_to_byte(line: &str, col_utf16: u64) -> usize {
    let mut units = 0_u64;
    for (byte_idx, ch) in line.char_indices() {
        if units >= col_utf16 {
            return byte_idx;
        }
        units += ch.len_utf16() as u64;
    }
    line.len()
}

pub fn byte_to_utf16_col(line: &str, target_byte: usize) -> u64 {
    let clamped = target_byte.min(line.len());
    line[..clamped].encode_utf16().count() as u64
}

fn is_ident_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '$'
}

pub fn is_valid_symbol(candidate: &str) -> bool {
    if candidate.is_empty() || candidate.len() > 128 {
        return false;
    }
    let mut chars = candidate.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if first.is_ascii_digit() || !is_ident_char(first) {
        return false;
    }
    if !chars.all(is_ident_char) {
        return false;
    }
    !matches!(
        candidate,
        "if" | "else"
            | "for"
            | "while"
            | "loop"
            | "match"
            | "switch"
            | "case"
            | "return"
            | "break"
            | "continue"
            | "let"
            | "const"
            | "var"
            | "mut"
            | "pub"
            | "fn"
            | "def"
            | "func"
            | "async"
            | "await"
            | "yield"
            | "import"
            | "export"
            | "from"
            | "use"
            | "mod"
            | "impl"
            | "where"
            | "true"
            | "false"
            | "null"
            | "undefined"
            | "None"
            | "Some"
            | "Ok"
            | "Err"
    )
}

struct DeclCandidate {
    score: i32,
    location: CodeLocation,
}

fn find_declarations_in_file(
    ws_path: &WorkspacePath,
    display: &str,
    content: &str,
    symbol: &str,
    include_locals: bool,
) -> Vec<DeclCandidate> {
    let mut results = Vec::new();
    let mut in_block_comment = false;

    for (line_idx, raw_line) in content.lines().enumerate() {
        let code = strip_comments_stateful(raw_line, display, &mut in_block_comment);
        if !code.contains(symbol) {
            continue;
        }
        let trimmed = code.trim_start();
        if trimmed.is_empty()
            || trimmed.starts_with("use ")
            || trimmed.starts_with("pub use ")
            || trimmed.starts_with("import ")
            || trimmed.starts_with("from ")
        {
            continue;
        }
        if let Some((byte_col_in_code, score)) =
            match_declaration_line(&code, symbol, display, include_locals)
        {
            let byte_col = raw_line
                .find(&code[byte_col_in_code..byte_col_in_code + symbol.len()])
                .and_then(|_| find_exact_in_raw(raw_line, symbol, byte_col_in_code))
                .unwrap_or(0);
            let start_col = byte_to_utf16_col(raw_line, byte_col);
            let end_col = byte_to_utf16_col(raw_line, byte_col + symbol.len());
            results.push(DeclCandidate {
                score,
                location: CodeLocation {
                    path: ws_path.clone(),
                    range: CodeRange {
                        start: CodePosition {
                            line: line_idx as u64,
                            column: start_col,
                        },
                        end: CodePosition {
                            line: line_idx as u64,
                            column: end_col,
                        },
                    },
                    preview: trim_preview(raw_line),
                },
            });
        }
    }
    results
}

fn find_exact_in_raw(raw: &str, symbol: &str, hint: usize) -> Option<usize> {
    let matches = word_matches(raw, symbol);
    matches.into_iter().min_by_key(|pos| pos.abs_diff(hint))
}

fn match_declaration_line(
    code: &str,
    symbol: &str,
    path: &str,
    include_locals: bool,
) -> Option<(usize, i32)> {
    const PRIMARY_KEYWORDS: &[(&str, i32)] = &[
        ("fn ", 100),
        ("struct ", 105),
        ("enum ", 105),
        ("trait ", 105),
        ("type ", 100),
        ("interface ", 105),
        ("class ", 105),
        ("function ", 100),
        ("def ", 100),
        ("func ", 100),
        ("protocol ", 100),
        ("macro_rules! ", 95),
        ("mod ", 85),
        ("#define ", 95),
    ];
    const BINDING_KEYWORDS: &[(&str, i32)] = &[
        ("const ", 88),
        ("static ", 88),
        ("let mut ", 65),
        ("let ", 65),
        ("var ", 65),
    ];

    let exported = {
        let t = code.trim_start();
        t.starts_with("pub ") || t.starts_with("pub(") || t.starts_with("export ")
    };
    let indent = code.len() - code.trim_start().len();

    for &(kw, base_score) in PRIMARY_KEYWORDS {
        if let Some(pos) = keyword_followed_by_symbol(code, kw, symbol) {
            let bonus = if exported { 12 } else { 0 };
            return Some((pos, base_score + bonus));
        }
    }

    // Go receiver methods: func (r *Repo) Symbol(...)
    if path.ends_with(".go")
        && code.trim_start().starts_with("func (")
        && let Some(close) = code.find(')')
    {
        let rest = &code[close + 1..];
        let trimmed = rest.trim_start();
        if has_leading_symbol(trimmed, symbol) {
            let offset = code.len() - trimmed.len();
            return Some((offset, 102));
        }
    }

    for &(kw, base_score) in BINDING_KEYWORDS {
        if !include_locals && indent > 0 && (kw == "let " || kw == "let mut " || kw == "var ") {
            continue;
        }
        if let Some(pos) = keyword_followed_by_symbol(code, kw, symbol) {
            let top_bonus = if indent == 0 { 15 } else { 0 };
            let exp_bonus = if exported { 12 } else { 0 };
            return Some((pos, base_score + top_bonus + exp_bonus));
        }
    }

    // TS/JS/Class method or typed field: e.g. `  openLink(target: string)` or `async openLink(`
    if matches_ts_or_class_member(code, symbol, path) {
        let pos = word_matches(code, symbol).into_iter().next()?;
        return Some((pos, 78));
    }

    // Python/Ruby/Toml/Makefile top-level assignment: `SYMBOL = ...`
    if (indent == 0 || include_locals)
        && let Some(pos) = assignment_target(code, symbol)
    {
        let score = if indent == 0 { 76 } else { 55 };
        return Some((pos, score));
    }

    None
}

fn keyword_followed_by_symbol(code: &str, keyword: &str, symbol: &str) -> Option<usize> {
    let mut search_from = 0;
    while let Some(rel) = code[search_from..].find(keyword) {
        let kw_pos = search_from + rel;
        let before_ok =
            kw_pos == 0 || !is_ident_char(code[..kw_pos].chars().next_back().unwrap_or(' '));
        let after_kw = kw_pos + keyword.len();
        if before_ok {
            let rest = &code[after_kw..];
            let trimmed = rest.trim_start_matches([' ', '\t', '*']);
            if has_leading_symbol(trimmed, symbol) {
                let sym_pos = code.len() - trimmed.len();
                return Some(sym_pos);
            }
        }
        search_from = after_kw;
    }
    None
}

fn matches_ts_or_class_member(code: &str, symbol: &str, path: &str) -> bool {
    if !(path.ends_with(".ts")
        || path.ends_with(".tsx")
        || path.ends_with(".js")
        || path.ends_with(".jsx")
        || path.ends_with(".mjs")
        || path.ends_with(".java")
        || path.ends_with(".kt")
        || path.ends_with(".swift"))
    {
        return false;
    }
    let mut t = code.trim_start();
    for modifier in [
        "public ",
        "private ",
        "protected ",
        "readonly ",
        "static ",
        "override ",
        "abstract ",
        "async ",
        "get ",
        "set ",
    ] {
        if let Some(stripped) = t.strip_prefix(modifier) {
            t = stripped.trim_start();
        }
    }
    if !has_leading_symbol(t, symbol) {
        return false;
    }
    let after = t[symbol.len()..].trim_start();
    after.starts_with('(')
        || after.starts_with('<')
        || after.starts_with(':')
        || after.starts_with("?:")
}

fn assignment_target(code: &str, symbol: &str) -> Option<usize> {
    let trimmed = code.trim_start();
    if !has_leading_symbol(trimmed, symbol) {
        return None;
    }
    let after = trimmed[symbol.len()..].trim_start();
    if (after.starts_with('=') && !after.starts_with("==") && !after.starts_with("=>"))
        || (after.starts_with(':') && !after.starts_with("::"))
    {
        Some(code.len() - trimmed.len())
    } else {
        None
    }
}

fn has_leading_symbol(s: &str, symbol: &str) -> bool {
    s.starts_with(symbol) && !s[symbol.len()..].chars().next().is_some_and(is_ident_char)
}

pub fn word_matches(haystack: &str, symbol: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(symbol) {
        let pos = from + rel;
        let before_ok =
            pos == 0 || !is_ident_char(haystack[..pos].chars().next_back().unwrap_or(' '));
        let end = pos + symbol.len();
        let after_ok =
            end == haystack.len() || !is_ident_char(haystack[end..].chars().next().unwrap_or(' '));
        if before_ok && after_ok {
            out.push(pos);
        }
        from = pos + symbol.chars().next().map_or(1, char::len_utf8);
    }
    out
}

fn strip_line_comment<'a>(line: &'a str, path: &str) -> &'a str {
    let hash_comments = path.ends_with(".py")
        || path.ends_with(".sh")
        || path.ends_with(".toml")
        || path.ends_with(".yaml")
        || path.ends_with(".yml")
        || path.ends_with(".rb");
    let mut in_str: Option<char> = None;
    let mut escaped = false;
    let bytes = line.as_bytes();
    for (idx, ch) in line.char_indices() {
        if let Some(quote) = in_str {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == quote {
                in_str = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' || ch == '`' {
            in_str = Some(ch);
            continue;
        }
        if ch == '/' && bytes.get(idx + 1) == Some(&b'/') {
            return &line[..idx];
        }
        if hash_comments && ch == '#' {
            return &line[..idx];
        }
    }
    line
}

fn strip_comments_stateful(line: &str, path: &str, in_block: &mut bool) -> String {
    let mut out = String::with_capacity(line.len());
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    let mut in_str: Option<char> = None;
    let hash_comments = path.ends_with(".py")
        || path.ends_with(".sh")
        || path.ends_with(".toml")
        || path.ends_with(".yaml")
        || path.ends_with(".yml");

    while i < chars.len() {
        if *in_block {
            if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                *in_block = false;
                out.push_str("  ");
                i += 2;
            } else {
                out.push(' ');
                i += 1;
            }
            continue;
        }
        if let Some(q) = in_str {
            out.push(' ');
            if chars[i] == '\\' {
                if i + 1 < chars.len() {
                    out.push(' ');
                }
                i += 2;
                continue;
            }
            if chars[i] == q {
                in_str = None;
            }
            i += 1;
            continue;
        }
        if chars[i] == '/' && chars.get(i + 1) == Some(&'/') {
            break;
        }
        if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
            *in_block = true;
            out.push_str("  ");
            i += 2;
            continue;
        }
        if hash_comments && chars[i] == '#' {
            break;
        }
        if chars[i] == '"' || chars[i] == '`' {
            in_str = Some(chars[i]);
            out.push(' ');
            i += 1;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn extract_import_hints(text: &str, symbol: &str) -> Vec<String> {
    let mut hints = Vec::new();
    for line in text.lines().take(200) {
        if !line.contains(symbol) && !line.contains("from ") && !line.contains("use ") {
            continue;
        }
        let trimmed = line.trim();
        if (trimmed.starts_with("import ") || trimmed.starts_with("export "))
            && trimmed.contains(symbol)
        {
            for quote in ['\'', '"'] {
                if let Some(start) = trimmed.rfind(quote)
                    && let Some(open) = trimmed[..start].rfind(quote)
                {
                    let spec = trimmed[open + 1..start]
                        .trim_start_matches("./")
                        .trim_start_matches("../")
                        .replace("../", "");
                    if !spec.is_empty() {
                        hints.push(spec);
                    }
                }
            }
        } else if (trimmed.starts_with("use ") || trimmed.starts_with("pub use "))
            && trimmed.contains(symbol)
        {
            for seg in trimmed
                .trim_start_matches("pub ")
                .trim_start_matches("use ")
                .trim_end_matches(';')
                .split("::")
            {
                let clean = seg.trim_matches(|c: char| !is_ident_char(c));
                if !clean.is_empty()
                    && clean != "crate"
                    && clean != "super"
                    && clean != "self"
                    && clean != symbol
                {
                    hints.push(clean.to_owned());
                }
            }
        }
    }
    hints
}

fn extract_leading_docs(lines: &[&str], def_line: usize) -> String {
    let mut doc_lines = Vec::new();
    let mut row = def_line;
    while row > 0 {
        row -= 1;
        let t = lines[row].trim();
        if t.starts_with("#[") || t.starts_with('@') {
            continue;
        }
        if let Some(rest) = t.strip_prefix("///").or_else(|| t.strip_prefix("//!")) {
            doc_lines.push(rest.strip_prefix(' ').unwrap_or(rest).to_owned());
        } else if t.ends_with("*/") {
            let mut block = Vec::new();
            let mut cur = row;
            loop {
                let bt = lines[cur].trim();
                let cleaned = bt
                    .trim_start_matches("/**")
                    .trim_start_matches("/*")
                    .trim_end_matches("*/")
                    .trim_start_matches('*')
                    .trim();
                if !cleaned.is_empty() {
                    block.push(cleaned.to_owned());
                }
                if bt.starts_with("/*") || cur == 0 {
                    break;
                }
                cur -= 1;
            }
            block.reverse();
            return block.join("\n");
        } else if let Some(rest) = t.strip_prefix('#') {
            doc_lines.push(rest.strip_prefix(' ').unwrap_or(rest).to_owned());
        } else {
            break;
        }
    }
    doc_lines.reverse();
    doc_lines.join("\n")
}

fn extract_signature(lines: &[&str], def_line: usize) -> String {
    let mut sig = Vec::new();
    for &line in lines.iter().skip(def_line).take(4) {
        let trimmed_end = line.trim_end();
        if let Some(open_brace) = trimmed_end.find(" {") {
            sig.push(trimmed_end[..open_brace].to_owned());
            break;
        }
        sig.push(trimmed_end.to_owned());
        if trimmed_end.ends_with(';') || trimmed_end.ends_with(':') || trimmed_end.ends_with('{') {
            break;
        }
    }
    sig.join("\n")
}

fn language_fence(path: &str) -> &'static str {
    if path.ends_with(".rs") {
        "rust"
    } else if path.ends_with(".tsx") {
        "tsx"
    } else if path.ends_with(".ts") {
        "ts"
    } else if path.ends_with(".jsx") || path.ends_with(".js") || path.ends_with(".mjs") {
        "js"
    } else if path.ends_with(".py") {
        "python"
    } else if path.ends_with(".go") {
        "go"
    } else if path.ends_with(".c") || path.ends_with(".h") {
        "c"
    } else if path.ends_with(".cpp") || path.ends_with(".hpp") || path.ends_with(".cc") {
        "cpp"
    } else {
        ""
    }
}

fn trim_preview(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.chars().count() <= MAX_PREVIEW_CHARS {
        trimmed.to_owned()
    } else {
        let mut s: String = trimmed.chars().take(MAX_PREVIEW_CHARS).collect();
        s.push('…');
        s
    }
}

pub fn path_string(path: &WorkspacePath) -> String {
    path.bytes()
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

fn parent_dir(path: &str) -> &str {
    path.rfind('/').map_or("", |idx| &path[..idx])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn open_dir(root: &std::path::Path, private: &std::path::Path) -> Directory {
        let (canonical, obs) = crate::directory::capture(root).unwrap();
        let cancel = AtomicBool::new(false);
        Directory::open(&canonical, &obs, private, private, None, None, &cancel).unwrap()
    }

    #[test]
    fn resolves_cross_file_definitions_references_and_hover_docs() {
        let workspace = TempDir::new().unwrap();
        let private = TempDir::new().unwrap();
        fs::create_dir_all(workspace.path().join("src")).unwrap();
        fs::write(
            workspace.path().join("src/store.ts"),
            "/** Opens a workspace link and returns its target. */\nexport function openWorkspaceTarget(id: string): boolean {\n  return id.length > 0;\n}\n",
        )
        .unwrap();
        fs::write(
            workspace.path().join("src/view.ts"),
            "import { openWorkspaceTarget } from './store';\nexport function run() {\n  return openWorkspaceTarget('abc');\n}\n",
        )
        .unwrap();

        let dir = open_dir(workspace.path(), private.path());
        let cancel = Arc::new(AtomicBool::new(false));
        let view_path = WorkspacePath::from_bytes(b"src/view.ts").unwrap();
        let store_path = WorkspacePath::from_bytes(b"src/store.ts").unwrap();

        let target = resolve_target(
            &dir,
            &view_path,
            CodePosition {
                line: 2,
                column: 12,
            },
            None,
            &cancel,
        )
        .unwrap()
        .unwrap();
        assert_eq!(target.name, "openWorkspaceTarget");

        let defs = definition(&dir, &view_path, &target, &cancel).unwrap();
        assert_eq!(defs.locations.len(), 1);
        assert_eq!(defs.locations[0].path, store_path);
        assert_eq!(defs.locations[0].range.start.line, 1);

        let refs = references(&dir, &view_path, &target, true, &cancel).unwrap();
        assert_eq!(refs.locations.len(), 3);

        let refs_usages = references(&dir, &view_path, &target, false, &cancel).unwrap();
        assert_eq!(refs_usages.locations.len(), 2);

        let hov = hover(&dir, &view_path, &target, &cancel).unwrap().unwrap();
        assert!(
            hov.markdown
                .contains("openWorkspaceTarget(id: string): boolean")
        );
        assert!(hov.markdown.contains("Opens a workspace link"));
    }

    #[test]
    fn utf16_columns_handle_non_bmp_characters() {
        let line = "const tag = \"🚀\"; callTarget(tag);";
        let text = format!("{line}\n");
        let byte_idx = line.find("callTarget").unwrap();
        let col = byte_to_utf16_col(line, byte_idx);
        let (sym, range) = symbol_at(
            &text,
            CodePosition {
                line: 0,
                column: col + 2,
            },
        )
        .unwrap();
        assert_eq!(sym, "callTarget");
        assert_eq!(range.start.column, col);
    }
}
