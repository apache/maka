//! Splitting the web runtime into a main module and side modules.
//!
//! [`split`] makes the main module from what the first screen needs and a
//! side module for what the gates loaded later need, which the page loads
//! (`nsh.js`'s `loadSides`) before the code that uses them runs.

use std::collections::BTreeMap;

use anyhow::{Context as _, bail, ensure};
use wasmparser::{
    ExternalKind, Parser, Payload, RelocationEntry, RelocationType, TypeRef, ValType,
};

use super::{
    Module, check, dropped_custom, put_limits, put_sleb, put_uleb, put_uleb5, read_u32, read_uleb5,
};

/// The main module and the side modules [`split`] made.
pub(crate) struct Split {
    /// The main module.
    pub(crate) main: Vec<u8>,
    /// The side modules: the gates' (in the order the gates were given),
    /// then the shared ones.
    pub(crate) sides: Vec<Side>,
}

/// A side module.
pub(crate) struct Side {
    /// Its name: its gate's, or `nsh_shared_<digest of its gates>`; the
    /// module name the modules importing from it use.
    pub(crate) name: String,
    /// The gate it exports, for a gate's module.
    pub(crate) gate: Option<String>,
    /// The lazy gates whose code it holds: its gate, or the gates sharing
    /// it, in the given order.
    pub(crate) gates: Vec<String>,
    /// The side modules it imports from: loaded before it.
    pub(crate) needs: Vec<String>,
    /// The module.
    pub(crate) bytes: Vec<u8>,
}

/// Who has a function or a byte: no module ([`NONE`]), the main module
/// ([`MAIN`]), or the side module of the set of lazy gates whose bits are
/// set.
type Owner = u128;
const NONE: Owner = 0;
const MAIN: Owner = 1 << 127;
/// Lazy gates past this many are kept in the main module.
const MAX_LAZY: usize = 127;
/// The fewest bytes of code and data a module of what several gates share
/// has: less goes to the main module (a request of its own, with a copy of
/// the types, costs more than the bytes).
const MIN_SHARED: usize = 32 * 1024;

/// Splits a runtime linked with `--emit-relocs` into a main module that
/// keeps `main_exports` (what [`prune`](super::prune) keeps) and side
/// modules for `lazy_gates` ([module docs](self)).
///
/// A lazy gate the main module reaches anyway stays an export of the main
/// module and gets no side module.
pub(crate) fn split(
    wasm: &[u8],
    main_exports: &[&str],
    lazy_gates: &[&str],
) -> anyhow::Result<Split> {
    let module = Module::parse(wasm)?;
    let extra = Extra::parse(wasm)?;
    let export = |name: &str| -> anyhow::Result<u32> {
        module
            .exports
            .iter()
            .find(|e| e.name == name && e.kind == ExternalKind::Func)
            .map(|e| e.index)
            .with_context(|| format!("the web runtime exports no `{name}`"))
    };
    let mut roots = Vec::new();
    for name in main_exports {
        if let Ok(func) = export(name) {
            roots.push(func);
        } else {
            ensure!(
                module.exports.iter().any(|e| e.name == *name),
                "the web runtime exports no `{name}`"
            );
        }
    }
    let mut kept_main: Vec<&str> = Vec::new();
    let mut lazy: Vec<&str> = Vec::new();
    for gate in lazy_gates {
        if lazy.len() < MAX_LAZY {
            lazy.push(gate);
        } else {
            roots.push(export(gate)?);
            kept_main.push(gate);
        }
    }
    let gates: Vec<u32> = lazy.iter().map(|g| export(g)).collect::<Result<_, _>>()?;

    // Who reaches what: the main module first, then each gate. What a set
    // of several gates shares that is too small to be worth a request of
    // its own goes to the main module, with what it reaches.
    let base = module.data_low();
    let marks: Vec<super::Live> = gates
        .iter()
        .map(|&gate| module.mark_from(vec![gate], Vec::new()))
        .collect::<Result<_, _>>()?;
    let body_relocs = module.body_relocs()?;
    let mut data_roots = Vec::new();
    let (funcs, bytes) = loop {
        let main = module.mark_from(roots.clone(), data_roots.clone())?;
        let (funcs, bytes) = owners(&module, &main, &marks);
        let mut size: BTreeMap<Owner, usize> = BTreeMap::new();
        for (func, owner) in funcs.iter().enumerate() {
            if owner.count_ones() > 1 && *owner != MAIN {
                let defined = func - module.imported_funcs as usize;
                *size.entry(*owner).or_default() += module.bodies[defined].len();
            }
        }
        for owner in &bytes {
            if owner.count_ones() > 1 && *owner != MAIN {
                *size.entry(*owner).or_default() += 1;
            }
        }
        // Only a small set whose code and data call nothing outside it and
        // the main module: the main module then grows by it alone.
        let mut leaf: BTreeMap<Owner, bool> = size.keys().map(|o| (*o, true)).collect();
        let mut call = |owner: Owner, entry: &RelocationEntry| -> anyhow::Result<()> {
            if matches!(
                entry.ty,
                RelocationType::FunctionIndexLeb | RelocationType::FunctionIndexI32
            ) {
                let callee = funcs[module.func_of(entry)? as usize];
                if callee != owner && callee != MAIN && callee != NONE {
                    leaf.insert(owner, false);
                }
            }
            Ok(())
        };
        for (func, owner) in funcs.iter().enumerate() {
            if size.contains_key(owner) {
                let defined = func - module.imported_funcs as usize;
                for entry in &module.code_relocs[body_relocs[defined].clone()] {
                    call(*owner, entry)?;
                }
            }
        }
        for reloc in &module.data_relocs {
            let owner = bytes[(reloc.address - base) as usize];
            if size.contains_key(&owner) {
                call(owner, &reloc.entry)?;
            }
        }
        let small = |owner: Owner| {
            size.get(&owner).is_some_and(|s| *s < MIN_SHARED) && leaf.get(&owner) == Some(&true)
        };
        let mut grew = false;
        for (func, owner) in funcs.iter().enumerate() {
            if small(*owner) {
                roots.push(func as u32);
                grew = true;
            }
        }
        for mark in &marks {
            for &range @ (_, start, end, _) in &mark.data {
                if (start..end).any(|at| small(bytes[(at - base) as usize])) {
                    data_roots.push(range);
                    grew = true;
                }
            }
        }
        if !grew {
            break (funcs, bytes);
        }
    };

    // The main module's function indices: imports keep theirs.
    let mut remap = vec![u32::MAX; module.func_count()];
    let mut next = 0;
    for (func, slot) in remap.iter_mut().enumerate() {
        if func < module.imported_funcs as usize || funcs[func] == MAIN {
            *slot = next;
            next += 1;
        }
    }

    // The side modules: every set of gates something belongs to.
    let mut owners: Vec<Owner> = funcs
        .iter()
        .chain(&bytes)
        .copied()
        .filter(|o| *o != NONE && *o != MAIN)
        .collect();
    owners.sort_unstable();
    owners.dedup();
    let name_of = |owner: Owner| -> String {
        if owner.count_ones() == 1 {
            return lazy[owner.trailing_zeros() as usize].to_owned();
        }
        // Named by its gates, so a module's name (and file) stays while
        // they do.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for (k, gate) in lazy.iter().enumerate() {
            if owner & (1 << k) != 0 {
                for byte in gate.bytes().chain([0]) {
                    hash = (hash ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3);
                }
            }
        }
        format!("nsh_shared_{hash:016x}")
    };
    let mut exported = vec![false; module.func_count()];
    let mut plans = Vec::new();
    for &owner in &owners {
        plans.push(Plan::new(
            &module,
            &body_relocs,
            &funcs,
            &bytes,
            owner,
            &mut exported,
        )?);
    }
    let mut sides = Vec::new();
    for plan in &plans {
        let gate = (plan.owner.count_ones() == 1).then(|| {
            let k = plan.owner.trailing_zeros() as usize;
            (gates[k], lazy[k])
        });
        let name = name_of(plan.owner);
        let out = plan.write(
            &module,
            &extra,
            &body_relocs,
            &bytes,
            &exported,
            gate,
            &name_of,
        )?;
        wasmparser::Validator::new()
            .validate_all(&out)
            .with_context(|| format!("the side module `{name}` is not valid"))?;
        let mut needs: Vec<String> = plan.from.iter().map(|o| name_of(*o)).collect();
        needs.sort();
        let users = (0..lazy.len())
            .filter(|&k| plan.owner & (1 << k) != 0)
            .map(|k| lazy[k].to_owned())
            .collect();
        sides.push(Side {
            name,
            gate: gate.map(|(_, g)| g.to_owned()),
            gates: users,
            needs,
            bytes: out,
        });
    }
    // Gates' modules first, in the given order; then the shared ones.
    sides.sort_by_key(|side| match &side.gate {
        Some(gate) => (
            0,
            lazy.iter().position(|g| g == gate).unwrap_or(0),
            String::new(),
        ),
        None => (1, 0, side.name.clone()),
    });

    let kept: Vec<&str> = module
        .exports
        .iter()
        .filter(|e| {
            e.kind != ExternalKind::Func
                || main_exports.contains(&e.name)
                || kept_main.contains(&e.name)
                || (lazy_gates.contains(&e.name) && funcs[e.index as usize] == MAIN)
        })
        .map(|e| e.name)
        .collect();
    let out = write_main(
        &module,
        &extra,
        &body_relocs,
        &funcs,
        &bytes,
        &remap,
        &exported,
        &kept,
    )?;
    wasmparser::Validator::new()
        .validate_all(&out)
        .context("the main module is not valid")?;
    Ok(Split { main: out, sides })
}

/// What [`Module`] does not keep: the types of the imported functions and
/// of the globals, and the table's export.
#[derive(Default)]
struct Extra {
    import_types: Vec<u32>,
    /// Each global's value type (its byte) and whether it is mutable.
    globals: Vec<(u8, bool)>,
}

impl Extra {
    fn parse(wasm: &[u8]) -> anyhow::Result<Self> {
        let mut extra = Extra::default();
        for payload in Parser::new(0).parse_all(wasm) {
            match payload? {
                Payload::ImportSection(reader) => {
                    for import in reader.into_imports() {
                        if let TypeRef::Func(ty) | TypeRef::FuncExact(ty) = import?.ty {
                            extra.import_types.push(ty);
                        }
                    }
                }
                Payload::GlobalSection(reader) => {
                    for global in reader {
                        let ty = global?.ty;
                        let byte = match ty.content_type {
                            ValType::I32 => 0x7f,
                            ValType::I64 => 0x7e,
                            ValType::F32 => 0x7d,
                            ValType::F64 => 0x7c,
                            ValType::V128 => 0x7b,
                            ValType::Ref(_) => {
                                bail!("the web runtime has a global of a reference type")
                            }
                        };
                        extra.globals.push((byte, ty.mutable));
                    }
                }
                _ => {}
            }
        }
        Ok(extra)
    }
}

impl Module<'_> {
    /// The lowest address of the data.
    fn data_low(&self) -> u32 {
        self.segments.first().map_or(0, |s| s.address)
    }

    /// The end of the data.
    fn data_high(&self) -> u32 {
        self.segments
            .last()
            .map_or(0, |s| s.address + s.bytes.len() as u32)
    }

    /// The type of function `func`.
    fn type_of(&self, extra: &Extra, func: u32) -> u32 {
        match func.checked_sub(self.imported_funcs) {
            Some(defined) => self.func_types[defined as usize],
            None => extra.import_types[func as usize],
        }
    }

    /// The table slot the linker gave each function (`u32::MAX`: none).
    fn slots(&self) -> Vec<u32> {
        let mut slots = vec![u32::MAX; self.func_count()];
        if let Some((base, funcs)) = &self.elements {
            for (index, &func) in funcs.iter().enumerate() {
                slots[func as usize] = *base as u32 + index as u32;
            }
        }
        slots
    }
}

/// The runs of bytes `owner` has, as (address, bytes) with their data
/// relocations patched by `patch`.
fn runs(
    module: &Module<'_>,
    bytes: &[Owner],
    owner: Owner,
    patch: &dyn Fn(&mut [u8], &RelocationEntry) -> anyhow::Result<()>,
) -> anyhow::Result<Vec<(u32, Vec<u8>)>> {
    let base = module.data_low();
    let mut out: Vec<(u32, Vec<u8>)> = Vec::new();
    for segment in &module.segments {
        let len = segment.bytes.len() as u32;
        let mut at = 0;
        while at < len {
            let address = segment.address + at;
            if bytes[(address - base) as usize] != owner {
                at += 1;
                continue;
            }
            let start = at;
            while at < len && bytes[(segment.address + at - base) as usize] == owner {
                at += 1;
            }
            let from = segment.bytes.start + start as usize;
            let mut run = module.wasm[from..from + (at - start) as usize].to_vec();
            let (lo_addr, hi_addr) = (segment.address + start, segment.address + at);
            let lo = module.data_relocs.partition_point(|r| r.address < lo_addr);
            let hi = module.data_relocs.partition_point(|r| r.address < hi_addr);
            for reloc in &module.data_relocs[lo..hi] {
                let offset = (reloc.address - lo_addr) as usize;
                let extent = reloc.entry.ty.extent();
                ensure!(
                    offset + extent <= run.len(),
                    "a data relocation across modules"
                );
                patch(&mut run[offset..offset + extent], &reloc.entry)?;
            }
            // Memory starts zeroed: zeros need no bytes.
            if run.iter().any(|b| *b != 0) {
                out.push((lo_addr, run));
            }
        }
    }
    Ok(out)
}

/// Rewrites a function index a relocation names with `index`; table slots,
/// addresses, types and globals stay as they are.
fn patch_funcs(
    module: &Module<'_>,
    bytes: &mut [u8],
    entry: &RelocationEntry,
    index: &dyn Fn(u32) -> anyhow::Result<u32>,
) -> anyhow::Result<()> {
    match entry.ty {
        RelocationType::FunctionIndexLeb => {
            let func = module.func_of(entry)?;
            check(read_uleb5(bytes) == func, entry)?;
            put_uleb5(bytes, index(func)?);
        }
        RelocationType::FunctionIndexI32 => {
            let func = module.func_of(entry)?;
            check(read_u32(bytes) == func, entry)?;
            bytes[..4].copy_from_slice(&index(func)?.to_le_bytes());
        }
        // Addresses (`__heap_base` too: nothing moves), table slots, types
        // and globals stay.
        _ => {}
    }
    Ok(())
}

/// A function's body with its function indices patched.
fn body(
    module: &Module<'_>,
    body_relocs: &[std::ops::Range<usize>],
    defined: usize,
    index: &dyn Fn(u32) -> anyhow::Result<u32>,
) -> anyhow::Result<Vec<u8>> {
    let range = &module.bodies[defined];
    let mut bytes = module.wasm[range.clone()].to_vec();
    for entry in &module.code_relocs[body_relocs[defined].clone()] {
        let at = module.code_start + entry.offset as usize - range.start;
        let extent = entry.ty.extent();
        ensure!(
            at + extent <= bytes.len(),
            "a relocation past its function's end"
        );
        patch_funcs(module, &mut bytes[at..at + extent], entry, index)?;
    }
    Ok(bytes)
}

/// An element section of one active segment per run of consecutive slots.
fn elements(entries: &[(u32, u32)]) -> Vec<u8> {
    let mut runs: Vec<(u32, Vec<u32>)> = Vec::new();
    for &(slot, func) in entries {
        match runs.last_mut() {
            Some((start, funcs)) if *start + funcs.len() as u32 == slot => funcs.push(func),
            _ => runs.push((slot, vec![func])),
        }
    }
    let mut section = Vec::new();
    put_uleb(&mut section, runs.len() as u64);
    for (start, funcs) in runs {
        section.extend_from_slice(&[0, 0x41]);
        put_sleb(&mut section, i64::from(start as i32));
        section.push(0x0b);
        put_uleb(&mut section, funcs.len() as u64);
        for func in funcs {
            put_uleb(&mut section, func.into());
        }
    }
    section
}

fn data_section(segments: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let mut section = Vec::new();
    put_uleb(&mut section, segments.len() as u64);
    for (address, bytes) in segments {
        section.extend_from_slice(&[0, 0x41]);
        put_sleb(&mut section, i64::from(*address as i32));
        section.push(0x0b);
        put_uleb(&mut section, bytes.len() as u64);
        section.extend_from_slice(bytes);
    }
    section
}

fn put_name(out: &mut Vec<u8>, name: &str) {
    put_uleb(out, name.len() as u64);
    out.extend_from_slice(name.as_bytes());
}

fn put_section(out: &mut Vec<u8>, id: u8, section: &[u8]) {
    out.push(id);
    put_uleb(out, section.len() as u64);
    out.extend_from_slice(section);
}

#[allow(clippy::too_many_arguments)]
fn write_main(
    module: &Module<'_>,
    extra: &Extra,
    body_relocs: &[std::ops::Range<usize>],
    funcs: &[Owner],
    bytes: &[Owner],
    remap: &[u32],
    exported: &[bool],
    kept: &[&str],
) -> anyhow::Result<Vec<u8>> {
    let index = |func: u32| -> anyhow::Result<u32> {
        let new = remap[func as usize];
        ensure!(
            new != u32::MAX,
            "the main module calls function {func}, which it does not have"
        );
        Ok(new)
    };
    let slots = module.slots();
    let mut table: Vec<(u32, u32)> = (0..module.func_count())
        // Every main function the linker gave a slot: side modules take
        // their addresses too.
        .filter(|&f| funcs[f] == MAIN && slots[f] != u32::MAX)
        .map(|f| (slots[f], remap[f]))
        .collect();
    table.sort_unstable();
    let segments = runs(module, bytes, MAIN, &|b, e| {
        patch_funcs(module, b, e, &index)
    })?;
    let has_table_export = module.exports.iter().any(|e| e.kind == ExternalKind::Table);

    let mut out = Vec::with_capacity(module.wasm.len() / 2);
    out.extend_from_slice(&module.wasm[..8]);
    for (id, range, name) in &module.sections {
        let mut section = Vec::new();
        match id {
            0 if dropped_custom(name) => continue,
            3 => {
                let types: Vec<u32> = (0..module.bodies.len())
                    .filter(|&d| funcs[module.imported_funcs as usize + d] == MAIN)
                    .map(|d| module.func_types[d])
                    .collect();
                put_uleb(&mut section, types.len() as u64);
                for ty in types {
                    put_uleb(&mut section, ty.into());
                }
            }
            7 => {
                let mut entries: Vec<(String, u8, u32)> = Vec::new();
                for export in &module.exports {
                    if !kept.contains(&export.name) {
                        continue;
                    }
                    let (kind, index) = match export.kind {
                        ExternalKind::Func => (0, remap[export.index as usize]),
                        ExternalKind::Table => (1, export.index),
                        ExternalKind::Memory => (2, export.index),
                        ExternalKind::Global => (3, export.index),
                        ExternalKind::Tag => (4, export.index),
                        ExternalKind::FuncExact => bail!("an exact function export"),
                    };
                    entries.push((export.name.to_owned(), kind, index));
                }
                if !has_table_export {
                    entries.push(("__indirect_function_table".into(), 1, 0));
                }
                for g in 0..extra.globals.len() {
                    entries.push((format!("__nsh_g{g}"), 3, g as u32));
                }
                for (func, exported) in exported.iter().enumerate() {
                    if *exported && (func < module.imported_funcs as usize || funcs[func] == MAIN) {
                        entries.push((format!("__nsh_f{func}"), 0, remap[func]));
                    }
                }
                put_uleb(&mut section, entries.len() as u64);
                for (name, kind, index) in entries {
                    put_name(&mut section, &name);
                    section.push(kind);
                    put_uleb(&mut section, index.into());
                }
            }
            8 => put_uleb(&mut section, index(module.start.unwrap_or(0))?.into()),
            9 => {
                if table.is_empty() {
                    continue;
                }
                section = elements(&table);
            }
            10 => {
                let kept: Vec<usize> = (0..module.bodies.len())
                    .filter(|&d| funcs[module.imported_funcs as usize + d] == MAIN)
                    .collect();
                put_uleb(&mut section, kept.len() as u64);
                for d in kept {
                    let bytes = body(module, body_relocs, d, &index)?;
                    put_uleb(&mut section, bytes.len() as u64);
                    section.extend_from_slice(&bytes);
                }
            }
            12 => put_uleb(&mut section, segments.len() as u64),
            11 => section = data_section(&segments),
            _ => section.extend_from_slice(&module.wasm[range.clone()]),
        }
        put_section(&mut out, *id, &section);
    }
    Ok(out)
}

/// One side module's functions: those it imports, then its own.
struct Plan {
    owner: Owner,
    /// What it imports, by the module that has it ([`MAIN`] for the main
    /// module and its imports).
    imports: Vec<(Owner, u32)>,
    /// The side modules it imports from.
    from: Vec<Owner>,
    own: Vec<u32>,
    index: Vec<u32>,
}

impl Plan {
    fn new(
        module: &Module<'_>,
        body_relocs: &[std::ops::Range<usize>],
        funcs: &[Owner],
        bytes: &[Owner],
        owner: Owner,
        exported: &mut [bool],
    ) -> anyhow::Result<Plan> {
        let own: Vec<u32> = (0..module.func_count() as u32)
            .filter(|&f| funcs[f as usize] == owner)
            .collect();
        let mut wanted = vec![false; module.func_count()];
        let mut note = |entry: &RelocationEntry| -> anyhow::Result<()> {
            if matches!(
                entry.ty,
                RelocationType::FunctionIndexLeb | RelocationType::FunctionIndexI32
            ) {
                let func = module.func_of(entry)?;
                if funcs[func as usize] != owner {
                    wanted[func as usize] = true;
                }
            }
            Ok(())
        };
        for &func in &own {
            let defined = (func - module.imported_funcs) as usize;
            for entry in &module.code_relocs[body_relocs[defined].clone()] {
                note(entry)?;
            }
        }
        let base = module.data_low();
        for reloc in &module.data_relocs {
            if bytes[(reloc.address - base) as usize] == owner {
                note(&reloc.entry)?;
            }
        }
        let mut imports = Vec::new();
        let mut from = Vec::new();
        for func in (0..module.func_count() as u32).filter(|&f| wanted[f as usize]) {
            let has = if func < module.imported_funcs {
                MAIN
            } else {
                funcs[func as usize]
            };
            // What a module reaches, its callees reach with at least the
            // same gates: never a module it is itself imported by.
            ensure!(
                has == MAIN || (has & owner == owner && has != owner),
                "a side module calls function {func}, which no module it may import from has"
            );
            exported[func as usize] = true;
            if has != MAIN && !from.contains(&has) {
                from.push(has);
            }
            imports.push((has, func));
        }
        // Grouped by module, as they are imported.
        imports.sort_by_key(|&(has, func)| (has, func));
        let mut index = vec![u32::MAX; module.func_count()];
        for (i, func) in imports
            .iter()
            .map(|(_, f)| *f)
            .chain(own.iter().copied())
            .enumerate()
        {
            index[func as usize] = i as u32;
        }
        Ok(Plan {
            owner,
            imports,
            from,
            own,
            index,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn write(
        &self,
        module: &Module<'_>,
        extra: &Extra,
        body_relocs: &[std::ops::Range<usize>],
        bytes: &[Owner],
        exported: &[bool],
        gate: Option<(u32, &str)>,
        name_of: &dyn Fn(Owner) -> String,
    ) -> anyhow::Result<Vec<u8>> {
        let lookup = |func: u32| -> anyhow::Result<u32> {
            let i = self.index[func as usize];
            ensure!(
                i != u32::MAX,
                "a side module calls function {func}, which it does not import"
            );
            Ok(i)
        };
        let mut out = module.wasm[..8].to_vec();
        // Types: the main module's, as they are.
        let types = module
            .sections
            .iter()
            .find(|(id, ..)| *id == 1)
            .context("the web runtime has no types")?;
        put_section(&mut out, 1, &module.wasm[types.1.clone()]);

        let mut section = Vec::new();
        let count = 2 + extra.globals.len() + self.imports.len();
        put_uleb(&mut section, count as u64);
        put_name(&mut section, "main");
        put_name(&mut section, "memory");
        section.push(2);
        let memory = module
            .memory
            .as_ref()
            .context("the web runtime has no memory")?;
        put_limits(&mut section, memory.initial, None);
        put_name(&mut section, "main");
        put_name(&mut section, "__indirect_function_table");
        section.push(1);
        section.push(0x70);
        let table = module
            .table
            .as_ref()
            .context("the web runtime has no table")?;
        put_limits(&mut section, table.initial, None);
        for (g, (ty, mutable)) in extra.globals.iter().enumerate() {
            put_name(&mut section, "main");
            put_name(&mut section, &format!("__nsh_g{g}"));
            section.extend_from_slice(&[3, *ty, u8::from(*mutable)]);
        }
        for &(has, func) in &self.imports {
            let from = if has == MAIN {
                "main".to_owned()
            } else {
                name_of(has)
            };
            put_name(&mut section, &from);
            put_name(&mut section, &format!("__nsh_f{func}"));
            section.push(0);
            put_uleb(&mut section, module.type_of(extra, func).into());
        }
        put_section(&mut out, 2, &section);

        let mut section = Vec::new();
        put_uleb(&mut section, self.own.len() as u64);
        for &func in &self.own {
            put_uleb(&mut section, module.type_of(extra, func).into());
        }
        put_section(&mut out, 3, &section);

        let mut entries: Vec<(String, u32)> = Vec::new();
        if let Some((func, name)) = gate {
            entries.push((name.to_owned(), lookup(func)?));
        }
        for &func in &self.own {
            if exported[func as usize] {
                entries.push((format!("__nsh_f{func}"), lookup(func)?));
            }
        }
        let mut section = Vec::new();
        put_uleb(&mut section, entries.len() as u64);
        for (name, index) in entries {
            put_name(&mut section, &name);
            section.push(0);
            put_uleb(&mut section, index.into());
        }
        put_section(&mut out, 7, &section);

        // Every own function the linker gave a slot: other modules take
        // their addresses too.
        let slots = module.slots();
        let mut table: Vec<(u32, u32)> = self
            .own
            .iter()
            .filter(|&&f| slots[f as usize] != u32::MAX)
            .map(|&f| (slots[f as usize], self.index[f as usize]))
            .collect();
        table.sort_unstable();
        if !table.is_empty() {
            put_section(&mut out, 9, &elements(&table));
        }
        let segments = runs(module, bytes, self.owner, &|b, e| {
            patch_funcs(module, b, e, &lookup)
        })?;
        let mut section = Vec::new();
        put_uleb(&mut section, segments.len() as u64);
        put_section(&mut out, 12, &section);

        let mut section = Vec::new();
        put_uleb(&mut section, self.own.len() as u64);
        for &func in &self.own {
            let bytes = body(
                module,
                body_relocs,
                (func - module.imported_funcs) as usize,
                &lookup,
            )?;
            put_uleb(&mut section, bytes.len() as u64);
            section.extend_from_slice(&bytes);
        }
        put_section(&mut out, 10, &section);
        put_section(&mut out, 11, &data_section(&segments));
        Ok(out)
    }
}

/// Who has each function and each byte: the main module what `main`
/// reaches, the set of gates of `marks` that reach it otherwise.
fn owners(
    module: &Module<'_>,
    main: &super::Live,
    marks: &[super::Live],
) -> (Vec<Owner>, Vec<Owner>) {
    let base = module.data_low();
    let mut funcs = vec![NONE; module.func_count()];
    let mut bytes = vec![NONE; (module.data_high() - base) as usize];
    let mut claim = |live: &super::Live, owner: Owner| {
        for (func, live) in live.funcs.iter().enumerate() {
            if *live && func >= module.imported_funcs as usize && funcs[func] != MAIN {
                funcs[func] |= owner;
            }
        }
        for &(_, start, end, _) in &live.data {
            for at in start..end {
                let byte = &mut bytes[(at - base) as usize];
                if *byte != MAIN {
                    *byte |= owner;
                }
            }
        }
    };
    claim(main, MAIN);
    for (k, mark) in marks.iter().enumerate() {
        claim(mark, 1 << k);
    }
    (funcs, bytes)
}

#[cfg(test)]
mod tests {
    /// Splits the checkout's linkable runtime (built by `nsh package`) and
    /// prints the sizes: `cargo test -p nsh-cli split_the_runtime -- --ignored --nocapture`.
    #[test]
    #[ignore = "needs target/wasm32-unknown-unknown/web/nsh-browser.wasm"]
    fn split_the_runtime() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../target/wasm32-unknown-unknown/web/nsh-browser.wasm"
        );
        let wasm = std::fs::read(path).expect("the linkable runtime");
        let exports = super::super::exports(&wasm).unwrap();
        let lazy = [
            "nsh_feature_shader",
            "nsh_part_rich_editor",
            "nsh_part_text_view",
            "nsh_part_editor",
            "nsh_part_diff",
            "nsh_part_plot",
            "nsh_std_zlib",
            "nsh_part_data_table",
            "nsh_part_dock",
        ];
        let main: Vec<&str> = exports
            .iter()
            .map(String::as_str)
            .filter(|n| !lazy.contains(n))
            .collect();
        let split = super::split(&wasm, &main, &lazy).unwrap();
        let gz = |b: &[u8]| {
            use std::io::Write as _;
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
            e.write_all(b).unwrap();
            e.finish().unwrap().len()
        };
        println!("main {} gz {}", split.main.len(), gz(&split.main));
        for side in &split.sides {
            println!(
                "{} {} gz {} needs {:?}",
                side.name,
                side.bytes.len(),
                gz(&side.bytes),
                side.needs
            );
        }
    }
}
