//! The SVG sniffer, which needs none of the renderer (`svg` off as well).

pub(super) fn sniff_text(bytes: &[u8]) -> bool {
    let mut rest = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    loop {
        rest = rest.trim_ascii_start();
        let skipped = if rest.starts_with(b"<?") {
            after(rest, b"?>")
        } else if rest.starts_with(b"<!--") {
            after(rest, b"-->")
        } else if rest.starts_with(b"<!") {
            // A doctype, maybe with an internal subset (`[ ... ]`).
            match (find(rest, b"["), find(rest, b">")) {
                (Some(open), Some(close)) if open < close => {
                    after(&rest[open..], b"]").and_then(|r| after(r, b">"))
                }
                _ => after(rest, b">"),
            }
        } else {
            break;
        };
        match skipped {
            Some(r) => rest = r,
            None => return false,
        }
    }
    rest.starts_with(b"<svg")
        && matches!(
            rest.get(4),
            Some(b' ' | b'\t' | b'\r' | b'\n' | b'>' | b'/')
        )
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn after<'a>(haystack: &'a [u8], needle: &[u8]) -> Option<&'a [u8]> {
    find(haystack, needle).map(|i| &haystack[i + needle.len()..])
}
