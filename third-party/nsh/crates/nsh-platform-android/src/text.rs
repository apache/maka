//! `StaticLayout` text engine, driven through JNI on the engine thread:
//! `TextLayouts.prepare` builds the styled text once per content,
//! `measure` lays it out at any width, `layout` makes the final
//! `StaticLayout` that the UI thread only draws. Hit testing (`hitTest`,
//! `caretRect`, `rangeRects`) asks that `StaticLayout` too, with the code
//! the UI thread's selection, links and test agent call directly.

use std::{ops::Range, sync::Arc};

use jni::{
    objects::{GlobalRef, JObject, JStaticMethodID, JValue},
    signature::{Primitive, ReturnType},
    sys::jvalue,
};
use nsh_core::{
    Affinity, AttributedText, Bounds, EllipsizeMode, Point, Points, Size, TextAlign, TextEngine,
    TextLayout, TextPosition,
    geometry::{point, px},
};

use crate::java::{java, with_env};

/// Ints per span: start, end, weight, flags, color, decoration color,
/// family index, font variant bits, decoration style, background color,
/// background node.
const SPAN_INTS: usize = 11;
/// Floats per span: size, line height, letter spacing, decoration
/// thickness (0: the font's), underline offset (NaN: the font's),
/// background radius.
const SPAN_FLOATS: usize = 6;
const ITALIC: i32 = 1;
const UNDERLINE: i32 = 2;
const STRIKE: i32 = 4;
const DECORATION_COLOR: i32 = 8;
const BACKGROUND: i32 = 16;

/// `0xRRGGBBAA` -> Android's `0xAARRGGBB`.
#[inline]
pub(crate) fn argb(c: nsh_core::Color) -> i32 {
    (c.0.rotate_right(8)) as i32
}

/// A `TextLayouts.Prepared` object.
#[derive(Default)]
pub(crate) struct Prepared(Option<GlobalRef>);

/// A finished `StaticLayout`, drawn by `NshText.java`.
pub(crate) struct AndroidLayout(pub(crate) GlobalRef);

/// [`TextEngine`] backed by Android's `StaticLayout`.
pub(crate) struct AndroidTextEngine {
    pub(crate) density: f32,
}

impl TextEngine for AndroidTextEngine {
    type Prepared = Prepared;

    fn prepare(&self, text: &AttributedText) -> Prepared {
        self.prepare_aligned(text, &nsh_core::AttachmentAlignments::default())
    }

    fn prepare_aligned(
        &self,
        text: &AttributedText,
        alignments: &nsh_core::AttachmentAlignments,
    ) -> Prepared {
        let mut ints = Vec::with_capacity(text.spans.len() * SPAN_INTS);
        let mut floats = Vec::with_capacity(text.spans.len() * SPAN_FLOATS);
        let mut families: Vec<Arc<str>> = Vec::new();
        for span in &text.spans {
            let s = &span.style;
            let family = s.font_family.map_or(-1, |f| {
                let name = f.name();
                match families.iter().position(|n| *n == name) {
                    Some(i) => i as i32,
                    None => {
                        families.push(name);
                        families.len() as i32 - 1
                    }
                }
            });
            let mut flags = 0;
            if s.italic {
                flags |= ITALIC;
            }
            if s.decoration.underline {
                flags |= UNDERLINE;
            }
            if s.decoration.line_through {
                flags |= STRIKE;
            }
            if s.decoration_color.is_some() {
                flags |= DECORATION_COLOR;
            }
            if s.background.is_some() {
                flags |= BACKGROUND;
            }
            ints.extend_from_slice(&[
                span.start as i32,
                span.end as i32,
                s.font_weight as i32,
                flags,
                argb(s.color),
                argb(s.decoration_color.unwrap_or(s.color)),
                family,
                s.font_variant.0 as i32,
                match s.decoration_style {
                    nsh_core::DecorationStyle::Solid => 0,
                    nsh_core::DecorationStyle::Double => 1,
                    nsh_core::DecorationStyle::Dotted => 2,
                    nsh_core::DecorationStyle::Dashed => 3,
                    nsh_core::DecorationStyle::Wavy => 4,
                },
                s.background.map_or(0, |b| argb(b.color)),
                s.background.map_or(0, |b| b.node as i32),
            ]);
            floats.extend_from_slice(&[
                s.font_size.0,
                s.line_height.0,
                s.letter_spacing.0,
                s.decoration_thickness.map_or(0.0, |t| t.0),
                s.underline_offset.map_or(f32::NAN, |o| o.0),
                s.background.map_or(0.0, |b| b.radius.0),
            ]);
        }
        // Alignment, writing direction (0 from the content, 1 left to
        // right, 2 right to left) << 4, layout right to left << 8.
        let align = match text.align {
            TextAlign::Auto => 0,
            TextAlign::Left => 1,
            TextAlign::Center => 2,
            TextAlign::Right => 3,
            TextAlign::Justify => 4,
        } | match text.writing_direction {
            None => 0,
            Some(false) => 1,
            Some(true) => 2,
        } << 4
            | (text.rtl as i32) << 8;
        let ellipsize = match text.ellipsize {
            EllipsizeMode::Tail => 0,
            EllipsizeMode::Head => 1,
            EllipsizeMode::Middle => 2,
            EllipsizeMode::Clip => 3,
        };
        let density = self.density;
        let shadow = text.shadow;
        // Offset, width, height and `verticalAlign` (0 baseline, 1 text
        // top, 2 text bottom, 3 middle): `TextLayouts.Attachment` places it
        // as `TextAttachment::ascent` does, with the run's font metrics.
        let attachments: Vec<f32> = text
            .attachments
            .iter()
            .flat_map(|a| {
                let align = match alignments.get(a.index) {
                    nsh_core::VerticalAlign::Baseline => 0.0,
                    nsh_core::VerticalAlign::TextTop => 1.0,
                    nsh_core::VerticalAlign::TextBottom => 2.0,
                    nsh_core::VerticalAlign::Middle => 3.0,
                };
                [a.index as f32, a.width.0, a.height.0, align]
            })
            .collect();
        Prepared(with_env(|env| {
            let j = java();
            let string = env.new_string(&text.text)?;
            let int_array = env.new_int_array(ints.len() as i32)?;
            env.set_int_array_region(&int_array, 0, &ints)?;
            let float_array = env.new_float_array(floats.len() as i32)?;
            env.set_float_array_region(&float_array, 0, &floats)?;
            let family_array =
                env.new_object_array(families.len() as i32, "java/lang/String", JObject::null())?;
            for (i, name) in families.iter().enumerate() {
                let name = env.new_string(&**name)?;
                env.set_object_array_element(&family_array, i as i32, name)?;
            }
            let attachment_array = env.new_float_array(attachments.len() as i32)?;
            env.set_float_array_region(&attachment_array, 0, &attachments)?;
            let args = [
                JValue::Object(&string).as_jni(),
                JValue::Object(&int_array).as_jni(),
                JValue::Object(&float_array).as_jni(),
                JValue::Object(&family_array).as_jni(),
                JValue::Int(align).as_jni(),
                JValue::Int(text.max_lines as i32).as_jni(),
                JValue::Int(ellipsize).as_jni(),
                JValue::Float(density).as_jni(),
                // Shadow behind the block: color 0 means none.
                JValue::Int(shadow.map_or(0, |s| argb(s.color))).as_jni(),
                JValue::Float(shadow.map_or(0.0, |s| s.offset_x.0)).as_jni(),
                JValue::Float(shadow.map_or(0.0, |s| s.offset_y.0)).as_jni(),
                JValue::Float(shadow.map_or(0.0, |s| s.radius.0)).as_jni(),
                JValue::Object(&attachment_array).as_jni(),
            ];
            // SAFETY: the method id and argument types match the signature
            // checked in `java::init`.
            let prepared = unsafe {
                env.call_static_method_unchecked(
                    <&jni::objects::JClass<'_>>::from(j.text.as_obj()),
                    j.text_prepare,
                    ReturnType::Object,
                    &args,
                )
            }?
            .l()?;
            env.new_global_ref(prepared).map(Some)
        }))
    }

    fn measure(&self, prepared: &Prepared, max_width: Option<Points>) -> Size<Points> {
        let Some(obj) = &prepared.0 else {
            return Size::new(px(0.0), px(0.0));
        };
        let packed = with_env(|env| {
            let j = java();
            let args: [jvalue; 2] = [
                JValue::Object(obj.as_obj()).as_jni(),
                JValue::Float(max_width.map_or(f32::NAN, |m| m.0)).as_jni(),
            ];
            // SAFETY: matches the signature checked in `java::init`.
            unsafe {
                env.call_static_method_unchecked(
                    <&jni::objects::JClass<'_>>::from(j.text.as_obj()),
                    j.text_measure,
                    ReturnType::Primitive(Primitive::Long),
                    &args,
                )
            }?
            .j()
        });
        // Two f32 bit patterns: width high, height low.
        let width = f32::from_bits((packed as u64 >> 32) as u32);
        let height = f32::from_bits(packed as u64 as u32);
        Size::new(Points(width), Points(height))
    }

    fn layout(&self, prepared: &Prepared, size: Size<Points>) -> TextLayout {
        let layout = prepared.0.as_ref().and_then(|obj| {
            with_env(|env| {
                let j = java();
                let args: [jvalue; 3] = [
                    JValue::Object(obj.as_obj()).as_jni(),
                    JValue::Float(size.width.0).as_jni(),
                    JValue::Float(size.height.0).as_jni(),
                ];
                // SAFETY: matches the signature checked in `java::init`.
                let layout = unsafe {
                    env.call_static_method_unchecked(
                        <&jni::objects::JClass<'_>>::from(j.text.as_obj()),
                        j.text_layout,
                        ReturnType::Object,
                        &args,
                    )
                }?
                .l()?;
                env.new_global_ref(layout).map(Some)
            })
        });
        match layout {
            Some(layout) => TextLayout(Arc::new(AndroidLayout(layout))),
            None => TextLayout(Arc::new(())),
        }
    }

    fn lines(&self, layout: &TextLayout) -> Vec<nsh_core::TextLine> {
        let Some(AndroidLayout(obj)) = layout.downcast::<AndroidLayout>() else {
            return Vec::new();
        };
        let floats = with_env(|env| {
            let j = java();
            let args: [jvalue; 2] = [
                JValue::Object(obj.as_obj()).as_jni(),
                JValue::Float(self.density).as_jni(),
            ];
            // SAFETY: matches the signature checked in `java::init`.
            let array = unsafe {
                env.call_static_method_unchecked(
                    <&jni::objects::JClass<'_>>::from(j.text.as_obj()),
                    j.text_lines,
                    ReturnType::Array,
                    &args,
                )
            }?
            .l()?;
            let array = jni::objects::JFloatArray::from(array);
            let len = env.get_array_length(&array)? as usize;
            let mut out = vec![0f32; len];
            env.get_float_array_region(&array, 0, &mut out)?;
            Ok(out)
        });
        floats
            .as_chunks::<10>()
            .0
            .iter()
            .map(|v| nsh_core::TextLine {
                text: String::new(),
                start: v[0] as u32,
                end: v[1] as u32,
                x: px(v[2]),
                y: px(v[3]),
                width: px(v[4]),
                height: px(v[5]),
                ascender: px(v[6]),
                descender: px(v[7]),
                cap_height: px(v[8]),
                x_height: px(v[9]),
            })
            .collect()
    }

    fn attachments(&self, layout: &TextLayout) -> Vec<Option<nsh_core::Point<Points>>> {
        let Some(AndroidLayout(obj)) = layout.downcast::<AndroidLayout>() else {
            return Vec::new();
        };
        let floats = with_env(|env| {
            let j = java();
            let args: [jvalue; 2] = [
                JValue::Object(obj.as_obj()).as_jni(),
                JValue::Float(self.density).as_jni(),
            ];
            // SAFETY: matches the signature checked in `java::init`.
            let array = unsafe {
                env.call_static_method_unchecked(
                    <&jni::objects::JClass<'_>>::from(j.text.as_obj()),
                    j.text_attachments,
                    ReturnType::Array,
                    &args,
                )
            }?
            .l()?;
            let array = jni::objects::JFloatArray::from(array);
            let len = env.get_array_length(&array)? as usize;
            let mut out = vec![0f32; len];
            env.get_float_array_region(&array, 0, &mut out)?;
            Ok(out)
        });
        floats
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&[x, y]| (!x.is_nan()).then_some(nsh_core::geometry::point(px(x), px(y))))
            .collect()
    }

    fn hit_test(&self, layout: &TextLayout, at: Point<Points>) -> TextPosition {
        let Some(AndroidLayout(obj)) = layout.downcast::<AndroidLayout>() else {
            return TextPosition::default();
        };
        let packed = with_env(|env| {
            let j = java();
            let args: [jvalue; 4] = [
                JValue::Object(obj.as_obj()).as_jni(),
                JValue::Float(at.x.0).as_jni(),
                JValue::Float(at.y.0).as_jni(),
                JValue::Float(self.density).as_jni(),
            ];
            // SAFETY: matches the signature checked in `java::init`.
            unsafe {
                env.call_static_method_unchecked(
                    <&jni::objects::JClass<'_>>::from(j.text.as_obj()),
                    j.text_hit_test,
                    ReturnType::Primitive(Primitive::Long),
                    &args,
                )
            }?
            .j()
        });
        // The offset in the low 32 bits, bit 32 set at the end of a wrapped
        // line (`TextLayouts.hitTest`).
        let offset = u32::try_from(packed & 0xffff_ffff).unwrap_or_default();
        let affinity = if (packed >> 32) & 1 != 0 {
            Affinity::Upstream
        } else {
            Affinity::Downstream
        };
        TextPosition::new(offset, affinity)
    }

    fn caret_rect(&self, layout: &TextLayout, position: TextPosition) -> Option<Bounds<Points>> {
        let AndroidLayout(obj) = layout.downcast::<AndroidLayout>()?;
        let j = java();
        let args: [jvalue; 4] = [
            JValue::Object(obj.as_obj()).as_jni(),
            JValue::Int(i32::try_from(position.offset).unwrap_or(i32::MAX)).as_jni(),
            JValue::Bool((position.affinity == Affinity::Upstream).into()).as_jni(),
            JValue::Float(self.density).as_jni(),
        ];
        // SAFETY: `text_caret_rect` takes these arguments (checked in
        // `java::init`) and returns `float[]`.
        let floats = unsafe { call_floats(j.text_caret_rect, &args) };
        // x, y and the height of the line, in dp; nothing without lines.
        let &[x, y, height] = floats.as_chunks::<3>().0.first()?;
        Some(Bounds::new(
            point(px(x), px(y)),
            Size::new(px(0.0), px(height)),
        ))
    }

    fn range_rects(&self, layout: &TextLayout, range: Range<u32>, out: &mut Vec<Bounds<Points>>) {
        let Some(AndroidLayout(obj)) = layout.downcast::<AndroidLayout>() else {
            return;
        };
        if range.start >= range.end {
            return;
        }
        let j = java();
        let offset = |o: u32| i32::try_from(o).unwrap_or(i32::MAX);
        let args: [jvalue; 4] = [
            JValue::Object(obj.as_obj()).as_jni(),
            JValue::Int(offset(range.start)).as_jni(),
            JValue::Int(offset(range.end)).as_jni(),
            JValue::Float(self.density).as_jni(),
        ];
        // SAFETY: `text_range_rects` takes these arguments (checked in
        // `java::init`) and returns `float[]`.
        let floats = unsafe { call_floats(j.text_range_rects, &args) };
        // x, y, width and height of each box, in dp.
        for &[x, y, width, height] in floats.as_chunks::<4>().0 {
            out.push(Bounds::new(
                point(px(x), px(y)),
                Size::new(px(width), px(height)),
            ));
        }
    }

    fn register_font(&self, data: &[u8]) -> Result<(), String> {
        let face = ttf_parser::Face::parse(data, 0).map_err(|e| e.to_string())?;
        let name = |id| {
            face.names()
                .into_iter()
                .filter(|n| n.name_id == id && n.is_unicode())
                .find_map(|n| n.to_string())
        };
        let family = name(ttf_parser::name_id::TYPOGRAPHIC_FAMILY)
            .or_else(|| name(ttf_parser::name_id::FAMILY))
            .ok_or("the font has no family name")?;
        let weight = face.weight().to_number() as i32;
        let italic = face.is_italic();
        let error: Option<String> = with_env(|env| {
            let j = java();
            let family = env.new_string(&family)?;
            let bytes = env.byte_array_from_slice(data)?;
            let args: [jvalue; 4] = [
                JValue::Object(&family).as_jni(),
                JValue::Object(&bytes).as_jni(),
                JValue::Int(weight).as_jni(),
                JValue::Bool(italic.into()).as_jni(),
            ];
            // SAFETY: matches the signature checked in `java::init`.
            let error = unsafe {
                env.call_static_method_unchecked(
                    <&jni::objects::JClass<'_>>::from(j.text.as_obj()),
                    j.text_register_font,
                    ReturnType::Object,
                    &args,
                )
            }?
            .l()?;
            if error.is_null() {
                return Ok(None);
            }
            Ok(Some(env.get_string(&error.into())?.into()))
        });
        match error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

/// Calls a `TextLayouts` method that returns `float[]` and copies the array
/// out; empty when the call fails.
///
/// # Safety
///
/// `method` is one of the `text_*` ids of [`crate::java::Java`] that returns
/// `float[]` and `args` are its arguments: their number and types are those
/// of the signature checked in `java::init`.
unsafe fn call_floats(method: JStaticMethodID, args: &[jvalue]) -> Vec<f32> {
    with_env(|env| {
        let j = java();
        // SAFETY: the caller's contract.
        let array = unsafe {
            env.call_static_method_unchecked(
                <&jni::objects::JClass<'_>>::from(j.text.as_obj()),
                method,
                ReturnType::Array,
                args,
            )
        }?
        .l()?;
        let array = jni::objects::JFloatArray::from(array);
        let len = usize::try_from(env.get_array_length(&array)?).unwrap_or_default();
        let mut out = vec![0f32; len];
        env.get_float_array_region(&array, 0, &mut out)?;
        Ok(out)
    })
}
