//! `TextEncoderStream` and `TextDecoderStream`: a `TransformStream` each,
//! encoding strings to UTF-8 (a surrogate pair cut between chunks still
//! makes one character) and decoding bytes (`TextDecoder` with
//! `stream: true`).

use std::{cell::RefCell, rc::Rc};

use super::{
    Algo,
    transform::{self, Sides, Transformer, new_transform},
};
use crate::web::{
    Class, Object, Spec, data,
    encoding::{Decoder, Malformed, decoder_options},
    instance,
    js::{self, Ctx, R, Raw, V, native, trace},
};

/// A text stream: its transform stream, and (decoders) the settings.
struct TextStream {
    transform: V,
    decoder: Option<Rc<RefCell<Decoder>>>,
}

trace!(TextStream { transform });

impl Object for TextStream {}

fn text_stream<'a>(cx: Ctx, v: Raw) -> R<std::cell::RefMut<'a, TextStream>> {
    data::<TextStream>(cx, v, "text stream")
}

/// Splits a WTF-8 chunk: a lone high surrogate at the end waits for the
/// next chunk; one waiting from before pairs with a low one at the start.
fn encode_chunk(pending: &mut Option<u16>, mut bytes: &[u8]) -> Vec<u8> {
    let surrogate = |b: &[u8]| -> Option<u16> {
        if b.len() >= 3
            && b[0] == 0xED
            && (0xA0..=0xBF).contains(&b[1])
            && (0x80..=0xBF).contains(&b[2])
        {
            Some(0xD000 | (u16::from(b[1] & 0x3F) << 6) | u16::from(b[2] & 0x3F))
        } else {
            None
        }
    };
    let mut out = Vec::with_capacity(bytes.len() + 4);
    if let Some(high) = pending.take() {
        match surrogate(bytes) {
            Some(low) if (0xDC00..0xE000).contains(&low) => {
                let c = 0x10000 + ((u32::from(high) - 0xD800) << 10) + (u32::from(low) - 0xDC00);
                let mut buf = [0; 4];
                out.extend_from_slice(
                    char::from_u32(c)
                        .unwrap_or('\u{FFFD}')
                        .encode_utf8(&mut buf)
                        .as_bytes(),
                );
                bytes = &bytes[3..];
            }
            _ => out.extend_from_slice("\u{FFFD}".as_bytes()),
        }
    }
    if bytes.len() >= 3
        && let Some(last) = surrogate(&bytes[bytes.len() - 3..])
        && (0xD800..0xDC00).contains(&last)
    {
        *pending = Some(last);
        bytes = &bytes[..bytes.len() - 3];
    }
    out.extend_from_slice(js::from_wtf8(bytes).as_bytes());
    out
}

native!(
    fn encoder_stream_constructor(cx, this, args) {
        let pending = Rc::new(RefCell::new(None::<u16>));
        let p = pending.clone();
        let transform_fn = js::closure(cx, Vec::new(), move |cx, _, args| {
            let bytes = js::to_wtf8(cx, args.get(0))?;
            let out = encode_chunk(&mut p.borrow_mut(), &bytes);
            if !out.is_empty() {
                let chunk = js::uint8_array(cx, &out)?;
                transform::enqueue(cx, args.get(1), chunk.raw())?;
            }
            Ok(V::undefined())
        })?;
        let flush = js::closure(cx, Vec::new(), move |cx, _, args| {
            if pending.borrow_mut().take().is_some() {
                let chunk = js::uint8_array(cx, "\u{FFFD}".as_bytes())?;
                transform::enqueue(cx, args.get(0), chunk.raw())?;
            }
            Ok(V::undefined())
        })?;
        let transformer = Transformer {
            transform: Algo::native(transform_fn),
            flush: Algo::native(flush),
            cancel: Algo::default(),
        };
        let (t, _, start) = new_transform(
            cx,
            js::UNDEFINED,
            Class::TransformStream,
            transformer,
            Sides::default_sides(),
        )?;
        start.resolve(cx, js::UNDEFINED);
        instance(cx, this, Class::TextEncoderStream, TextStream { transform: t, decoder: None })
    }
);

fn decode(cx: Ctx, d: &Rc<RefCell<Decoder>>, bytes: &[u8], stream: bool) -> R<String> {
    match d.borrow_mut().decode(bytes, stream) {
        Ok(s) => Ok(s),
        Err(Malformed) => Err(js::type_error(cx, "The encoded data was not valid")),
    }
}

native!(
    fn decoder_stream_constructor(cx, this, args) {
        let decoder = Rc::new(RefCell::new(decoder_options(cx, args.get(0), args.get(1))?));
        let d = decoder.clone();
        let transform_fn = js::closure(cx, Vec::new(), move |cx, _, args| {
            let bytes = js::buffer_source(cx, args.get(0)).ok_or_else(|| {
                js::type_error(cx, "The provided value is not an ArrayBuffer or ArrayBufferView")
            })?;
            let s = decode(cx, &d, &bytes, true)?;
            if !s.is_empty() {
                let chunk = js::string(cx, &s)?;
                transform::enqueue(cx, args.get(1), chunk.raw())?;
            }
            Ok(V::undefined())
        })?;
        let d = decoder.clone();
        let flush = js::closure(cx, Vec::new(), move |cx, _, args| {
            let s = decode(cx, &d, &[], false)?;
            if !s.is_empty() {
                let chunk = js::string(cx, &s)?;
                transform::enqueue(cx, args.get(0), chunk.raw())?;
            }
            Ok(V::undefined())
        })?;
        let transformer = Transformer {
            transform: Algo::native(transform_fn),
            flush: Algo::native(flush),
            cancel: Algo::default(),
        };
        let (t, _, start) = new_transform(
            cx,
            js::UNDEFINED,
            Class::TransformStream,
            transformer,
            Sides::default_sides(),
        )?;
        start.resolve(cx, js::UNDEFINED);
        instance(cx, this, Class::TextDecoderStream, TextStream { transform: t, decoder: Some(decoder) })
    }
);

native!(
    fn text_readable(cx, this, args) {
        let t = text_stream(cx, this)?.transform.clone_ref();
        js::get(cx, t.raw(), "readable")
    }
);

native!(
    fn text_writable(cx, this, args) {
        let t = text_stream(cx, this)?.transform.clone_ref();
        js::get(cx, t.raw(), "writable")
    }
);

native!(
    fn text_encoding(cx, this, args) {
        let name = match &text_stream(cx, this)?.decoder {
            Some(d) => d.borrow().encoding.name(),
            None => "utf-8",
        };
        js::string(cx, name)
    }
);

native!(
    fn text_fatal(cx, this, args) {
        let fatal = text_stream(cx, this)?.decoder.as_ref().is_some_and(|d| d.borrow().fatal);
        Ok(V::bool(fatal))
    }
);

native!(
    fn text_ignore_bom(cx, this, args) {
        let i = text_stream(cx, this)?.decoder.as_ref().is_some_and(|d| d.borrow().ignore_bom);
        Ok(V::bool(i))
    }
);

pub(crate) const SPECS: &[Spec] = &[
    Spec {
        class: Class::TextEncoderStream,
        name: c"TextEncoderStream",
        parent: None,
        constructor: Some((encoder_stream_constructor, 0)),
        methods: &[],
        accessors: &[
            (c"encoding", text_encoding, None),
            (c"readable", text_readable, None),
            (c"writable", text_writable, None),
        ],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "",
            members: r#"readonly encoding: "utf-8";
readonly readable: ReadableStream<Uint8Array>;
readonly writable: WritableStream<string>;"#,
        }
        .declared(),
    },
    Spec {
        class: Class::TextDecoderStream,
        name: c"TextDecoderStream",
        parent: None,
        constructor: Some((decoder_stream_constructor, 0)),
        methods: &[],
        accessors: &[
            (c"encoding", text_encoding, None),
            (c"fatal", text_fatal, None),
            (c"ignoreBOM", text_ignore_bom, None),
            (c"readable", text_readable, None),
            (c"writable", text_writable, None),
        ],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: "",
            members: r#"constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
readonly encoding: string;
readonly fatal: boolean;
readonly ignoreBOM: boolean;
readonly readable: ReadableStream<string>;
readonly writable: WritableStream<BufferSource>;"#,
        }
        .declared(),
    },
];

#[cfg(test)]
mod tests {
    #[test]
    fn pairs_surrogates_across_chunks() {
        let mut pending = None;
        // "👋" = D83D DC4B, as two WTF-8 halves.
        let a = super::encode_chunk(&mut pending, b"a\xED\xA0\xBD");
        let b = super::encode_chunk(&mut pending, b"\xED\xB1\x8Bb");
        assert_eq!([a, b].concat(), "a👋b".as_bytes());
        assert!(pending.is_none());
    }
}
