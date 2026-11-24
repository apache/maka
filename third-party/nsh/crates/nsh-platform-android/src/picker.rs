//! The picker's image preparation for Rust code (an app's crate, an nshm)
//! that brings images of its own: a photo a camera app wrote
//! ([`crate::activity::output_file`]) prepared as `Picker.pickImages`
//! prepares the photos picked (`Picker.java`).

use std::path::Path;

use jni::{
    objects::{JByteArray, JClass, JIntArray, JObjectArray, JString, JValue},
    signature::ReturnType,
};
use nsh_core::{
    ImageData,
    geometry::{DevicePixels, Size},
    picker::{PickFormat, PickRequest, PickedFile},
};

use crate::java::{java, with_env};

/// The image file at `path` prepared as `request` says (scaled down to its
/// `max_dimension`, HEIC as JPEG unless its format is `Current`, encoded
/// again at its quality when it has one, its orientation applied), named
/// `name`. `None` when it is no image Android decodes, or before any
/// `NshView` was made. Reads and decodes the file: call it off the UI
/// thread.
pub fn prepare_image(path: &Path, name: &str, request: &PickRequest) -> Option<PickedFile> {
    let path = path.to_str()?;
    with_env(|env| {
        let path = env.new_string(path)?;
        let name = env.new_string(name)?;
        let max_dimension = request.max_dimension.map_or(0, |d| d.0.max(0));
        let quality = request.quality.map_or(-1.0, |q| q.0);
        let current = matches!(request.format, PickFormat::Current);
        // SAFETY: the signature checked in `java::init`.
        let prepared = unsafe {
            env.call_static_method_unchecked(
                <&JClass<'_>>::from(java().picker.as_obj()),
                java().picker_prepare_file,
                ReturnType::Array,
                &[
                    JValue::Object(&path).as_jni(),
                    JValue::Object(&name).as_jni(),
                    JValue::Int(max_dimension).as_jni(),
                    JValue::Float(quality).as_jni(),
                    JValue::Bool(current.into()).as_jni(),
                ],
            )
        }?
        .l()?;
        if prepared.is_null() {
            return Ok(None);
        }
        let prepared = JObjectArray::from(prepared);
        let name: JString<'_> = env.get_object_array_element(&prepared, 0)?.into();
        let name = String::from(env.get_string(&name)?);
        let mime: JString<'_> = env.get_object_array_element(&prepared, 1)?.into();
        let mime = String::from(env.get_string(&mime)?);
        let bytes: JByteArray<'_> = env.get_object_array_element(&prepared, 2)?.into();
        let bytes = env.convert_byte_array(&bytes)?;
        let size: JIntArray<'_> = env.get_object_array_element(&prepared, 3)?.into();
        let mut wh = [0; 2];
        env.get_int_array_region(&size, 0, &mut wh)?;
        let mut file = PickedFile::new(name, mime, ImageData::from(bytes));
        file.size = Size::new(DevicePixels(wh[0]), DevicePixels(wh[1]));
        Ok(Some(file))
    })
}
