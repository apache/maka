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
/// out ([`dropped_custom`]): for the main module wasm-bindgen wrote
/// (`web::link`), which has none of the linker's sections left to read.
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

/// The exports of a Rust app's runtime that make a part of `nsh/base` run:
/// `nsh_part_<name>`, which the page calls the first time the app makes a
/// component of that part by name.
const PART_GATE: &str = "nsh_part_";

/// What an app's code runs only when it makes a component by name
/// (`ComponentElement::by_name`): the stand-in its element is until the part
/// that registers the component has run. Found by its name in the symbol
/// table, which has the mangled path of the function. `nsh-core` owns the
/// name and tests that it is still the function's.
const BY_NAME_MARK: &str = nsh_core::element::__private::BY_NAME_MARKER;

/// The export of a Rust app's runtime that makes shaders run (the GLSL ES
/// translation, naga): the page calls it the first time the app shows one.
const SHADER_GATE: &str = "nsh_feature_shader";

/// What an app's code runs only when it makes a shader view or a shader
/// transition: the function `nsh-core` calls from each of them. Found like
/// [`BY_NAME_MARK`], and `nsh-core` tests its name too.
const SHADER_MARK: &str = nsh_core::element::__private::SHADER_USE_MARKER;

/// The gates of `wasm`, a Rust app's linkable runtime, the app does not
/// need: left out with the code only they reach, as `nsh package` splits
/// it (`web::app_split`), rather than published as side modules no page
/// loads.
///
/// - The `nsh_part_*` gates go when the app makes no component by name
///   (every one stays when it does: a part is loaded when its first
///   component is made, and which one that is is not known).
/// - The shader gate goes when no code reachable from the other exports
///   (the part gates that stay among them) makes a shader view or a shader
///   transition.
///
/// Empty when every gate stays or the runtime has none.
pub(crate) fn unused_gates(wasm: &[u8]) -> anyhow::Result<Vec<String>> {
    let module = Module::parse(wasm)?;
    let is_part = |e: &Export<'_>| e.name.starts_with(PART_GATE);
    let is_gate = |e: &Export<'_>| is_part(e) || e.name == SHADER_GATE;
    if !module
        .exports
        .iter()
        .any(|e| is_gate(e) && e.kind == ExternalKind::Func)
    {
        return Ok(Vec::new());
    }
    let funcs = |keep: &dyn Fn(&Export<'_>) -> bool| -> Vec<u32> {
        module
            .exports
            .iter()
            .filter(|e| e.kind == ExternalKind::Func && keep(e))
            .map(|e| e.index)
            .collect()
    };
    let reaches = |roots: Vec<u32>, mark: &str| -> anyhow::Result<bool> {
        let live = module.mark_from(roots, Vec::new())?;
        Ok(module
            .func_names
            .iter()
            .any(|&(func, name)| live.funcs[func as usize] && name.contains(mark)))
    };
    let mut roots = funcs(&|e| !is_gate(e));
    let by_name = reaches(roots.clone(), BY_NAME_MARK)?;
    if by_name {
        roots.extend(funcs(&is_part));
    }
    let shaders = reaches(roots, SHADER_MARK)?;
    Ok(module
        .exports
        .iter()
        .filter(|e| {
            if is_part(e) {
                !by_name
            } else if is_gate(e) {
                !shaders
            } else {
                false
            }
        })
        .map(|e| e.name.to_owned())
        .collect())
}

/// The import modules of the functions wasm-bindgen replaces in the module
/// it reads: the JS functions and intrinsics it provides, and the
/// externref table's.
const BINDGEN_IMPORTS: [&str; 2] = ["__wbindgen_placeholder__", "__wbindgen_externref_xform__"];

/// The import a generic import's shim calls: wasm-bindgen replaces the shim
/// with an import of its own and points every call of it there.
const DESCRIBE_GENERIC_IMPORT: &str = "__wbindgen_describe_generic_import";

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
    /// The imported functions wasm-bindgen replaces ([`BINDGEN_IMPORTS`]).
    bindgen_imports: Vec<u32>,
    /// wasm-bindgen's [`DESCRIBE_GENERIC_IMPORT`], when it is imported.
    describe_generic: Option<u32>,
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
    /// The functions the symbol table names, as the toolchain mangled them.
    func_names: Vec<(u32, &'a str)>,
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
                        let import = import?;
                        match import.ty {
                            TypeRef::Func(_) | TypeRef::FuncExact(_) => {
                                if BINDGEN_IMPORTS.contains(&import.module) {
                                    module.bindgen_imports.push(module.imported_funcs);
                                    if import.name == DESCRIBE_GENERIC_IMPORT {
                                        module.describe_generic = Some(module.imported_funcs);
                                    }
                                }
                                module.imported_funcs += 1;
                            }
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
                        if let SymbolInfo::Func {
                            index,
                            name: Some(name),
                            ..
                        } = &symbol
                        {
                            module.func_names.push((*index, name));
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
pub(super) mod tests {
    use wasmparser::Validator;

    use super::*;

    /// A module as wasm-ld writes it with `--emit-relocs`, assembled by hand:
    /// `b` (function 0) takes its own address and loads `d1`; `a`
    /// (function 1) calls function 2 and loads `d0`; function 2 takes its
    /// own address; `d0` holds a pointer into itself.
    fn module() -> Vec<u8> {
        module_named("b", "c")
    }

    /// [`module`] with `gate` the name of function 0 (`b`) and `callee` that
    /// of function 2 (`c`).
    pub(in crate::web) fn module_named(gate: &str, callee: &str) -> Vec<u8> {
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
        for (export, kind, index) in [(gate, 0, 0), ("a", 0, 1), ("memory", 2, 0)] {
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
        for (index, func) in [gate, "a", callee].iter().enumerate() {
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
        let split = split::split(&wasm, &["a", "memory"], &["b"], false).unwrap();

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
        assert!(main.exports.iter().any(|(name, _)| name == "__nsh_table"));

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

    /// `wasm` split without its [`unused_gates`], as `web::app_split`
    /// leaves them out.
    fn pruned(wasm: &[u8]) -> Vec<u8> {
        let unused = unused_gates(wasm).unwrap();
        assert!(!unused.is_empty());
        let exports = exports(wasm).unwrap();
        let keep: Vec<&str> = exports
            .iter()
            .map(String::as_str)
            .filter(|name| !unused.iter().any(|u| u == name))
            .collect();
        split::split(wasm, &keep, &[], false).unwrap().main
    }

    #[test]
    fn the_shader_gate_goes_when_nothing_shows_a_shader() {
        let wasm = module_named(SHADER_GATE, "nsh_core::shader::other");
        assert_eq!(unused_gates(&wasm).unwrap(), [SHADER_GATE]);
        let pruned = pruned(&wasm);
        Validator::new().validate_all(&pruned).unwrap();
        let pruned = parts(&pruned);
        assert!(pruned.exports.iter().any(|(name, _)| name == "a"));
        assert!(!pruned.exports.iter().any(|(name, _)| name == SHADER_GATE));
        assert_eq!(pruned.bodies.len(), 2);
    }

    #[test]
    fn the_shader_gate_stays_when_the_app_shows_a_shader() {
        let wasm = module_named(SHADER_GATE, &format!("nsh_core::shader::{SHADER_MARK}"));
        assert!(unused_gates(&wasm).unwrap().is_empty());
    }

    #[test]
    fn part_gates_go_when_nothing_makes_a_component_by_name() {
        let wasm = module_named("nsh_part_plot", "nsh_core::element::component::missing_x");
        assert_eq!(unused_gates(&wasm).unwrap(), ["nsh_part_plot"]);
        let pruned = pruned(&wasm);
        Validator::new().validate_all(&pruned).unwrap();
        let pruned = parts(&pruned);
        assert!(pruned.exports.iter().any(|(name, _)| name == "a"));
        assert!(
            !pruned
                .exports
                .iter()
                .any(|(name, _)| name.starts_with("nsh_part_"))
        );
        // The gate's own function is gone with it.
        assert_eq!(pruned.bodies.len(), 2);
    }

    #[test]
    fn part_gates_stay_when_the_app_makes_a_component_by_name() {
        let wasm = module_named(
            "nsh_part_plot",
            &format!("nsh_core::element::component::{BY_NAME_MARK}"),
        );
        assert!(unused_gates(&wasm).unwrap().is_empty());
    }

    #[test]
    fn a_runtime_without_part_gates_is_left_alone() {
        assert!(unused_gates(&module()).unwrap().is_empty());
    }

    /// A runtime whose crates call JS through wasm-bindgen, as wasm-ld
    /// writes it with `--emit-relocs`: function 0 is a JS function
    /// wasm-bindgen provides, 1 the generic imports' descriptor; the gate
    /// `b` (2) calls `h` (3), which calls 0, `k` (4), which calls `g` (5),
    /// the shim of a generic import (it calls 1), and `p` (6); `a` (7) is
    /// the main module's. It has the stack pointer, named, and the features
    /// wasm-bindgen reads.
    fn bindgen_module() -> Vec<u8> {
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
        section(&mut wasm, 1, &[1, 0x60, 0, 0]);
        let mut imports = vec![2];
        for field in ["__wbg_now_1", "__wbindgen_describe_generic_import"] {
            name(&mut imports, "__wbindgen_placeholder__");
            name(&mut imports, field);
            imports.extend_from_slice(&[0, 0]);
        }
        section(&mut wasm, 2, &imports);
        section(&mut wasm, 3, &[6, 0, 0, 0, 0, 0, 0]);
        section(&mut wasm, 4, &[1, 0x70, 0, 1]);
        section(&mut wasm, 5, &[1, 0, 1]);
        section(&mut wasm, 6, &[1, 0x7f, 1, 0x41, 0x80, 0x08, 0x0b]);
        let mut exports = vec![3];
        for (export, kind, index) in [("b", 0, 2), ("a", 0, 7), ("memory", 2, 0)] {
            name(&mut exports, export);
            exports.extend_from_slice(&[kind, index]);
        }
        section(&mut wasm, 7, &exports);

        // Each function's callees; the symbols are the functions' indices.
        let mut code = vec![6];
        let mut relocs = Vec::new();
        for callees in [&[3, 4, 6][..], &[0], &[5], &[1], &[], &[]] {
            let mut body = vec![0];
            let mut at = Vec::new();
            for &callee in callees {
                body.push(0x10);
                at.push((body.len(), callee));
                let mut padded = [0; 5];
                put_uleb5(&mut padded, callee);
                body.extend_from_slice(&padded);
            }
            body.push(0x0b);
            code.push(body.len() as u8);
            for (offset, callee) in at {
                relocs.push((code.len() + offset, callee));
            }
            code.extend_from_slice(&body);
        }
        let code_index = 7;
        section(&mut wasm, 10, &code);

        let mut custom = Vec::new();
        name(&mut custom, "target_features");
        custom.extend_from_slice(&[1, b'+']);
        name(&mut custom, "reference-types");
        section(&mut wasm, 0, &custom);
        let mut names = Vec::new();
        name(&mut names, "name");
        let mut funcs = vec![1, 7];
        name(&mut funcs, "a");
        names.push(1);
        put_uleb(&mut names, funcs.len() as u64);
        names.extend_from_slice(&funcs);
        let mut globals = vec![1, 0];
        name(&mut globals, "__stack_pointer");
        names.push(7);
        put_uleb(&mut names, globals.len() as u64);
        names.extend_from_slice(&globals);
        section(&mut wasm, 0, &names);

        let mut linking = Vec::new();
        name(&mut linking, "linking");
        linking.push(2);
        let mut symbols = vec![8];
        for index in 0..2 {
            // Undefined: the imports, without names of their own.
            symbols.extend_from_slice(&[0, 0x10, index]);
        }
        for (index, func) in ["b", "h", "k", "g", "p", "a"].iter().enumerate() {
            symbols.extend_from_slice(&[0, 0, index as u8 + 2]);
            name(&mut symbols, func);
        }
        linking.push(8);
        put_uleb(&mut linking, symbols.len() as u64);
        linking.extend_from_slice(&symbols);
        section(&mut wasm, 0, &linking);

        let mut reloc = Vec::new();
        name(&mut reloc, "reloc.CODE");
        reloc.extend_from_slice(&[code_index, relocs.len() as u8]);
        for (at, symbol) in relocs {
            reloc.push(0);
            put_uleb(&mut reloc, at as u64);
            put_uleb(&mut reloc, u64::from(symbol));
        }
        section(&mut wasm, 0, &reloc);
        wasm
    }

    /// The names of `wasm`'s custom sections, its imports and its exports.
    fn outline(wasm: &[u8]) -> (Vec<String>, Vec<String>, Vec<String>) {
        let (mut customs, mut imports, mut exports) = (Vec::new(), Vec::new(), Vec::new());
        for payload in Parser::new(0).parse_all(wasm) {
            match payload.unwrap() {
                Payload::CustomSection(custom) => customs.push(custom.name().to_owned()),
                Payload::ImportSection(reader) => {
                    for import in reader.into_imports() {
                        let import = import.unwrap();
                        imports.push(format!("{}.{}", import.module, import.name));
                    }
                }
                Payload::ExportSection(reader) => {
                    for export in reader {
                        exports.push(export.unwrap().name.to_owned());
                    }
                }
                _ => {}
            }
        }
        (customs, imports, exports)
    }

    #[test]
    fn what_calls_js_through_wasm_bindgen_stays_in_the_main_module() {
        let wasm = bindgen_module();
        Validator::new().validate_all(&wasm).unwrap();

        // Split for a page alone, `h`, `k` and `g` go with the gate, which
        // then calls wasm-bindgen's imports through the main module.
        let plain = split::split(&wasm, &["a", "memory"], &["b"], false).unwrap();
        assert_eq!(parts(&plain.main).bodies.len(), 1);
        let [side] = &plain.sides[..] else {
            panic!("one side module")
        };
        let (_, imports, _) = outline(&side.bytes);
        assert!(imports.contains(&"main.__nsh_f0".to_owned()), "{imports:?}");

        // Split for wasm-bindgen, which rewrites what calls its imports and
        // the generic imports' shims: they stay in the main module, and the
        // gate's module calls them there.
        let split = split::split(&wasm, &["a", "memory"], &["b"], true).unwrap();
        let [side] = &split.sides[..] else {
            panic!("one side module")
        };
        assert_eq!(side.gate.as_deref(), Some("b"));
        let (customs, imports, exports) = outline(&side.bytes);
        assert!(customs.is_empty(), "{customs:?}");
        assert_eq!(
            imports,
            [
                "main.memory",
                "main.__nsh_table",
                "main.__nsh_g0",
                "main.__nsh_f3",
                "main.__nsh_f4",
            ]
        );
        assert_eq!(exports, ["b"]);
        // `b` and `p`.
        let mut bodies = 0;
        for payload in Parser::new(0).parse_all(&side.bytes) {
            if let Payload::CodeSectionEntry(_) = payload.unwrap() {
                bodies += 1;
            }
        }
        assert_eq!(bodies, 2);

        let (customs, imports, exports) = outline(&split.main);
        // What wasm-bindgen reads: the features, the globals' names.
        assert_eq!(customs, ["target_features", "name"]);
        assert_eq!(
            imports,
            [
                "__wbindgen_placeholder__.__wbg_now_1",
                "__wbindgen_placeholder__.__wbindgen_describe_generic_import"
            ]
        );
        assert!(exports.contains(&"__nsh_f3".to_owned()), "{exports:?}");
        assert!(!exports.contains(&"__nsh_f0".to_owned()), "{exports:?}");
        let mut names = None;
        let mut bodies = 0;
        for payload in Parser::new(0).parse_all(&split.main) {
            match payload.unwrap() {
                Payload::CustomSection(custom) if custom.name() == "name" => {
                    names = Some(custom.data().to_vec());
                }
                Payload::CodeSectionEntry(_) => bodies += 1,
                _ => {}
            }
        }
        // `h`, `k`, `g` and `a`.
        assert_eq!(bodies, 4);
        // The functions' names are gone with their indices.
        let mut globals = vec![7, 18, 1, 0];
        put_uleb(&mut globals, 15);
        globals.extend_from_slice(b"__stack_pointer");
        assert_eq!(names.unwrap(), globals);
        Validator::new().validate_all(&split.main).unwrap();

        // What wasm-bindgen writes must still have what the side module
        // imports.
        split::check_processed(&split.main, &split.main).unwrap();
        let error = split::check_processed(&split.main, &plain.main)
            .unwrap_err()
            .to_string();
        assert!(error.contains("`__nsh_f3`"), "{error}");
    }

    /// A main module as [`split::check_processed`] reads it: a table of
    /// `table` slots whose slots from 1 hold `slots` (functions of type 0,
    /// `() -> ()`, or 1, `(i32) -> ()`), the `__nsh_g0` global of `global`,
    /// and `data` (start, length) in its memory.
    fn shared_main(table: u8, slots: &[u8], global: i8, data: (u16, u8)) -> Vec<u8> {
        fn section(out: &mut Vec<u8>, id: u8, contents: &[u8]) {
            out.push(id);
            put_uleb(out, contents.len() as u64);
            out.extend_from_slice(contents);
        }
        let mut wasm = b"\0asm\x01\0\0\0".to_vec();
        section(&mut wasm, 1, &[2, 0x60, 0, 0, 0x60, 1, 0x7f, 0]);
        // Function 0, `__nsh_f0`, then one per slot.
        let mut funcs = vec![slots.len() as u8 + 1, 0];
        funcs.extend_from_slice(slots);
        section(&mut wasm, 3, &funcs);
        section(&mut wasm, 4, &[1, 0x70, 0, table]);
        section(&mut wasm, 5, &[1, 0, 1]);
        section(&mut wasm, 6, &[1, 0x7f, 1, 0x41, global as u8 & 0x7f, 0x0b]);
        let mut exports = vec![4];
        for (name, kind) in [
            ("memory", 2),
            (split::TABLE, 1),
            ("__nsh_g0", 3),
            ("__nsh_f0", 0),
        ] {
            put_uleb(&mut exports, name.len() as u64);
            exports.extend_from_slice(name.as_bytes());
            exports.extend_from_slice(&[kind, 0]);
        }
        section(&mut wasm, 7, &exports);
        let mut elements = vec![1, 0, 0x41, 1, 0x0b, slots.len() as u8];
        elements.extend(1..=slots.len() as u8);
        section(&mut wasm, 9, &elements);
        let mut code = vec![slots.len() as u8 + 1];
        for _ in 0..=slots.len() {
            code.extend_from_slice(&[2, 0, 0x0b]);
        }
        section(&mut wasm, 10, &code);
        let (start, len) = data;
        let mut segment = vec![1, 0, 0x41];
        // A signed LEB128 of at most 3 bytes.
        let start = u32::from(start);
        segment.extend_from_slice(&[
            (start & 0x7f) as u8 | 0x80,
            ((start >> 7) & 0x7f) as u8 | 0x80,
            (start >> 14) as u8,
            0x0b,
            len,
        ]);
        segment.resize(segment.len() + len as usize, 0);
        section(&mut wasm, 11, &segment);
        Validator::new().validate_all(&wasm).unwrap();
        wasm
    }

    #[test]
    fn wasm_bindgen_must_leave_what_side_modules_import_as_it_was() {
        let main = shared_main(4, &[0, 1], 7, (1024, 16));
        split::check_processed(&main, &main).unwrap();
        // A larger table and less data are fine.
        split::check_processed(&main, &shared_main(8, &[0, 1], 7, (1024, 8))).unwrap();
        for (processed, expected) in [
            (
                shared_main(2, &[0], 7, (1024, 16)),
                "changed the main module's `__nsh_table`",
            ),
            (shared_main(4, &[0], 7, (1024, 16)), "changed which slots"),
            (
                shared_main(4, &[0, 1, 0], 7, (1024, 16)),
                "changed which slots",
            ),
            (
                shared_main(4, &[0, 0], 7, (1024, 16)),
                "the type of the function in slot 2",
            ),
            (
                shared_main(4, &[0, 1], 8, (1024, 16)),
                "changed the main module's `__nsh_g0`",
            ),
            (
                shared_main(4, &[0, 1], 7, (1024, 17)),
                "put data at 1024..1041",
            ),
            (
                shared_main(4, &[0, 1], 7, (2048, 1)),
                "put data at 2048..2049",
            ),
        ] {
            let error = split::check_processed(&main, &processed)
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected), "{expected}: {error}");
        }
    }

    #[test]
    fn without_lazy_gates_it_keeps_what_the_exports_reach() {
        let split = split::split(&module(), &["a", "memory"], &[], false).unwrap();
        assert!(split.sides.is_empty());
        assert_eq!(parts(&split.main).bodies.len(), 2);
    }

    #[test]
    fn fails_on_a_missing_export() {
        let error = split::split(&module(), &["nsh_part_none"], &[], false)
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
