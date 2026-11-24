//! What a Java class file refers to, read from its constant pool alone: the
//! fields its code reads or writes (`getstatic` and the like name a
//! `Fieldref` of the pool). Kotlin and Java compile to the same format.

/// A field a class refers to.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct FieldRef {
    /// The class that has it, by internal name: `com/example/R$string`.
    pub(super) class: String,
    pub(super) name: String,
}

/// The name of the class `bytes` is, by internal name, and the fields it
/// refers to. An error says why `bytes` is no class file.
pub(super) fn field_refs(bytes: &[u8]) -> Result<(String, Vec<FieldRef>), String> {
    let mut at = Reader { bytes, at: 0 };
    if at.u32()? != 0xCAFE_BABE {
        return Err("no class file magic".to_owned());
    }
    // Minor and major version: every version has the same pool.
    at.skip(4)?;
    let count = at.u16()? as usize;
    let mut pool = vec![Entry::None; count];
    let mut index = 1;
    while index < count {
        let tag = at.u8()?;
        let entry = match tag {
            1 => {
                let length = at.u16()? as usize;
                // Modified UTF-8, which is UTF-8 for the ASCII names of
                // `R` classes and their fields.
                Entry::Utf8(String::from_utf8_lossy(at.take(length)?).into_owned())
            }
            7 => Entry::Class(at.u16()?),
            9 => Entry::Field(at.u16()?, at.u16()?),
            12 => {
                let name = at.u16()?;
                // The descriptor.
                at.skip(2)?;
                Entry::NameAndType(name)
            }
            // Integer, Float.
            3 | 4 => at.skip(4).map(|_| Entry::None)?,
            // Long, Double: two entries.
            5 | 6 => {
                at.skip(8)?;
                index += 1;
                Entry::None
            }
            // String, MethodType, Module, Package.
            8 | 16 | 19 | 20 => at.skip(2).map(|_| Entry::None)?,
            // MethodHandle.
            15 => at.skip(3).map(|_| Entry::None)?,
            // Methodref, InterfaceMethodref, Dynamic, InvokeDynamic.
            10 | 11 | 17 | 18 => at.skip(4).map(|_| Entry::None)?,
            _ => return Err(format!("constant {index} has the unknown tag {tag}")),
        };
        if let Some(slot) = pool.get_mut(index) {
            *slot = entry;
        }
        index += 1;
    }
    let utf8 = |index: u16| match pool.get(index as usize) {
        Some(Entry::Utf8(text)) => Ok(text.as_str()),
        _ => Err(format!("constant {index} is no name")),
    };
    let class = |index: u16| match pool.get(index as usize) {
        Some(Entry::Class(name)) => utf8(*name),
        _ => Err(format!("constant {index} is no class")),
    };
    // Access flags, then the class itself.
    at.skip(2)?;
    let this = class(at.u16()?)?.to_owned();
    let mut fields = Vec::new();
    for entry in &pool {
        let Entry::Field(owner, name_and_type) = entry else {
            continue;
        };
        let Some(Entry::NameAndType(name)) = pool.get(*name_and_type as usize) else {
            return Err(format!("constant {name_and_type} is no name and type"));
        };
        fields.push(FieldRef {
            class: class(*owner)?.to_owned(),
            name: utf8(*name)?.to_owned(),
        });
    }
    Ok((this, fields))
}

#[derive(Debug, Clone)]
enum Entry {
    /// One the fields need not.
    None,
    Utf8(String),
    /// Its name.
    Class(u16),
    /// Its class and name and type.
    Field(u16, u16),
    /// Its name; the descriptor is not needed.
    NameAndType(u16),
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self
            .at
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len());
        let Some(end) = end else {
            return Err("it ends too early".to_owned());
        };
        let out = &self.bytes[self.at..end];
        self.at = end;
        Ok(out)
    }

    fn skip(&mut self, n: usize) -> Result<(), String> {
        self.take(n).map(|_| ())
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, String> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Result<u32, String> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
}

/// Test class files, written by hand.
#[cfg(test)]
pub(super) mod tests {
    use super::*;

    /// The class file of `class` (internal name), whose pool refers to
    /// `fields` (class, name, descriptor), with a `long` constant before
    /// them, which takes two entries.
    pub(in super::super) fn class_file(class: &str, fields: &[(&str, &str, &str)]) -> Vec<u8> {
        let mut pool: Vec<Vec<u8>> = Vec::new();
        let mut add = |entry: Vec<u8>| -> u16 {
            pool.push(entry);
            pool.len() as u16
        };
        let utf8 = |text: &str| {
            let mut out = vec![1];
            out.extend((text.len() as u16).to_be_bytes());
            out.extend(text.as_bytes());
            out
        };
        let pair = |tag: u8, a: u16, b: u16| {
            let mut out = vec![tag];
            out.extend(a.to_be_bytes());
            out.extend(b.to_be_bytes());
            out
        };
        let mut long = vec![5];
        long.extend(42u64.to_be_bytes());
        add(long);
        // Its second entry, which takes no bytes.
        add(Vec::new());
        let name = add(utf8(class));
        let this = add([vec![7], name.to_be_bytes().to_vec()].concat());
        add(pair(10, this, 1));
        for (owner, field, descriptor) in fields {
            let owner_name = add(utf8(owner));
            let owner = add([vec![7], owner_name.to_be_bytes().to_vec()].concat());
            let field = add(utf8(field));
            let descriptor = add(utf8(descriptor));
            let name_and_type = add(pair(12, field, descriptor));
            add(pair(9, owner, name_and_type));
        }
        let mut out = 0xCAFE_BABEu32.to_be_bytes().to_vec();
        out.extend([0, 0, 0, 52]);
        out.extend((pool.len() as u16 + 1).to_be_bytes());
        for entry in pool {
            out.extend(entry);
        }
        // Access flags, this class, super class, no interfaces, fields,
        // methods or attributes.
        out.extend([0, 0x21]);
        out.extend(this.to_be_bytes());
        out.extend([0; 10]);
        out
    }

    #[test]
    fn a_class_file_names_the_fields_its_pool_refers_to() {
        let bytes = class_file(
            "com/example/lib/Banner",
            &[
                ("com/example/lib/R$string", "title", "I"),
                ("com/example/lib/R$styleable", "Banner", "[I"),
            ],
        );
        let (this, fields) = field_refs(&bytes).unwrap();
        assert_eq!(this, "com/example/lib/Banner");
        assert_eq!(
            fields,
            [
                FieldRef {
                    class: "com/example/lib/R$string".into(),
                    name: "title".into()
                },
                FieldRef {
                    class: "com/example/lib/R$styleable".into(),
                    name: "Banner".into()
                },
            ]
        );
        assert_eq!(
            field_refs(b"PK\x03\x04").unwrap_err(),
            "no class file magic"
        );
        assert_eq!(
            field_refs(&bytes[..bytes.len() - 20]).unwrap_err(),
            "it ends too early"
        );
        let mut unknown = bytes.clone();
        // The first constant's tag.
        unknown[10] = 99;
        assert_eq!(
            field_refs(&unknown).unwrap_err(),
            "constant 1 has the unknown tag 99"
        );
    }
}
