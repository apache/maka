//! `TextEncoder` and `TextDecoder` (Encoding Standard). Decoding knows
//! UTF-8, UTF-16LE / BE and windows-1252 (the labels of latin1 and ASCII
//! too); streaming decodes keep a sequence cut between chunks.

use super::{
    Class, Key, Object, Spec, data, instance,
    js::{self, Ctx, R, Raw, V, native, trace},
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    Windows1252,
}

impl Encoding {
    /// The encoding a label names (WHATWG labels, ASCII case-insensitive).
    pub(crate) fn from_label(label: &str) -> Option<Encoding> {
        let label = label
            .trim_matches(|c: char| c.is_ascii_whitespace())
            .to_ascii_lowercase();
        Some(match label.as_str() {
            "unicode-1-1-utf-8" | "unicode11utf8" | "unicode20utf8" | "utf-8" | "utf8"
            | "x-unicode20utf8" => Encoding::Utf8,
            "csunicode" | "iso-10646-ucs-2" | "ucs-2" | "unicode" | "unicodefeff" | "utf-16"
            | "utf-16le" => Encoding::Utf16Le,
            "unicodefffe" | "utf-16be" => Encoding::Utf16Be,
            "ansi_x3.4-1968" | "ascii" | "cp1252" | "cp819" | "csisolatin1" | "ibm819"
            | "iso-8859-1" | "iso-ir-100" | "iso8859-1" | "iso88591" | "iso_8859-1"
            | "iso_8859-1:1987" | "l1" | "latin1" | "us-ascii" | "windows-1252" | "x-cp1252" => {
                Encoding::Windows1252
            }
            _ => return None,
        })
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Encoding::Utf8 => "utf-8",
            Encoding::Utf16Le => "utf-16le",
            Encoding::Utf16Be => "utf-16be",
            Encoding::Windows1252 => "windows-1252",
        }
    }
}

/// windows-1252's 0x80..0x9F (the rest is Latin-1).
const W1252: [u16; 32] = [
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039,
    0x0152, 0x008D, 0x017D, 0x008F, 0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
];

/// A decoder's state between `decode(…, { stream: true })` calls.
pub(crate) struct Decoder {
    pub(crate) encoding: Encoding,
    pub(crate) fatal: bool,
    pub(crate) ignore_bom: bool,
    /// Bytes of a sequence cut at the end of the last chunk.
    pending: Vec<u8>,
    /// The start of the stream was seen (its BOM handled).
    started: bool,
}

/// Decoding failed (`fatal`).
pub(crate) struct Malformed;

impl Decoder {
    pub(crate) fn new(encoding: Encoding, fatal: bool, ignore_bom: bool) -> Decoder {
        Decoder {
            encoding,
            fatal,
            ignore_bom,
            pending: Vec::new(),
            started: false,
        }
    }

    /// Decodes `input`; `stream`: more follows (a cut sequence waits).
    pub(crate) fn decode(&mut self, input: &[u8], stream: bool) -> Result<String, Malformed> {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(input);
        let mut start = 0;
        if !self.started && !bytes.is_empty() {
            let bom: &[u8] = match self.encoding {
                Encoding::Utf8 => b"\xEF\xBB\xBF",
                Encoding::Utf16Le => b"\xFF\xFE",
                Encoding::Utf16Be => b"\xFE\xFF",
                Encoding::Windows1252 => b"",
            };
            if !bom.is_empty() && bytes.len() < bom.len() && bom.starts_with(&bytes) && stream {
                // Not yet known whether this is a BOM.
                self.pending = bytes;
                return Ok(String::new());
            }
            self.started = true;
            if !self.ignore_bom && !bom.is_empty() && bytes.starts_with(bom) {
                start = bom.len();
            }
        }
        let bytes = &bytes[start..];
        let out = match self.encoding {
            Encoding::Utf8 => self.utf8(bytes, stream),
            Encoding::Utf16Le | Encoding::Utf16Be => self.utf16(bytes, stream),
            Encoding::Windows1252 => Ok(bytes
                .iter()
                .map(|&b| match b {
                    0x80..=0x9F => {
                        char::from_u32(u32::from(W1252[(b - 0x80) as usize])).unwrap_or('\u{FFFD}')
                    }
                    _ => char::from(b),
                })
                .collect()),
        };
        if !stream {
            self.started = false;
            self.pending.clear();
        }
        out
    }

    fn utf8(&mut self, bytes: &[u8], stream: bool) -> Result<String, Malformed> {
        let mut end = bytes.len();
        if stream {
            // A sequence cut at the end waits for the next chunk.
            if let Err(e) = std::str::from_utf8(bytes)
                && e.error_len().is_none()
            {
                end = e.valid_up_to();
                self.pending = bytes[end..].to_vec();
            }
        }
        let bytes = &bytes[..end];
        match std::str::from_utf8(bytes) {
            Ok(s) => Ok(s.to_owned()),
            Err(_) if self.fatal => Err(Malformed),
            // Rust replaces maximal subparts, as the Encoding Standard does.
            Err(_) => Ok(String::from_utf8_lossy(bytes).into_owned()),
        }
    }

    fn utf16(&mut self, bytes: &[u8], stream: bool) -> Result<String, Malformed> {
        let le = self.encoding == Encoding::Utf16Le;
        let units = bytes.len() / 2;
        let unit = |i: usize| {
            let (a, b) = (bytes[i * 2], bytes[i * 2 + 1]);
            if le {
                u16::from_le_bytes([a, b])
            } else {
                u16::from_be_bytes([a, b])
            }
        };
        let mut codes: Vec<u16> = (0..units).map(unit).collect();
        let mut cut = bytes.len() % 2;
        // A high surrogate at the end may pair with the next chunk.
        if stream
            && let Some(&last) = codes.last()
            && (0xD800..0xDC00).contains(&last)
        {
            codes.pop();
            cut += 2;
        }
        if stream {
            self.pending = bytes[bytes.len() - cut..].to_vec();
        }
        let mut out = String::with_capacity(codes.len());
        for r in char::decode_utf16(codes.iter().copied()) {
            match r {
                Ok(c) => out.push(c),
                Err(_) if self.fatal => return Err(Malformed),
                Err(_) => out.push('\u{FFFD}'),
            }
        }
        if !stream && cut > 0 {
            if self.fatal {
                return Err(Malformed);
            }
            out.push('\u{FFFD}');
        }
        Ok(out)
    }
}

trace!(Decoder {});

impl Object for Decoder {}

/// `TextEncoder` has no state.
struct Encoder;

trace!(Encoder {});

impl Object for Encoder {}

native!(
    fn encoder_constructor(cx, this, args) {
        instance(cx, this, Class::TextEncoder, Encoder)
    }
);

native!(
    fn encoder_encoding(cx, this, args) {
        data::<Encoder>(cx, this, "TextEncoder")?;
        js::string(cx, "utf-8")
    }
);

native!(
    fn encoder_encode(cx, this, args) {
        data::<Encoder>(cx, this, "TextEncoder")?;
        let s = js::opt_string(cx, args.get(0))?.unwrap_or_default();
        js::uint8_array(cx, s.as_bytes())
    }
);

native!(
    fn encoder_encode_into(cx, this, args) {
        data::<Encoder>(cx, this, "TextEncoder")?;
        let s = js::to_string(cx, args.get(0))?;
        let dest = args.get(1);
        // Bindgen types C enums as `u32`, but as `i32` with MSVC, where the
        // cast does nothing.
        #[allow(clippy::unnecessary_cast)]
        // SAFETY: a typed array's kind, read inline.
        if unsafe { rquickjs::qjs::JS_GetTypedArrayType(dest) }
            != rquickjs::qjs::JSTypedArrayEnum_JS_TYPED_ARRAY_UINT8 as i32
        {
            return Err(js::type_error(cx, "encodeInto needs a Uint8Array"));
        }
        // SAFETY: written before any JS runs.
        let out = unsafe { js::bytes_mut(cx, dest) }.unwrap_or_default();
        let (mut read, mut written) = (0usize, 0usize);
        for ch in s.chars() {
            let n = ch.len_utf8();
            if written + n > out.len() {
                break;
            }
            ch.encode_utf8(&mut out[written..written + n]);
            written += n;
            read += ch.len_utf16();
        }
        let r = js::new_object(cx)?;
        js::define(cx, r.raw(), "read", V::num(read as f64), true)?;
        js::define(cx, r.raw(), "written", V::num(written as f64), true)?;
        Ok(r)
    }
);

/// The encoding, `fatal` and `ignoreBOM` of a decoder's arguments.
pub(crate) fn decoder_options(cx: Ctx, label: Raw, options: Raw) -> R<Decoder> {
    let label = js::opt_string(cx, label)?.unwrap_or_else(|| "utf-8".to_owned());
    let encoding = Encoding::from_label(&label).ok_or_else(|| {
        js::range_error(cx, &format!("The encoding \"{label}\" is not supported"))
    })?;
    let (fatal, ignore_bom) = if js::is_object(options) {
        let f = js::get(cx, options, "fatal")?;
        let i = js::get(cx, options, "ignoreBOM")?;
        (js::to_bool(cx, f.raw()), js::to_bool(cx, i.raw()))
    } else if js::is_nullish(options) {
        (false, false)
    } else {
        return Err(js::type_error(cx, "TextDecoder options must be an object"));
    };
    Ok(Decoder::new(encoding, fatal, ignore_bom))
}

native!(
    fn decoder_constructor(cx, this, args) {
        let d = decoder_options(cx, args.get(0), args.get(1))?;
        instance(cx, this, Class::TextDecoder, d)
    }
);

fn decoder<'a>(cx: Ctx, v: Raw) -> R<std::cell::RefMut<'a, Decoder>> {
    data::<Decoder>(cx, v, "TextDecoder")
}

native!(
    fn decoder_encoding(cx, this, args) {
        let name = decoder(cx, this)?.encoding.name();
        js::string(cx, name)
    }
);

native!(
    fn decoder_fatal(cx, this, args) {
        Ok(V::bool(decoder(cx, this)?.fatal))
    }
);

native!(
    fn decoder_ignore_bom(cx, this, args) {
        Ok(V::bool(decoder(cx, this)?.ignore_bom))
    }
);

native!(
    fn decoder_decode(cx, this, args) {
        let options = args.get(1);
        let stream = if js::is_object(options) {
            let s = js::get(cx, options, "stream")?;
            js::to_bool(cx, s.raw())
        } else {
            false
        };
        let input = args.get(0);
        // Read before borrowing the decoder (a getter may run JS).
        let bytes = if js::is_undefined(input) {
            Vec::new()
        } else {
            js::buffer_source(cx, input).ok_or_else(|| {
                js::type_error(cx, "The provided value is not an ArrayBuffer or ArrayBufferView")
            })?
        };
        let decoded = decoder(cx, this)?.decode(&bytes, stream);
        match decoded {
            Ok(s) => js::string(cx, &s),
            Err(Malformed) => Err(js::type_error(cx, "The encoded data was not valid")),
        }
    }
);

pub(crate) const SPECS: &[Spec] = &[
    Spec {
        class: Class::TextEncoder,
        name: c"TextEncoder",
        parent: None,
        constructor: Some((encoder_constructor, 0)),
        methods: &[
            (Key::Name(c"encode"), encoder_encode, 0),
            (Key::Name(c"encodeInto"), encoder_encode_into, 2),
        ],
        accessors: &[(c"encoding", encoder_encoding, None)],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "",
            members: r#"readonly encoding: "utf-8";
encode(input?: string): Uint8Array;
encodeInto(source: string, destination: Uint8Array): { read: number; written: number };"#,
        }
        .declared(),
    },
    Spec {
        class: Class::TextDecoder,
        name: c"TextDecoder",
        parent: None,
        constructor: Some((decoder_constructor, 0)),
        methods: &[(Key::Name(c"decode"), decoder_decode, 0)],
        accessors: &[
            (c"encoding", decoder_encoding, None),
            (c"fatal", decoder_fatal, None),
            (c"ignoreBOM", decoder_ignore_bom, None),
        ],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "UTF-8, UTF-16LE / BE and windows-1252 (with the labels of latin1 and ASCII).",
            head: "",
            members: r#"constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
readonly encoding: string;
readonly fatal: boolean;
readonly ignoreBOM: boolean;
decode(input?: BufferSource, options?: { stream?: boolean }): string;"#,
        }
        .declared(),
    },
];

/// The TypeScript types of this file's classes (`globals.d.ts`).
pub(crate) const TYPES: &str = r#"type BufferSource = ArrayBuffer | ArrayBufferView;
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_keeps_cut_sequences() {
        let mut d = Decoder::new(Encoding::Utf8, false, false);
        let bytes = "\u{FEFF}é👋".as_bytes();
        let mut out = String::new();
        for b in bytes {
            out.push_str(&d.decode(&[*b], true).ok().unwrap());
        }
        out.push_str(&d.decode(&[], false).ok().unwrap());
        assert_eq!(out, "é👋");
        // Cut at the end of a non-streaming call: a replacement.
        assert_eq!(d.decode(b"a\xF0\x9F", false).ok().unwrap(), "a\u{FFFD}");
        let mut le = Decoder::new(Encoding::Utf16Le, false, false);
        let units: Vec<u8> = "👋x".encode_utf16().flat_map(u16::to_le_bytes).collect();
        let (a, b) = units.split_at(3);
        let s = le.decode(a, true).ok().unwrap() + &le.decode(b, false).ok().unwrap();
        assert_eq!(s, "👋x");
        let mut w = Decoder::new(Encoding::from_label(" Latin1 ").unwrap(), false, false);
        assert_eq!(w.decode(b"\x80\xE9", false).ok().unwrap(), "€é");
        assert!(
            Decoder::new(Encoding::Utf8, true, false)
                .decode(b"\xFF", false)
                .is_err()
        );
    }
}
