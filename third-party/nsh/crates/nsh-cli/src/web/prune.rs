//! Pruning the web runtime to what an app uses.
//!
//! The distribution ships one web runtime with every part of `nsh/base` and
//! every standard module, linked by wasm-ld with `--emit-relocs`: it keeps
//! the linker's symbol table (the `linking` section) and every place code
//! and data refer to a function, a table slot or a data symbol
//! (`reloc.CODE`, `reloc.DATA`). The parts are only reached through their
//! registration exports (`nsh_part_editor`, `nsh_std_zlib`, ...), so given
//! the exports an app needs, [`prune`] keeps what they reach and drops the
//! rest, as `wasm-ld --gc-sections` would have linking only those exports,
//! without a Rust toolchain or a linker where apps are packaged:
//!
//! - functions are numbered again (imports stay, all of them: the page
//!   supplies every import whatever the app uses);
//! - the table keeps the functions whose address kept code or data takes,
//!   in their order, from the slot the linker started at;
//! - kept data symbols are packed again, each run of them keeping the
//!   alignment its address had (capped at its segment's), and the bytes no
//!   symbol covers (padding) are kept, as nothing says what they are;
//! - every reference is patched in place: wasm-ld pads the LEBs it
//!   relocates to five bytes, so a patch never changes a size;
//! - `__heap_base`, `__heap_end` and `__data_end` move with the data's end,
//!   and the memory's initial size shrinks with it (it never grows).
//!
//! Types and globals are kept as they are. The output has no custom
//! sections the linker wrote (`linking`, `reloc.*`, `name`, `producers`,
//! `target_features`, debug info) and is validated before it is returned.

use std::ops::Range;

use anyhow::{Context as _, bail, ensure};
use wasmparser::{
    DataKind, ElementItems, ElementKind, ExternalKind, KnownCustom, Linking, Operator, Parser,
    Payload, RefType, RelocationEntry, RelocationType, SymbolFlags, SymbolInfo, TableInit, TypeRef,
    Validator,
};

const PAGE: u64 = 65536;
/// What wasm-ld aligns `__heap_base` to (the stack's alignment).
const HEAP_ALIGN: u32 = 16;

/// Keeps what `exports` reach in a runtime linked with `--emit-relocs`.
///
/// Exports other than functions (`memory`) are always kept; a function
/// export not named is dropped. Fails when a name is not exported, or when
/// the module is not wasm-ld's output with relocations.
pub(crate) fn prune(wasm: &[u8], exports: &[&str]) -> anyhow::Result<Vec<u8>> {
    let all = self::exports(wasm)?;
    if let Some(name) = exports
        .iter()
        .find(|name| !all.iter().any(|export| export == *name))
    {
        bail!("the web runtime exports no `{name}`");
    }
    // The linker already left out what no export reaches: with every export
    // kept, nothing else goes but the linker's sections.
    if all.iter().all(|export| exports.contains(&export.as_str())) {
        return strip(wasm);
    }
    prune_by_relocations(wasm, exports)
}

/// [`prune`]'s work for a subset of the exports.
fn prune_by_relocations(wasm: &[u8], exports: &[&str]) -> anyhow::Result<Vec<u8>> {
    let module = Module::parse(wasm)?;
    let live = module.mark(exports)?;
    let out = module.write(exports, &live)?;
    Validator::new()
        .validate_all(&out)
        .context("the pruned web runtime is not valid")?;
    Ok(out)
}

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

/// The module without the custom sections [`dropped_custom`] names, every
/// other section as it is.
fn strip(wasm: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(wasm.len());
    out.extend_from_slice(&wasm[..8]);
    for payload in Parser::new(0).parse_all(wasm) {
        let payload = payload.context("the web runtime is not a WebAssembly module")?;
        if let Payload::CustomSection(custom) = &payload
            && dropped_custom(custom.name())
        {
            continue;
        }
        if let Some((id, range)) = payload.as_section() {
            let contents = &wasm[range.start as usize..range.end as usize];
            out.push(id);
            put_uleb(&mut out, contents.len() as u64);
            out.extend_from_slice(contents);
        }
    }
    Ok(out)
}

/// A symbol of the `linking` section's table, as far as pruning needs it.
enum Symbol<'a> {
    Func(u32),
    Data(DataSymbol),
    /// An address the linker computed (`__heap_base`), not data.
    Absolute(&'a str, u32),
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
    maximum: Option<u64>,
}

struct Memory {
    initial: u64,
    maximum: Option<u64>,
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
    symbols: Vec<Symbol<'a>>,
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
                            maximum: ty.maximum,
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
                            maximum: memory.maximum,
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

    fn symbol(&self, symbol: SymbolInfo<'a>) -> anyhow::Result<Symbol<'a>> {
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
                    Symbol::Absolute(name, data.offset)
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

    fn mark(&self, exports: &[&str]) -> anyhow::Result<Live> {
        let body_relocs = self.body_relocs()?;
        let mut live = Live {
            funcs: vec![false; self.func_count()],
            taken: vec![false; self.func_count()],
            data: Vec::new(),
        };
        let mut live_symbols = vec![false; self.symbols.len()];
        let mut funcs = Vec::new();
        let mut ranges = Vec::new();

        for name in exports {
            let export = self
                .exports
                .iter()
                .find(|export| export.name == *name)
                .with_context(|| format!("the web runtime exports no `{name}`"))?;
            if export.kind == ExternalKind::Func {
                funcs.push(export.index);
            }
        }
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

    fn write(&self, exports: &[&str], live: &Live) -> anyhow::Result<Vec<u8>> {
        // Functions: imports keep their indices, defined ones close up.
        let mut remap = vec![u32::MAX; self.func_count()];
        let mut next = 0;
        for (func, slot) in remap.iter_mut().enumerate() {
            if func < self.imported_funcs as usize || live.funcs[func] {
                *slot = next;
                next += 1;
            }
        }

        // The table: the functions whose address is taken, in their order.
        let (table_base, old_elements) = match &self.elements {
            Some((base, funcs)) => (*base, funcs.as_slice()),
            None => (1, &[][..]),
        };
        let mut old_slot = vec![u32::MAX; self.func_count()];
        for (index, &func) in old_elements.iter().enumerate() {
            old_slot[func as usize] = table_base as u32 + index as u32;
        }
        let mut new_slot = vec![u32::MAX; self.func_count()];
        let mut elements = Vec::new();
        for &func in old_elements {
            if live.taken[func as usize] && live.funcs[func as usize] {
                new_slot[func as usize] = table_base as u32 + elements.len() as u32;
                elements.push(remap[func as usize]);
            }
        }
        if let Some(func) =
            (0..self.func_count()).find(|&f| live.taken[f] && old_slot[f] == u32::MAX)
        {
            bail!("function {func}'s address is taken, but it has no table slot");
        }

        let layout = Layout::new(self, live)?;

        // Rewrites the bytes a relocation names, checking they held the old value.
        let patch = |bytes: &mut [u8], entry: &RelocationEntry| -> anyhow::Result<()> {
            match entry.ty {
                RelocationType::FunctionIndexLeb => {
                    let func = self.func_of(entry)?;
                    check(read_uleb5(bytes) == func, entry)?;
                    put_uleb5(bytes, remap[func as usize]);
                }
                RelocationType::FunctionIndexI32 => {
                    let func = self.func_of(entry)?;
                    check(read_u32(bytes) == func, entry)?;
                    bytes[..4].copy_from_slice(&remap[func as usize].to_le_bytes());
                }
                RelocationType::TableIndexSleb => {
                    let func = self.func_of(entry)? as usize;
                    check(read_sleb5(bytes) as u32 == old_slot[func], entry)?;
                    put_sleb5(bytes, new_slot[func] as i32);
                }
                RelocationType::TableIndexI32 => {
                    let func = self.func_of(entry)? as usize;
                    check(read_u32(bytes) == old_slot[func], entry)?;
                    bytes[..4].copy_from_slice(&new_slot[func].to_le_bytes());
                }
                RelocationType::MemoryAddrLeb
                | RelocationType::MemoryAddrSleb
                | RelocationType::MemoryAddrI32 => {
                    let Some((old, new)) = layout.address(self, entry)? else {
                        return Ok(());
                    };
                    let new = new.wrapping_add(entry.addend as u32);
                    let old = old.wrapping_add(entry.addend as u32);
                    match entry.ty {
                        RelocationType::MemoryAddrLeb => {
                            check(read_uleb5(bytes) == old, entry)?;
                            put_uleb5(bytes, new);
                        }
                        RelocationType::MemoryAddrSleb => {
                            check(read_sleb5(bytes) as u32 == old, entry)?;
                            put_sleb5(bytes, new as i32);
                        }
                        _ => {
                            check(read_u32(bytes) == old, entry)?;
                            bytes[..4].copy_from_slice(&new.to_le_bytes());
                        }
                    }
                }
                _ => {}
            }
            Ok(())
        };

        let segments = layout.segments(self, &patch)?;
        let mut out = Vec::with_capacity(self.wasm.len() / 2);
        out.extend_from_slice(&self.wasm[..8]);
        let body_relocs = self.body_relocs()?;
        for (id, range, name) in &self.sections {
            let mut section = Vec::new();
            match id {
                0 if dropped_custom(name) => continue,
                3 => {
                    let types: Vec<_> = self
                        .func_types
                        .iter()
                        .enumerate()
                        .filter(|&(index, _)| live.funcs[self.imported_funcs as usize + index])
                        .map(|(_, ty)| *ty)
                        .collect();
                    put_uleb(&mut section, types.len() as u64);
                    for ty in types {
                        put_uleb(&mut section, ty.into());
                    }
                }
                4 => {
                    let table = self.table.as_ref().context("no table")?;
                    let initial = table_base as u64 + elements.len() as u64;
                    let initial = if self.elements.is_some() {
                        initial
                    } else {
                        table.initial
                    };
                    let maximum = table
                        .maximum
                        .map(|max| if max == table.initial { initial } else { max });
                    section.extend_from_slice(&[1, 0x70]);
                    put_limits(&mut section, initial, maximum);
                }
                5 => {
                    let memory = self.memory.as_ref().context("no memory")?;
                    section.push(1);
                    put_limits(&mut section, layout.pages, memory.maximum);
                }
                6 => {
                    // Globals stay as they are: none may point into the data
                    // (`__stack_pointer` starts where the data does).
                    let low = self.segments.first().map_or(0, |s| s.address);
                    for value in self.globals.iter().flatten() {
                        let value = *value as u32;
                        ensure!(
                            value <= low || u64::from(value) > layout.old_heap_end,
                            "a global of the web runtime holds a data address ({value})"
                        );
                    }
                    section.extend_from_slice(&self.wasm[range.clone()]);
                }
                7 => {
                    let kept: Vec<_> = self
                        .exports
                        .iter()
                        .filter(|export| {
                            export.kind != ExternalKind::Func || exports.contains(&export.name)
                        })
                        .collect();
                    put_uleb(&mut section, kept.len() as u64);
                    for export in kept {
                        put_uleb(&mut section, export.name.len() as u64);
                        section.extend_from_slice(export.name.as_bytes());
                        let (kind, index) = match export.kind {
                            ExternalKind::Func => (0, remap[export.index as usize]),
                            ExternalKind::Table => (1, export.index),
                            ExternalKind::Memory => (2, export.index),
                            ExternalKind::Global => (3, export.index),
                            ExternalKind::Tag => (4, export.index),
                            ExternalKind::FuncExact => bail!("an exact function export"),
                        };
                        section.push(kind);
                        put_uleb(&mut section, index.into());
                    }
                }
                8 => put_uleb(&mut section, remap[self.start.unwrap_or(0) as usize].into()),
                9 => {
                    if elements.is_empty() {
                        continue;
                    }
                    section.extend_from_slice(&[1, 0, 0x41]);
                    put_sleb(&mut section, table_base.into());
                    section.push(0x0b);
                    put_uleb(&mut section, elements.len() as u64);
                    for func in &elements {
                        put_uleb(&mut section, (*func).into());
                    }
                }
                10 => {
                    let kept = live.funcs[self.imported_funcs as usize..]
                        .iter()
                        .filter(|live| **live)
                        .count();
                    put_uleb(&mut section, kept as u64);
                    for (index, body) in self.bodies.iter().enumerate() {
                        if !live.funcs[self.imported_funcs as usize + index] {
                            continue;
                        }
                        let mut bytes = self.wasm[body.clone()].to_vec();
                        for entry in &self.code_relocs[body_relocs[index].clone()] {
                            let at = self.code_start + entry.offset as usize - body.start;
                            let extent = entry.ty.extent();
                            ensure!(
                                at + extent <= bytes.len(),
                                "a relocation past its function's end"
                            );
                            patch(&mut bytes[at..at + extent], entry)?;
                        }
                        put_uleb(&mut section, bytes.len() as u64);
                        section.extend_from_slice(&bytes);
                    }
                }
                12 => put_uleb(&mut section, segments.len() as u64),
                11 => {
                    put_uleb(&mut section, segments.len() as u64);
                    for (address, bytes) in &segments {
                        section.extend_from_slice(&[0, 0x41]);
                        put_sleb(&mut section, i64::from(*address as i32));
                        section.push(0x0b);
                        put_uleb(&mut section, bytes.len() as u64);
                        section.extend_from_slice(bytes);
                    }
                }
                _ => section.extend_from_slice(&self.wasm[range.clone()]),
            }
            out.push(*id);
            put_uleb(&mut out, section.len() as u64);
            out.extend_from_slice(&section);
        }
        Ok(out)
    }
}

/// Where the kept data goes: runs of kept bytes, packed in address order.
///
/// The symbol table has no alignments, so each symbol is taken to need the
/// alignment its address has, up to its segment's (the most any of its
/// symbols needs). A run moves by a multiple of the most its symbols need,
/// so every symbol in it keeps its alignment; a run never moves up, so the
/// data never grows.
struct Layout {
    runs: Vec<Run>,
    old_data_end: u32,
    new_data_end: u32,
    old_heap_end: u64,
    pages: u64,
    memory_imported: bool,
}

/// Kept bytes of one segment, contiguous in the input and the output.
#[derive(Clone, Copy)]
struct Run {
    segment: usize,
    start: u32,
    end: u32,
    align: u32,
    new: u32,
}

impl Layout {
    fn new(module: &Module<'_>, live: &Live) -> anyhow::Result<Self> {
        let mut data = live.data.clone();
        data.sort_unstable();
        let mut runs: Vec<Run> = Vec::new();
        for (segment, start, end, symbol) in data {
            let cap = 1u32 << module.segments[segment].align_log2.min(16);
            let align = match start {
                _ if !symbol => 1,
                0 => cap,
                _ => (1 << start.trailing_zeros()).min(cap),
            };
            match runs.last_mut() {
                Some(run) if run.segment == segment && start <= run.end => {
                    run.end = run.end.max(end);
                    run.align = run.align.max(align);
                }
                _ => runs.push(Run {
                    segment,
                    start,
                    end,
                    align,
                    new: 0,
                }),
            }
        }
        let data_low = module.segments.first().map_or(0, |s| s.address);
        let old_data_end = module
            .segments
            .last()
            .map_or(0, |s| s.address + s.bytes.len() as u32);
        let mut cursor = data_low;
        for run in &mut runs {
            // The first address from the cursor on with the run's old
            // address modulo its alignment; never past its old address.
            run.new = cursor + (run.start.wrapping_sub(cursor) & (run.align - 1));
            cursor = run.new + (run.end - run.start);
        }
        let new_data_end = cursor.max(data_low);

        let memory = module.memory.as_ref();
        let old_pages = memory.map_or(0, |memory| memory.initial);
        let top = |end: u32| u64::from(end.next_multiple_of(HEAP_ALIGN)).div_ceil(PAGE);
        let shrink = top(old_data_end).saturating_sub(top(new_data_end));
        Ok(Layout {
            runs,
            old_data_end,
            new_data_end,
            old_heap_end: old_pages * PAGE,
            pages: old_pages.saturating_sub(shrink),
            memory_imported: module.memory_imported,
        })
    }

    /// The old and the new address of the symbol a memory relocation names,
    /// or `None` when it names no data (an undefined weak symbol).
    fn address(
        &self,
        module: &Module<'_>,
        entry: &RelocationEntry,
    ) -> anyhow::Result<Option<(u32, u32)>> {
        Ok(match module.symbols.get(entry.index as usize) {
            Some(Symbol::Data(data)) => {
                let run = self
                    .runs
                    .partition_point(|run| (run.segment, run.start) <= (data.segment, data.start));
                let run = run.checked_sub(1).map(|index| self.runs[index]);
                let Some(run) =
                    run.filter(|run| run.segment == data.segment && data.end <= run.end)
                else {
                    bail!("a kept data symbol at {} was not laid out", data.start);
                };
                Some((data.start, run.new + (data.start - run.start)))
            }
            Some(Symbol::Absolute(name, value)) => {
                let new = match *name {
                    "__data_end" => self.new_data_end,
                    "__heap_base" => {
                        let old_top = self.old_data_end.next_multiple_of(HEAP_ALIGN);
                        let new_top = self.new_data_end.next_multiple_of(HEAP_ALIGN);
                        value.saturating_sub(old_top - new_top)
                    }
                    "__heap_end" => {
                        ensure!(
                            u64::from(*value) == self.old_heap_end,
                            "`__heap_end` is not the memory's initial end"
                        );
                        (self.pages * PAGE) as u32
                    }
                    _ if *value <= module.segments.first().map_or(0, |s| s.address) => *value,
                    _ => bail!("the web runtime refers to `{name}`, an address past its data"),
                };
                Some((*value, new))
            }
            Some(Symbol::Other) => None,
            _ => bail!("a memory relocation names no data symbol"),
        })
    }

    /// The data segments to write: each kept segment's runs, patched.
    fn segments(
        &self,
        module: &Module<'_>,
        patch: &dyn Fn(&mut [u8], &RelocationEntry) -> anyhow::Result<()>,
    ) -> anyhow::Result<Vec<(u32, Vec<u8>)>> {
        let mut out: Vec<(usize, u32, Vec<u8>)> = Vec::new();
        for &Run {
            segment,
            start,
            end,
            new,
            ..
        } in &self.runs
        {
            if out.last().is_none_or(|last| last.0 != segment) {
                out.push((segment, new, Vec::new()));
            }
            let (_, base, bytes) = out.last_mut().expect("pushed above");
            let source = &module.segments[segment];
            let from = source.bytes.start + (start - source.address) as usize;
            let at = (new - *base) as usize;
            bytes.resize(at, 0);
            bytes.extend_from_slice(&module.wasm[from..from + (end - start) as usize]);
            let lo = module.data_relocs.partition_point(|r| r.address < start);
            let hi = module.data_relocs.partition_point(|r| r.address < end);
            for reloc in &module.data_relocs[lo..hi] {
                let at = at + (reloc.address - start) as usize;
                let extent = reloc.entry.ty.extent();
                ensure!(
                    at + extent <= bytes.len(),
                    "a data relocation past its symbol's end"
                );
                patch(&mut bytes[at..at + extent], &reloc.entry)?;
            }
        }
        // Memory starts zeroed, so all-zero segments (`.bss`) need no bytes.
        Ok(out
            .into_iter()
            .filter(|(_, _, bytes)| self.memory_imported || bytes.iter().any(|b| *b != 0))
            .map(|(_, address, bytes)| (address, bytes))
            .collect())
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
    use std::path::Path;

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
    fn keeps_what_exports_reach() {
        let wasm = module();
        Validator::new().validate_all(&wasm).unwrap();
        let out = prune(&wasm, &["a"]).unwrap();

        let mut bodies = Vec::new();
        let mut exports = Vec::new();
        let mut data = Vec::new();
        let mut elements = Vec::new();
        for payload in Parser::new(0).parse_all(&out) {
            match payload.unwrap() {
                Payload::CodeSectionEntry(body) => bodies.push(body.as_bytes().to_vec()),
                Payload::ExportSection(reader) => {
                    for export in reader {
                        let export = export.unwrap();
                        exports.push((export.name.to_owned(), export.index));
                    }
                }
                Payload::DataSection(reader) => {
                    for segment in reader {
                        let segment = segment.unwrap();
                        let DataKind::Active { offset_expr, .. } = segment.kind else {
                            panic!()
                        };
                        data.push((i32_const(&offset_expr).unwrap(), segment.data.to_vec()));
                    }
                }
                Payload::ElementSection(reader) => {
                    for element in reader {
                        let ElementItems::Functions(funcs) = element.unwrap().items else {
                            panic!()
                        };
                        elements = funcs.into_iter().map(Result::unwrap).collect();
                    }
                }
                Payload::CustomSection(custom) => panic!("kept {}", custom.name()),
                _ => {}
            }
        }
        assert_eq!(exports, [("a".to_owned(), 0), ("memory".to_owned(), 0)]);
        assert_eq!(bodies.len(), 2);
        // `a` calls the function that was 2, now 1, and loads `d0`, now at 1024.
        assert_eq!(read_uleb5(&bodies[0][2..]), 1);
        assert_eq!(read_sleb5(&bodies[0][9..]), 1024);
        // Function 1 took slot 2; it is the table's only function now.
        assert_eq!(read_sleb5(&bodies[1][2..]), 1);
        assert_eq!(elements, [1]);
        let mut d0 = 1028u32.to_le_bytes().to_vec();
        d0.extend_from_slice(&[0xbb; 4]);
        assert_eq!(data, [(1024, d0)]);
    }

    #[test]
    fn fails_on_a_missing_export() {
        let error = prune(&module(), &["nsh_part_none"]).unwrap_err();
        assert!(error.to_string().contains("nsh_part_none"), "{error}");
    }

    /// The full web runtime linked with `--emit-relocs`, where this
    /// checkout has one (a maintainer's relink, not built by the tests).
    fn runtime() -> Option<Vec<u8>> {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/agents/bloat/er-all.wasm");
        std::fs::read(path).ok()
    }

    fn bodies(wasm: &[u8]) -> Vec<&[u8]> {
        let mut bodies = Vec::new();
        for payload in Parser::new(0).parse_all(wasm) {
            if let Payload::CodeSectionEntry(body) = payload.unwrap() {
                bodies.push(body.as_bytes());
            }
        }
        bodies
    }

    #[test]
    fn every_export_keeps_the_module() {
        let wasm = module();
        let out = prune(&wasm, &["b", "a"]).unwrap();
        // Following the relocations from every export changes nothing either.
        let relocated = prune_by_relocations(&wasm, &["b", "a"]).unwrap();
        assert_eq!(bodies(&relocated), bodies(&out));
        assert_eq!(bodies(&out), bodies(&wasm));
        assert!(out.len() < wasm.len());
    }

    fn function_count(wasm: &[u8]) -> u32 {
        let mut count = 0;
        for payload in Parser::new(0).parse_all(wasm) {
            if let Payload::CodeSectionStart { count: n, .. } = payload.unwrap() {
                count = n;
            }
        }
        count
    }

    #[test]
    fn runtime_with_every_export_keeps_everything() {
        let Some(wasm) = runtime() else { return };
        let names = exports(&wasm).unwrap();
        let names: Vec<_> = names.iter().map(String::as_str).collect();
        let out = prune(&wasm, &names).unwrap();
        assert_eq!(function_count(&out), function_count(&wasm));
        let relocated = prune_by_relocations(&wasm, &names).unwrap();
        assert!(bodies(&relocated) == bodies(&wasm));
        // wasm-ld's own link with these exports is 11.83 MB.
        assert!(
            (11_700_000..12_000_000).contains(&out.len()),
            "{}",
            out.len()
        );
    }

    #[test]
    fn runtime_with_the_core_keeps_the_core() {
        let Some(wasm) = runtime() else { return };
        let names = exports(&wasm).unwrap();
        let names: Vec<_> = names
            .iter()
            .map(String::as_str)
            .filter(|name| {
                *name == "nsh_part_core"
                    || !(name.starts_with("nsh_part_") || name.starts_with("nsh_std_"))
            })
            .collect();
        let out = prune(&wasm, &names).unwrap();
        // wasm-ld's own link with these exports is 4.50 MB.
        assert!((4_400_000..4_650_000).contains(&out.len()), "{}", out.len());
        let kept = exports(&out).unwrap();
        assert!(kept.iter().any(|name| name == "nsh_part_core"));
        assert!(!kept.iter().any(|name| name == "nsh_part_editor"));
    }
}
