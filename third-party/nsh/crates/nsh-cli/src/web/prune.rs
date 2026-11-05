//! Reading the linkable web runtime (`nsh-browser.wasm`, feature
//! `linkable`) for [`split`]: [`Module`] parses it and
//! [`Module::mark_from`] finds what some functions reach.

use std::ops::Range;

use anyhow::{Context as _, bail, ensure};
use wasmparser::{
    DataKind, ElementItems, ElementKind, ExternalKind, KnownCustom, Linking, Operator, Parser,
    Payload, RefType, RelocationEntry, RelocationType, SymbolFlags, SymbolInfo, TableInit, TypeRef,
};

pub(crate) mod split;

/// The names of the functions a runtime exports, in its order.
pub(crate) fn exports(wasm: &[u8]) -> anyhow::Result<Vec<String>> {
    let mut names = Vec::new();
    for payload in Parser::new(0).parse_all(wasm) {
        let payload = payload.context("the web runtime is not a WebAssembly module")?;
        if let Payload::ExportSection(reader) = payload {
            for export in reader {
                let export = export?;
                if export.kind == ExternalKind::Func {
                    names.push(export.name.to_owned());
                }
            }
        }
    }
    Ok(names)
}

/// `wasm` as it is, without the custom sections a linked runtime leaves
/// out ([`dropped_custom`]): for a runtime published whole.
pub(crate) fn unlinked(wasm: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(wasm.len());
    for payload in Parser::new(0).parse_all(wasm) {
        let payload = payload.context("the web runtime is not a WebAssembly module")?;
        if let Payload::Version { range, .. } = &payload {
            out.extend_from_slice(&wasm[range.start as usize..range.end as usize]);
        }
        if let Payload::CustomSection(custom) = &payload
            && dropped_custom(custom.name())
        {
            continue;
        }
        if let Some((id, range)) = payload.as_section() {
            out.push(id);
            put_uleb(&mut out, range.end - range.start);
            out.extend_from_slice(&wasm[range.start as usize..range.end as usize]);
        }
    }
    Ok(out)
}

/// A symbol of the `linking` section's table, as far as pruning needs it.
enum Symbol {
    Func(u32),
    Data(DataSymbol),
    /// An address the linker computed (`__heap_base`), not data.
    Absolute,
    /// Undefined data, globals, tables, sections, tags: nothing to keep.
    Other,
}

#[derive(Clone, Copy)]
struct DataSymbol {
    segment: usize,
    start: u32,
    end: u32,
}

struct Segment {
    address: u32,
    /// Its bytes, in the input.
    bytes: Range<usize>,
    align_log2: u32,
}

/// A relocation of the data section, at the address it patches.
#[derive(Clone, Copy)]
struct DataReloc {
    address: u32,
    entry: RelocationEntry,
}

#[derive(Clone, Copy)]
struct Export<'a> {
    name: &'a str,
    kind: ExternalKind,
    index: u32,
}

struct Table {
    initial: u64,
}

struct Memory {
    initial: u64,
}

#[derive(Default)]
struct Module<'a> {
    wasm: &'a [u8],
    /// Every section in order: its id, its contents and a custom one's name.
    sections: Vec<(u8, Range<usize>, &'a str)>,
    imported_funcs: u32,
    memory_imported: bool,
    func_types: Vec<u32>,
    table: Option<Table>,
    memory: Option<Memory>,
    /// Each global's initial value, when it is an `i32.const`.
    globals: Vec<Option<i32>>,
    exports: Vec<Export<'a>>,
    start: Option<u32>,
    /// The table's first slot the element segment fills, and its functions.
    elements: Option<(i32, Vec<u32>)>,
    code_start: usize,
    /// Each defined function's body (without its size), in the input.
    bodies: Vec<Range<usize>>,
    data_start: usize,
    segments: Vec<Segment>,
    symbols: Vec<Symbol>,
    no_strip: Vec<u32>,
    code_relocs: Vec<RelocationEntry>,
    data_relocs: Vec<DataReloc>,
}

/// What [`Module::mark`] found reachable.
struct Live {
    funcs: Vec<bool>,
    /// Functions whose table slot kept code or data takes.
    taken: Vec<bool>,
    /// The data kept: ranges of addresses with their segment, and whether
    /// a symbol starts there (the bytes no symbol covers need no alignment).
    data: Vec<(usize, u32, u32, bool)>,
}

impl<'a> Module<'a> {
    fn parse(wasm: &'a [u8]) -> anyhow::Result<Self> {
        let mut module = Module {
            wasm,
            ..Default::default()
        };
        let mut linking = None;
        let mut relocs = Vec::new();
        for payload in Parser::new(0).parse_all(wasm) {
            let payload = payload.context("the web runtime is not a WebAssembly module")?;
            if let Some((id, range)) = payload.as_section() {
                let name = match &payload {
                    Payload::CustomSection(custom) => custom.name(),
                    _ => "",
                };
                module
                    .sections
                    .push((id, range.start as usize..range.end as usize, name));
            }
            match payload {
                Payload::ImportSection(reader) => {
                    for import in reader.into_imports() {
                        match import?.ty {
                            TypeRef::Func(_) | TypeRef::FuncExact(_) => module.imported_funcs += 1,
                            TypeRef::Memory(_) => module.memory_imported = true,
                            TypeRef::Table(_) => bail!("the web runtime imports its table"),
                            TypeRef::Global(_) => bail!("the web runtime imports globals"),
                            TypeRef::Tag(_) => {}
                        }
                    }
                }
                Payload::FunctionSection(reader) => {
                    module.func_types = reader.into_iter().collect::<Result<_, _>>()?;
                }
                Payload::TableSection(reader) => {
                    for table in reader {
                        let table = table?;
                        ensure!(module.table.is_none(), "the web runtime has several tables");
                        let ty = table.ty;
                        ensure!(
                            ty.element_type == RefType::FUNCREF
                                && !ty.table64
                                && !ty.shared
                                && matches!(table.init, TableInit::RefNull),
                            "the web runtime's table is not a plain function table"
                        );
                        module.table = Some(Table {
                            initial: ty.initial,
                        });
                    }
                }
                Payload::MemorySection(reader) => {
                    for memory in reader {
                        let memory = memory?;
                        ensure!(
                            module.memory.is_none(),
                            "the web runtime has several memories"
                        );
                        ensure!(
                            !memory.memory64 && !memory.shared && memory.page_size_log2.is_none(),
                            "the web runtime's memory is not a plain 32-bit memory"
                        );
                        module.memory = Some(Memory {
                            initial: memory.initial,
                        });
                    }
                }
                Payload::GlobalSection(reader) => {
                    for global in reader {
                        let global = global?;
                        let mut ops = global.init_expr.get_operators_reader();
                        module.globals.push(match ops.read()? {
                            Operator::I32Const { value } => Some(value),
                            _ => None,
                        });
                    }
                }
                Payload::ExportSection(reader) => {
                    for export in reader {
                        let export = export?;
                        module.exports.push(Export {
                            name: export.name,
                            kind: export.kind,
                            index: export.index,
                        });
                    }
                }
                Payload::StartSection { func, .. } => module.start = Some(func),
                Payload::ElementSection(reader) => {
                    for element in reader {
                        let element = element?;
                        ensure!(
                            module.elements.is_none(),
                            "the web runtime has several element segments"
                        );
                        let ElementKind::Active {
                            table_index: None | Some(0),
                            offset_expr,
                        } = element.kind
                        else {
                            bail!("the web runtime's element segment is not active");
                        };
                        let ElementItems::Functions(funcs) = element.items else {
                            bail!("the web runtime's element segment holds expressions");
                        };
                        let offset = i32_const(&offset_expr)?;
                        let funcs = funcs.into_iter().collect::<Result<_, _>>()?;
                        module.elements = Some((offset, funcs));
                    }
                }
                Payload::CodeSectionStart {
                    unchecked_range, ..
                } => module.code_start = unchecked_range.start as usize,
                Payload::CodeSectionEntry(body) => {
                    let range = body.range();
                    module.bodies.push(range.start as usize..range.end as usize);
                }
                Payload::DataSection(reader) => {
                    module.data_start = reader.range().start as usize;
                    for data in reader {
                        let data = data?;
                        let DataKind::Active {
                            memory_index: 0,
                            offset_expr,
                        } = data.kind
                        else {
                            bail!("the web runtime has a passive data segment");
                        };
                        let end = data.range.end as usize;
                        module.segments.push(Segment {
                            address: i32_const(&offset_expr)? as u32,
                            bytes: end - data.data.len()..end,
                            align_log2: 0,
                        });
                    }
                }
                Payload::CustomSection(custom) => match custom.as_known() {
                    KnownCustom::Linking(reader) => linking = Some(reader),
                    KnownCustom::Reloc(reader) => relocs.push(reader),
                    _ => {}
                },
                Payload::TagSection(_)
                | Payload::DataCountSection { .. }
                | Payload::TypeSection(_)
                | Payload::Version { .. }
                | Payload::End(_) => {}
                other => {
                    if let Some((id, _)) = other.as_section() {
                        bail!("the web runtime has a section the pruner does not know ({id})");
                    }
                }
            }
        }
        ensure!(
            module.func_types.len() == module.bodies.len(),
            "the web runtime's function and code sections disagree"
        );
        ensure!(
            module
                .segments
                .windows(2)
                .all(|w| w[0].address as usize + w[0].bytes.len() <= w[1].address as usize),
            "the web runtime's data segments are not in address order"
        );

        let linking = linking.context(
            "the web runtime has no `linking` section (it must be linked with --emit-relocs)",
        )?;
        for subsection in linking {
            match subsection? {
                Linking::SymbolTable(symbols) => {
                    for symbol in symbols {
                        let symbol = symbol?;
                        let flags = match &symbol {
                            SymbolInfo::Func { flags, .. }
                            | SymbolInfo::Data { flags, .. }
                            | SymbolInfo::Global { flags, .. }
                            | SymbolInfo::Section { flags, .. }
                            | SymbolInfo::Event { flags, .. }
                            | SymbolInfo::Table { flags, .. } => *flags,
                        };
                        // What wasm-ld keeps whatever is exported (`#[used]`).
                        if flags.contains(SymbolFlags::NO_STRIP)
                            && !flags.contains(SymbolFlags::UNDEFINED)
                        {
                            module.no_strip.push(module.symbols.len() as u32);
                        }
                        let symbol = module.symbol(symbol)?;
                        module.symbols.push(symbol);
                    }
                }
                Linking::SegmentInfo(segments) => {
                    for (segment, info) in module.segments.iter_mut().zip(segments) {
                        segment.align_log2 = info?.alignment;
                    }
                }
                Linking::InitFuncs(funcs) => {
                    for func in funcs {
                        module.no_strip.push(func?.symbol_index);
                    }
                }
                _ => {}
            }
        }
        let code_index = module.section_index(10);
        let data_index = module.section_index(11);
        for reader in relocs {
            let section = Some(reader.section_index() as usize);
            if section == code_index {
                module.code_relocs = reader.entries().into_iter().collect::<Result<_, _>>()?;
            } else if section == data_index {
                for entry in reader.entries() {
                    let entry = entry?;
                    let address = module.data_address(entry.offset as usize)?;
                    module.data_relocs.push(DataReloc { address, entry });
                }
            } else {
                // Debug sections: dropped with their relocations.
                let section = module.sections.get(reader.section_index() as usize);
                let (id, _, name) = section.context("a relocation section names no section")?;
                ensure!(
                    *id == 0 && dropped_custom(name),
                    "the web runtime relocates a section the pruner keeps ({id})"
                );
            }
        }
        ensure!(
            !module.code_relocs.is_empty(),
            "the web runtime has no `reloc.CODE` section (it must be linked with --emit-relocs)"
        );
        module.code_relocs.sort_by_key(|entry| entry.offset);
        module.data_relocs.sort_by_key(|reloc| reloc.address);
        Ok(module)
    }

    fn symbol(&self, symbol: SymbolInfo<'a>) -> anyhow::Result<Symbol> {
        Ok(match symbol {
            SymbolInfo::Func { index, .. } => {
                ensure!(
                    index < self.imported_funcs + self.bodies.len() as u32,
                    "a symbol names function {index}, which the web runtime does not have"
                );
                Symbol::Func(index)
            }
            SymbolInfo::Data {
                flags,
                name,
                symbol: Some(data),
            } => {
                if flags.contains(SymbolFlags::ABSOLUTE) {
                    Symbol::Absolute
                } else {
                    let segment = self.segments.get(data.index as usize).with_context(|| {
                        format!("`{name}` is in a data segment the web runtime does not have")
                    })?;
                    let start = segment.address + data.offset;
                    let end = start + data.size;
                    ensure!(
                        data.offset as usize + data.size as usize <= segment.bytes.len(),
                        "`{name}` is past its data segment's end"
                    );
                    Symbol::Data(DataSymbol {
                        segment: data.index as usize,
                        start,
                        end,
                    })
                }
            }
            _ => Symbol::Other,
        })
    }

    fn section_index(&self, id: u8) -> Option<usize> {
        self.sections
            .iter()
            .position(|(section, ..)| *section == id)
    }

    /// The address an offset in the data section's contents is loaded at.
    fn data_address(&self, offset: usize) -> anyhow::Result<u32> {
        let at = self.data_start + offset;
        self.segments
            .iter()
            .find(|segment| segment.bytes.contains(&at))
            .map(|segment| segment.address + (at - segment.bytes.start) as u32)
            .with_context(|| format!("a data relocation at {offset} is outside every segment"))
    }

    fn func_count(&self) -> usize {
        self.imported_funcs as usize + self.bodies.len()
    }

    /// The function a relocation names.
    fn func_of(&self, entry: &RelocationEntry) -> anyhow::Result<u32> {
        match self.symbols.get(entry.index as usize) {
            Some(Symbol::Func(func)) => Ok(*func),
            _ => bail!(
                "a {:?} relocation names a symbol that is no function",
                entry.ty
            ),
        }
    }

    /// The relocations in each defined function's body.
    fn body_relocs(&self) -> anyhow::Result<Vec<Range<usize>>> {
        let offsets = |body: &Range<usize>| {
            let start = body.start - self.code_start;
            let end = body.end - self.code_start;
            let lo = self
                .code_relocs
                .partition_point(|r| (r.offset as usize) < start);
            let hi = self
                .code_relocs
                .partition_point(|r| (r.offset as usize) < end);
            lo..hi
        };
        let ranges: Vec<_> = self.bodies.iter().map(offsets).collect();
        let covered: usize = ranges.iter().map(|range| range.len()).sum();
        ensure!(
            covered == self.code_relocs.len(),
            "the web runtime relocates code outside its functions' bodies"
        );
        Ok(ranges)
    }

    /// What `funcs` and the data `ranges` reach, with the start function,
    /// what the linker keeps whatever (`NO_STRIP`, init functions) and the
    /// bytes no symbol covers.
    fn mark_from(
        &self,
        mut funcs: Vec<u32>,
        mut ranges: Vec<(usize, u32, u32, bool)>,
    ) -> anyhow::Result<Live> {
        let body_relocs = self.body_relocs()?;
        let mut live = Live {
            funcs: vec![false; self.func_count()],
            taken: vec![false; self.func_count()],
            data: Vec::new(),
        };
        let mut live_symbols = vec![false; self.symbols.len()];
        funcs.extend(self.start);
        for &symbol in &self.no_strip {
            match self.symbols.get(symbol as usize) {
                Some(Symbol::Func(func)) => funcs.push(*func),
                Some(Symbol::Data(data)) => {
                    live_symbols[symbol as usize] = true;
                    ranges.push((data.segment, data.start, data.end, true));
                }
                _ => {}
            }
        }
        // The bytes no symbol covers: nothing says what refers to them.
        ranges.extend(self.uncovered());

        loop {
            let entries: &[RelocationEntry];
            let data_entries: &[DataReloc];
            if let Some(func) = funcs.pop() {
                if std::mem::replace(&mut live.funcs[func as usize], true) {
                    continue;
                }
                let Some(defined) = func.checked_sub(self.imported_funcs) else {
                    continue;
                };
                entries = &self.code_relocs[body_relocs[defined as usize].clone()];
                data_entries = &[];
            } else if let Some(range @ (_, start, end, _)) = ranges.pop() {
                live.data.push(range);
                let lo = self.data_relocs.partition_point(|r| r.address < start);
                let hi = self.data_relocs.partition_point(|r| r.address < end);
                entries = &[];
                data_entries = &self.data_relocs[lo..hi];
            } else {
                break;
            }
            let all = entries
                .iter()
                .chain(data_entries.iter().map(|reloc| &reloc.entry));
            for entry in all {
                match entry.ty {
                    RelocationType::FunctionIndexLeb | RelocationType::FunctionIndexI32 => {
                        funcs.push(self.func_of(entry)?);
                    }
                    RelocationType::TableIndexSleb | RelocationType::TableIndexI32 => {
                        let func = self.func_of(entry)?;
                        live.taken[func as usize] = true;
                        funcs.push(func);
                    }
                    RelocationType::MemoryAddrLeb
                    | RelocationType::MemoryAddrSleb
                    | RelocationType::MemoryAddrI32 => {
                        if let Some(Symbol::Data(data)) = self.symbols.get(entry.index as usize)
                            && !std::mem::replace(&mut live_symbols[entry.index as usize], true)
                        {
                            ranges.push((data.segment, data.start, data.end, true));
                        }
                    }
                    // Types, globals and the table stay as they are.
                    RelocationType::TypeIndexLeb
                    | RelocationType::GlobalIndexLeb
                    | RelocationType::GlobalIndexI32
                    | RelocationType::TableNumberLeb => {}
                    ty => bail!(
                        "the web runtime has a relocation the pruner does not handle ({ty:?})"
                    ),
                }
            }
        }
        Ok(live)
    }

    /// The ranges of the data segments no data symbol covers.
    fn uncovered(&self) -> Vec<(usize, u32, u32, bool)> {
        let mut covered: Vec<_> = self
            .symbols
            .iter()
            .filter_map(|symbol| match symbol {
                Symbol::Data(data) => Some((data.start, data.end)),
                _ => None,
            })
            .collect();
        covered.sort_unstable();
        let mut gaps = Vec::new();
        for (index, segment) in self.segments.iter().enumerate() {
            let end = segment.address + segment.bytes.len() as u32;
            let mut at = segment.address;
            let first = covered.partition_point(|&(start, _)| start < segment.address);
            for &(start, stop) in &covered[first..] {
                if start >= end {
                    break;
                }
                if start > at {
                    gaps.push((index, at, start, false));
                }
                at = at.max(stop);
            }
            if at < end {
                gaps.push((index, at, end, false));
            }
        }
        gaps
    }
}

/// The custom sections the output leaves out: the linker's and debug info.
fn dropped_custom(name: &str) -> bool {
    matches!(name, "linking" | "name" | "producers" | "target_features")
        || name.starts_with("reloc.")
        || name.starts_with(".debug")
}

fn i32_const(expr: &wasmparser::ConstExpr<'_>) -> anyhow::Result<i32> {
    let mut ops = expr.get_operators_reader();
    match (ops.read()?, ops.read()?) {
        (Operator::I32Const { value }, Operator::End) => Ok(value),
        _ => bail!("an offset of the web runtime is not a constant"),
    }
}

fn check(matches: bool, entry: &RelocationEntry) -> anyhow::Result<()> {
    ensure!(
        matches,
        "the web runtime's {:?} relocation at {} does not match its bytes",
        entry.ty,
        entry.offset
    );
    Ok(())
}

fn put_uleb(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn put_sleb(out: &mut Vec<u8>, mut value: i64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if (value == 0 && byte & 0x40 == 0) || (value == -1 && byte & 0x40 != 0) {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn put_limits(out: &mut Vec<u8>, initial: u64, maximum: Option<u64>) {
    out.push(u8::from(maximum.is_some()));
    put_uleb(out, initial);
    if let Some(maximum) = maximum {
        put_uleb(out, maximum);
    }
}

/// Writes `value` as the five-byte LEB wasm-ld leaves for relocations.
fn put_uleb5(bytes: &mut [u8], value: u32) {
    for (index, byte) in bytes[..5].iter_mut().enumerate() {
        let continued = if index < 4 { 0x80 } else { 0 };
        *byte = ((value >> (7 * index)) & 0x7f) as u8 | continued;
    }
}

#[cfg(test)]
fn put_sleb5(bytes: &mut [u8], value: i32) {
    for (index, byte) in bytes[..5].iter_mut().enumerate() {
        let continued = if index < 4 { 0x80 } else { 0 };
        *byte = ((value >> (7 * index)) & 0x7f) as u8 | continued;
    }
}

fn read_uleb5(bytes: &[u8]) -> u32 {
    let mut value = 0u32;
    for (index, byte) in bytes[..5].iter().enumerate() {
        value |= u32::from(byte & 0x7f).wrapping_shl(7 * index as u32);
        if byte & 0x80 == 0 {
            break;
        }
    }
    value
}

#[cfg(test)]
fn read_sleb5(bytes: &[u8]) -> i32 {
    let mut value = 0i64;
    let mut shift = 0;
    for byte in &bytes[..5] {
        value |= i64::from(byte & 0x7f) << shift;
        shift += 7;
        if byte & 0x80 == 0 {
            if byte & 0x40 != 0 {
                value |= -1i64 << shift;
            }
            break;
        }
    }
    value as i32
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

#[cfg(test)]
mod tests {
    use wasmparser::Validator;

    use super::*;

    /// A module as wasm-ld writes it with `--emit-relocs`, assembled by hand:
    /// `b` (function 0) takes its own address and loads `d1`; `a`
    /// (function 1) calls function 2 and loads `d0`; function 2 takes its
    /// own address; `d0` holds a pointer into itself.
    fn module() -> Vec<u8> {
        fn section(out: &mut Vec<u8>, id: u8, contents: &[u8]) {
            out.push(id);
            put_uleb(out, contents.len() as u64);
            out.extend_from_slice(contents);
        }
        fn name(out: &mut Vec<u8>, name: &str) {
            put_uleb(out, name.len() as u64);
            out.extend_from_slice(name.as_bytes());
        }
        let mut wasm = b"\0asm\x01\0\0\0".to_vec();
        section(&mut wasm, 1, &[1, 0x60, 0, 1, 0x7f]);
        section(&mut wasm, 3, &[3, 0, 0, 0]);
        section(&mut wasm, 4, &[1, 0x70, 1, 3, 3]);
        section(&mut wasm, 5, &[1, 0, 1]);
        let mut exports = vec![3];
        for (export, kind, index) in [("b", 0, 0), ("a", 0, 1), ("memory", 2, 0)] {
            name(&mut exports, export);
            exports.extend_from_slice(&[kind, index]);
        }
        section(&mut wasm, 7, &exports);
        // Slot 1: function 0, slot 2: function 2.
        section(&mut wasm, 9, &[1, 0, 0x41, 1, 0x0b, 2, 0, 2]);

        // Relocations: (type, offset in the section, symbol). Symbols: 0..3
        // the functions, 3 `d0` (1040, 8 bytes), 4 `d1` (1024, 16 bytes).
        let mut code_relocs = Vec::new();
        let mut code = vec![3];
        for ops in [
            &[(0x41, 1, 0, 1), (0x41, 4, 4, 1024)][..],
            &[(0x10, 0, 2, 2), (0x41, 4, 3, 1040)],
            &[(0x41, 1, 2, 2)],
        ] {
            let mut bytes = vec![0];
            let mut at = Vec::new();
            for (index, &(op, ty, symbol, value)) in ops.iter().enumerate() {
                if index > 0 {
                    bytes.push(0x1a);
                }
                bytes.push(op);
                at.push((ty, bytes.len(), symbol));
                let mut padded = [0; 5];
                if ty == 0 {
                    put_uleb5(&mut padded, value as u32);
                } else {
                    put_sleb5(&mut padded, value);
                }
                bytes.extend_from_slice(&padded);
            }
            bytes.push(0x0b);
            code.push(bytes.len() as u8);
            for (ty, offset, symbol) in at {
                code_relocs.push((ty, code.len() + offset, symbol));
            }
            code.extend_from_slice(&bytes);
        }
        let code_index = 6;
        section(&mut wasm, 10, &code);

        let mut data = vec![1, 0, 0x41, 0x80, 0x08, 0x0b, 24];
        data.extend_from_slice(&[0xaa; 16]);
        let pointer_at = data.len();
        data.extend_from_slice(&1044u32.to_le_bytes());
        data.extend_from_slice(&[0xbb; 4]);
        section(&mut wasm, 11, &data);

        let mut linking = Vec::new();
        name(&mut linking, "linking");
        linking.push(2);
        let mut symbols = vec![5];
        for (index, func) in ["b", "a", "c"].iter().enumerate() {
            symbols.extend_from_slice(&[0, 0, index as u8]);
            name(&mut symbols, func);
        }
        for (symbol, offset, size) in [("d0", 16, 8), ("d1", 0, 16)] {
            symbols.extend_from_slice(&[1, 2]);
            name(&mut symbols, symbol);
            symbols.extend_from_slice(&[0, offset, size]);
        }
        linking.push(8);
        put_uleb(&mut linking, symbols.len() as u64);
        linking.extend_from_slice(&symbols);
        let mut info = vec![1];
        name(&mut info, ".data");
        info.extend_from_slice(&[4, 0]);
        linking.push(5);
        put_uleb(&mut linking, info.len() as u64);
        linking.extend_from_slice(&info);
        section(&mut wasm, 0, &linking);

        let mut reloc = Vec::new();
        name(&mut reloc, "reloc.CODE");
        reloc.extend_from_slice(&[code_index, code_relocs.len() as u8]);
        for (ty, at, symbol) in code_relocs {
            reloc.push(ty);
            put_uleb(&mut reloc, at as u64);
            put_uleb(&mut reloc, symbol as u64);
            if ty == 4 {
                reloc.push(0);
            }
        }
        section(&mut wasm, 0, &reloc);
        let mut reloc = Vec::new();
        name(&mut reloc, "reloc.DATA");
        reloc.extend_from_slice(&[code_index + 1, 1, 5, pointer_at as u8, 3, 4]);
        section(&mut wasm, 0, &reloc);
        wasm
    }

    #[test]
    fn a_lazy_gate_gets_what_only_it_reaches() {
        let wasm = module();
        Validator::new().validate_all(&wasm).unwrap();
        let split = split::split(&wasm, &["a", "memory"], &["b"]).unwrap();

        let main = parts(&split.main);
        assert_eq!(main.bodies.len(), 2);
        // `a` calls the function that was 2, now 1, and loads `d0` where it
        // was: nothing moves.
        assert_eq!(read_uleb5(&main.bodies[0][2..]), 1);
        assert_eq!(read_sleb5(&main.bodies[0][9..]), 1040);
        // Function 2 keeps slot 2; slot 1 is `b`'s, filled by its module.
        assert_eq!(read_sleb5(&main.bodies[1][2..]), 2);
        assert_eq!(main.elements, [(2, vec![1])]);
        let mut d0 = 1044u32.to_le_bytes().to_vec();
        d0.extend_from_slice(&[0xbb; 4]);
        assert_eq!(main.data, [(1040, d0)]);
        assert!(main.exports.iter().any(|(name, _)| name == "a"));
        assert!(!main.exports.iter().any(|(name, _)| name == "b"));
        assert!(
            main.exports
                .iter()
                .any(|(name, _)| name == "__indirect_function_table")
        );

        let [side] = &split.sides[..] else {
            panic!("one side module")
        };
        assert_eq!((side.name.as_str(), side.gate.as_deref()), ("b", Some("b")));
        assert!(side.needs.is_empty());
        let side = parts(&side.bytes);
        assert_eq!(side.exports, [("b".to_owned(), 0)]);
        assert_eq!(side.elements, [(1, vec![0])]);
        assert_eq!(side.data, [(1024, vec![0xaa; 16])]);
        assert_eq!(read_sleb5(&side.bodies[0][9..]), 1024);
    }

    #[test]
    fn without_lazy_gates_it_keeps_what_the_exports_reach() {
        let split = split::split(&module(), &["a", "memory"], &[]).unwrap();
        assert!(split.sides.is_empty());
        assert_eq!(parts(&split.main).bodies.len(), 2);
    }

    #[test]
    fn fails_on_a_missing_export() {
        let error = split::split(&module(), &["nsh_part_none"], &[])
            .err()
            .unwrap();
        assert!(error.to_string().contains("nsh_part_none"), "{error}");
    }

    struct Parts {
        bodies: Vec<Vec<u8>>,
        exports: Vec<(String, u32)>,
        data: Vec<(i32, Vec<u8>)>,
        elements: Vec<(i32, Vec<u32>)>,
    }

    fn parts(wasm: &[u8]) -> Parts {
        let mut parts = Parts {
            bodies: Vec::new(),
            exports: Vec::new(),
            data: Vec::new(),
            elements: Vec::new(),
        };
        for payload in Parser::new(0).parse_all(wasm) {
            match payload.unwrap() {
                Payload::CodeSectionEntry(body) => parts.bodies.push(body.as_bytes().to_vec()),
                Payload::ExportSection(reader) => {
                    for export in reader {
                        let export = export.unwrap();
                        parts.exports.push((export.name.to_owned(), export.index));
                    }
                }
                Payload::DataSection(reader) => {
                    for segment in reader {
                        let segment = segment.unwrap();
                        let DataKind::Active { offset_expr, .. } = segment.kind else {
                            panic!()
                        };
                        parts
                            .data
                            .push((i32_const(&offset_expr).unwrap(), segment.data.to_vec()));
                    }
                }
                Payload::ElementSection(reader) => {
                    for element in reader {
                        let element = element.unwrap();
                        let ElementKind::Active { offset_expr, .. } = element.kind else {
                            panic!()
                        };
                        let ElementItems::Functions(funcs) = element.items else {
                            panic!()
                        };
                        parts.elements.push((
                            i32_const(&offset_expr).unwrap(),
                            funcs.into_iter().map(Result::unwrap).collect(),
                        ));
                    }
                }
                Payload::CustomSection(custom) => panic!("kept {}", custom.name()),
                _ => {}
            }
        }
        parts
    }
}
