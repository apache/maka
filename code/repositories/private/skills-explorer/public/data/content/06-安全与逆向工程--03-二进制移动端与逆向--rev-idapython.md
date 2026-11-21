---
name: rev-idapython
description: IDAPython and IDALib script reference for reverse engineering. Activate when the user needs to write IDAPython scripts in IDA, use IDALib for headless analysis, operate on IDB databases, debug with IDA, manipulate memory/registers, traverse functions/blocks/instructions, work with Hex-Rays decompiler API, handle obfuscation, or batch-process binaries.
---

# rev-idapython - IDAPython / IDALib Script Reference

IDAPython script snippets for IDA interactive use and IDALib headless analysis. Use as reference when generating IDAPython code.

- **IDAPython**: scripts run inside IDA GUI (Script Command, plugin, or IDC console)
- **IDALib**: headless mode introduced in IDA 9.0 — run analysis scripts without opening the IDA GUI

---

## Common API

### Register Operations

```python
idc.get_reg_value('rax')
idaapi.set_reg_val("rax", 1234)
```

### Debug Memory Operations

```python
idc.read_dbg_byte(addr)
idc.read_dbg_memory(addr, size)
idc.read_dbg_dword(addr)
idc.read_dbg_qword(addr)
idc.patch_dbg_byte(addr, val)
idc.add_bpt(0x409437)          # add breakpoint
idaapi.get_imagebase()         # get image base address
```

### Local Memory Operations (modifies IDB database)

```python
idc.get_qword(addr)
idc.patch_qword(addr, val)
idc.patch_dword(addr, val)
idc.patch_word(addr, val)
idc.patch_byte(addr, val)
idc.get_db_byte(addr)
idc.get_bytes(addr, size)
idaapi.get_dword(addr)
idc.get_strlit_contents          # read string literal
```

### Disassembly

```python
GetDisasm(addr)                  # get disassembly text
idc.next_head(ea)                # get next instruction address
idc.create_insn(addr)            # c, Make Code
ida_bytes.create_strlit          # create string, same as 'A' key
ida_funcs.add_func(addr)         # p, create function
idc.del_items(addr)              # U, undefine
```

### Address Conversion

```python
idc.get_name_ea(0, '_sub_6051')  # get address by function name
```

### Function Operations

```python
ida_funcs.get_func(ea)           # get function descriptor

# enumerate all functions
for func in idautils.Functions():
    print("0x%x, %s" % (func, idc.get_func_name(func)))
```

---

## Code Snippets

### Byte Pattern Search

```python
import ida_bytes
import ida_idaapi
import ida_funcs
import idc

# find_bytes_list("90 90 90 90 90")
# find_bytes_list("55 ??")
# returns list of matching addresses
def find_bytes_list(bytes_pattern):
    ea = -1
    result = []
    while True:
        ea = idc.find_bytes(bytes_pattern, ea + 1)
        if ea == ida_idaapi.BADADDR:
            break
        result.append(ea)
    return result
```

### Appcall - Call Debuggee Functions

```python
# test check_passwd(char *passwd) -> int
passwd = ida_idd.Appcall.byref("MyFirstGuess")
res = ida_idd.Appcall.check_passwd(passwd)
if res.value == 0:
  print("Good passwd !")
else:
  print("Bad passwd...")
```

```python
# Explicitly create the buffer as a byref object
s_in = Appcall.byref("SomeEncryptedBuffer")
# Buffers are always returned byref
s_out = Appcall.buffer(" ", SizeOfBuffer)
# Call the debuggee
Appcall.decrypt_buffer(s_in, s_out, SizeOfBuffer)
# Print the result
print "decrypted=", s_out.value
```

```python
loadlib = Appcall.proto("kernel32_LoadLibraryA", "int __stdcall loadlib(const char *fn);")
hmod = loadlib("dll_to_inject.dll")

getlasterror = Appcall.proto("kernel32_GetLastError", "DWORD __stdcall GetLastError();")
print "lasterror=", getlasterror()

getcmdline = Appcall.proto("kernel32_GetCommandLineA", "const char *__stdcall getcmdline();")
print "command line:", getcmdline()
```

### Cross References

```python
for ref in idautils.XrefsTo(ea):
    print(hex(ref.frm))

# shorthand
[ref.frm for ref in idautils.XrefsTo(start_ea)]
```

### Basic Block Traversal

```python
fn = 0x4800
f_blocks = idaapi.FlowChart(idaapi.get_func(fn), flags=idaapi.FC_PREDS)
for block in f_blocks:
    print(hex(block.start_ea))
```

```python
# successor blocks
for succ in block.succs():
    print hex(succ.start_ea)

# predecessor blocks
for pred in block.preds():
    print hex(pred.start_ea)
```

### Debug Memory Read/Write

```python
def patch_dbg_mem(addr, data):
    for i in range(len(data)):
        idc.patch_dbg_byte(addr + i, data[i])

def read_dbg_mem(addr, size):
    dd = []
    for i in range(size):
        dd.append(idc.read_dbg_byte(addr + i))
    return bytes(dd)
```

### Read std::string (64-bit)

```python
def dbg_read_cppstr_64(objectAddr):
    strPtr = idc.read_dbg_qword(objectAddr)
    result = ''
    i = 0
    while True:
        onebyte = idc.read_dbg_byte(strPtr + i)
        if onebyte == 0:
            break
        else:
            result += chr(onebyte)
            i += 1
    return result
```

### Read C String (64-bit)

```python
def dbg_read_cstr_64(objectAddr):
    strPtr = objectAddr
    result = ''
    i = 0
    while True:
        onebyte = idc.read_dbg_byte(strPtr + i)
        if onebyte == 0:
            break
        else:
            result += chr(onebyte)
            i += 1
    return result
```

### Parse GNU C++ std::map

```python
import idautils
import idaapi
import idc

def parse_gnu_map_header(address):
    root = idc.read_dbg_qword(address + 0x10)
    return root

def parse_gnu_map_node(address):
    left  = idc.read_dbg_qword(address + 0x10)
    right = idc.read_dbg_qword(address + 0x18)
    data  = address + 0x20
    return left, right, data

def parse_gnu_map_travel(address):
    # address <- std::map struct address
    result = []
    worklist = [parse_gnu_map_header(address)]
    while len(worklist) > 0:
        addr = worklist.pop()
        (left, right, data) = parse_gnu_map_node(addr)
        if left > 0: worklist.append(left)
        if right > 0: worklist.append(right);
        result.append(data)
    return result

# example
elements = parse_gnu_map_travel(0x0000557518073EB0)
for elem in elements:
    print(hex(elem))
```

### Read XMM Register (Debug)

```python
def read_xmm_reg(name):
    rv = idaapi.regval_t()
    idaapi.get_reg_val(name, rv)
    return (struct.unpack('Q', rv.bytes())[0])
```

### Step Over and Wait for Debug Event

```python
while ida_dbg.step_over():
    wait_for_next_event(WFNE_ANY, -1)
    rip = idc.get_reg_value("rip")
    # .....
```

### Iterate Instructions in a Function

```python
for ins in idautils.FuncItems(0x401000):
    print(hex(ins))
```

### Get Function Callees (Instruction-Based)

```python
def ida_get_callees(func_addr: int) -> list:
    callees = []
    for head in idautils.Heads(func_addr, idaapi.get_func(func_addr).end_ea):
        if idaapi.is_call_insn(head):
            callee_ea = idc.get_operand_value(head, 0)
            callees.append(callee_ea)
    return callees
```

### Double / Complex Number Memory Operations

```python
def float_to_double_bytearray(value):
    double_value = ctypes.c_double(value)
    byte_array = bytearray(ctypes.string_at(ctypes.byref(double_value), ctypes.sizeof(double_value)))
    return byte_array

def set_pos(x, y): # complex<double, double>
    rbp = idc.get_reg_value("rbp")
    complex_base = rbp - 0x260

    patch_dbg_mem(complex_base, float_to_double_bytearray(x))
    patch_dbg_mem(complex_base + 8, float_to_double_bytearray(y))

set_pos(5.0, 6.0)
```

---

## Import Table

### Enumerate Import Table

```python
import ida_nalt

nimps = ida_nalt.get_import_module_qty()

print("Found %d import(s)..." % nimps)

for i in range(nimps):
    name = ida_nalt.get_import_module_name(i)
    if not name:
        print("Failed to get import module name for #%d" % i)
        name = "<unnamed>"

    print("Walking imports for module %s" % name)
    def imp_cb(ea, name, ordinal):
        if not name:
            print("%08x: ordinal #%d" % (ea, ordinal))
        else:
            print("%08x: %s (ordinal #%d)" % (ea, name, ordinal))
        return True
    ida_nalt.enum_import_names(i, imp_cb)

print("All done...")
```

### Check if Address is an Import Function

```python
def ida_is_import_function(addr: int) -> bool:
    is_find = False

    nimps = ida_nalt.get_import_module_qty()

    for i in range(nimps):
        def imp_cb(ea, name, ordinal):
            nonlocal is_find
            if ea == addr:
                is_find = True
                return False
            return True
        ida_nalt.enum_import_names(i, imp_cb)

    return is_find
```

### Enumerate Import Addresses

```python
def ida_enum_import_addr() -> List[int]:
    import_addrs = []
    nimps = ida_nalt.get_import_module_qty()
    for i in range(nimps):
        def imp_cb(ea, name, ordinal):
            nonlocal import_addrs
            import_addrs.append(ea)
            return True
        ida_nalt.enum_import_names(i, imp_cb)
    return import_addrs
```

---

## Type Information

### Struct Member Traversal

```python
def extract_struct_members(type_name):
    fields = []
    tif = ida_typeinf.tinfo_t()
    if tif.get_named_type(None, type_name):
        offset = 0
        for iter in tif.iter_struct(): # udm
            fsize = iter.type.get_size()
            fields.append({
                "offset": iter.offset // 8, # bit offset
                "size": fsize,
                "type": iter.type._print()
            })
            offset += fsize
    else:
        print(f"Unable to get {type_name} type info.")
    return fields

extract_struct_members("sqlite3_vfs")
```

### Enumerate All Types

```python
til = ida_typeinf.get_idati()
for type_name in til.get_type_names():
    print(type_name)
```

### List All Struct Types

```python
def list_struct_types():
    types = []
    til = ida_typeinf.get_idati()
    for type_name in til.get_type_names():
        tif = ida_typeinf.tinfo_t()
        if tif.get_named_type(None, type_name):
            if tif.is_struct():
                types.append(type_name)
    return types
```

---

## Hex-Rays Decompiler API

### Decompile a Function

```python
# verified: IDA 9.0
dec = ida_hexrays.decompile(func_addr)
# dec is an object, str(dec) converts to text
print(str(dec))
```

### Print Microcode at Different Maturity Levels

```python
def print_microcode(func_ea):
    maturity = ida_hexrays.MMAT_GLBOPT3
    #   maturity:
    #   MMAT_ZERO,         ///< microcode does not exist
    #   MMAT_GENERATED,    ///< generated microcode
    #   MMAT_PREOPTIMIZED, ///< preoptimized pass is complete
    #   MMAT_LOCOPT,       ///< local optimization of each basic block is complete.
    #                      ///< control flow graph is ready too.
    #   MMAT_CALLS,        ///< detected call arguments
    #   MMAT_GLBOPT1,      ///< performed the first pass of global optimization
    #   MMAT_GLBOPT2,      ///< most global optimization passes are done
    #   MMAT_GLBOPT3,      ///< completed all global optimization. microcode is fixed now.
    #   MMAT_LVARS,        ///< allocated local variables
    hf = ida_hexrays.hexrays_failure_t()
    pfn = idaapi.get_func(func_ea)
    rng = ida_hexrays.mba_ranges_t(pfn)
    mba = ida_hexrays.gen_microcode(rng, hf, None,
                ida_hexrays.DECOMP_WARNINGS, maturity)
    vp = ida_hexrays.vd_printer_t()
    mba._print(vp)
print_microcode(0x1229)
```

### Custom Instruction to User-Defined Call

```python
class udc_exit_t(ida_hexrays.udc_filter_t):
    def __init__(self, code, name):
        ida_hexrays.udc_filter_t.__init__(self)
        if not self.init("int __usercall %s@<R0>(int status@<R1>);" % name):
            raise Exception("Couldn't initialize udc_exit_t instance")
        self.code = code
        self.installed = False

    def match(self, cdg):
        return cdg.insn.itype == ida_allins.ARM_svc and cdg.insn.Op1.value == self.code

    def install(self):
        ida_hexrays.install_microcode_filter(self, True);
        self.installed = True

    def uninstall(self):
        ida_hexrays.install_microcode_filter(self, False);
        self.installed = False

    def toggle_install(self):
        if self.installed:
            self.uninstall()
        else:
            self.install()

udc_exit = udc_exit_t(0x900001, "svc_exit")
udc_exit.toggle_install()
```

### Hexrays_Hooks

```python
class MicrocodeCallback(ida_hexrays.Hexrays_Hooks):
    def __init__(self, *args):
        super().__init__(*args)
    def microcode(self, mba: ida_hexrays.mba_t) -> "int":
        print("microcode generated.")
        return 0
r = MicrocodeCallback()
r.hook()
```

---

## Obfuscation Helpers

### OLLVM - Set Breakpoints on Real Blocks

Set breakpoints on all real block entry addresses. Real blocks are identified by finding predecessors of the OLLVM dispatcher merge point.

Note: identifying real blocks by xrefs to the merge point is a heuristic and may not be fully accurate. Use IDA breakpoint groups for batch management.

```python
fn = 0x401F60
ollvm_tail = 0x405D4B # OLLVM real block merge point
f_blocks = idaapi.FlowChart(idaapi.get_func(fn), flags=idaapi.FC_PREDS)
for block in f_blocks:
    for succ in block.succs():
        if succ.start_ea == ollvm_tail:
            print(hex(block.start_ea))
            idc.add_bpt(block.start_ea)
```

### Batch Add Breakpoints

```python
def brkall(l):
    for addr in l:
        idc.add_bpt(addr)
```

---

## Firmware Helpers

### Search x86 Function Prologues and Create Functions

```python
# verified: IDA 9.0
def make_x86_func():
    func_headers = find_bytes_list("55 8B")
    for h in func_headers:
        idc.del_items(h)
        idc.create_insn(h)
        ida_funcs.add_func(h)
```

---

## Basic Block Utilities

### Get Basic Block Size

```python
# verified: IDA 9.0
def get_bb_size(bbaddr):
    fn = bbaddr
    f_blocks = idaapi.FlowChart(idaapi.get_func(fn), flags=idaapi.FC_PREDS)
    for block in f_blocks:
        if block.start_ea == bbaddr:
            return block.end_ea - block.start_ea
    raise Exception("Not found")
```

### Get Basic Block by Address

```python
def ida_get_bb(ea):
    f_blocks = idaapi.FlowChart(idaapi.get_func(ea), flags=idaapi.FC_PREDS)
    for block in f_blocks:
        if block.start_ea <= ea and ea < block.end_ea:
            return block
    return None
```

---

## Instruction Utilities

### Search Next Instruction by Keyword

```python
# verified: IDA 9.0
def search_next_insn(addr, insnkey, max_search=0x100):
    cnt = 0
    while cnt < max_search:
        addr = idc.next_head(addr)
        dis = GetDisasm(addr)
        if insnkey in dis:
            return addr
        cnt += 1
    return None

# example
# search_next_insn(addr, 'movdqa')
```

### Undefine a Range (U key equivalent)

```python
# verified: IDA 9.0
def undefine_range(start, end):
    for i in range(start, end):
        idc.del_items(i)
# example
# undefine_range(func_start, func_end)
```

### Search Disassembly Text

```python
# verified: IDA 9.0
def search_text_all(text):
    import idaapi, idc
    start_ea = 0
    result = []
    while True:
        start_ea = idaapi.find_text(ustr=text, x=0, y=0,
            sflag=idaapi.SEARCH_DOWN, start_ea=start_ea)
        if start_ea == idc.BADADDR:
            break
        result.append(start_ea)
        start_ea = idc.next_head(start_ea)
    return result
# example
for x in search_text_all('movdqa'):
    print(GetDisasm(x))
```

---

## NOP Function

```python
import idaapi
import idautils
import idc

def nop_func(addr_func, arch='arm'):
    func = ida_funcs.get_func(addr_func)
    if not func:
        print("Function not found!")
        return

    start = func.start_ea
    end = func.end_ea

    print(f"Nopping function at: 0x{start:x} - 0x{end:x}")

    if arch == 'x86':
        nop_bytes = [0x90]  # x86 NOP
    elif arch == 'arm':
        nop_bytes = [0x1F, 0x20, 0x03, 0xD5]  # ARM NOP
    else:
        print(f"Unsupported architecture: {arch}")
        return

    ea = start
    while ea < end:
        insn = ida_ua.insn_t()
        length = ida_ua.decode_insn(insn, ea)
        if length == 0:
            print(f"Failed to decode instruction at: 0x{ea:x}")
            break

        nop_len = len(nop_bytes)
        for i in range(0, length, nop_len):
            for j in range(nop_len):
                if i + j < length:
                    idc.patch_byte(ea + i + j, nop_bytes[j])

        ea += length

    print("Nopping complete.")

# example
nop_func(0x401000, 'arm')
```

---

## IDALib (Headless IDA, IDA 9.0+)

IDALib allows running IDAPython analysis scripts without opening the IDA GUI.

### Installation

```bash
cd idalib/python
pip install .
python py-activate-idalib.py
```

### Basic Usage

```python
import idapro # must be the first import
import idautils
import idc

# open idb/binary file
ida.open_database("samples/patch.so", True)

# enumerate functions
for func in idautils.Functions():
    func_name = idc.get_func_name(func)
    print("Function Name: {}, Address: {}".format(func_name, hex(func)))

# close and save idb
ida.close_database(save=True)
```

### Batch Decompile to JSON

```bash
Usage: decompile.py <input_file_elf> <output_file_json>
```

decompile.py:

```python
import idapro

import ida_hexrays
import idautils
import idc

import os
import sys
import json

def _decompile_internal():
    result = []
    for func in idautils.Functions():
        func_name = idc.get_func_name(func)
        print("Function Name: {}, Address: {}".format(func_name, hex(func)))
        dec_obj = ida_hexrays.decompile(func)
        if dec_obj is None:
            continue
        dec_str = str(dec_obj)
        result.append({
            'name': func_name,
            'address': hex(func),
            'decompiled': dec_str
        })
    return result

def decomple_export(file, out_file):
    ida.open_database(file, True)
    r = _decompile_internal()
    ida.close_database(save=False)
    open(out_file, "w").write(json.dumps(r, indent=4))

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: {} <input_file_elf> <output_file_json>".format(sys.argv[0]))
        sys.exit(1)
    decomple_export(sys.argv[1], sys.argv[2])
```

### Multiprocess Batch Decompile

```python
import os
import time
from multiprocessing import Pool

args = {
    "NUM_WORKERS": 8,
    "INPUT_DIR": "/Users/ctf/idek2024/baby2/baby",
    "OUTPUT_DIR": "/Users/ctf/idek2024/baby2/decompiled",
    "NUM_MAX_RETRY": 3
}

def decomple_one(file, out_file):
    retry = 0
    while True:
        os.system("python3 decompile.py {} {}".format(file, out_file))
        if os.path.exists(out_file):
            break
        retry += 1
        if retry >= args["NUM_MAX_RETRY"]:
            return "Failed to decompile {}".format(file)
        time.sleep(1)
    return None

if __name__ == "__main__":
    if not os.path.exists(args["OUTPUT_DIR"]):
        os.makedirs(args["OUTPUT_DIR"])
    files = os.listdir(args["INPUT_DIR"])

    files = [os.path.join(args["INPUT_DIR"], f) for f in files]
    out_files = [os.path.join(args["OUTPUT_DIR"], os.path.basename(f) + ".json" ) for f in files]
    with Pool(args["NUM_WORKERS"]) as p:
        r = p.starmap(decomple_one, zip(files, out_files))
        for i in r:
            if i is not None:
                print(i)
```
