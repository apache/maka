// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

const manifest = "{\"abiVersion\":1,\"packageId\":\"zig-echo\",\"contributions\":[{\"id\":\"echo\",\"kind\":\"tool\",\"tool\":{\"name\":\"zig_echo\",\"description\":\"Zig ABI echo tool\",\"parameters\":{\"type\":\"object\"}}}]}";
const result = "{\"from\":\"zig\"}";
var heap: [64 * 1024]u8 = undefined;
var next_heap: u32 = 0;

export fn maka_plugin_manifest_ptr() u32 {
    return @intCast(@intFromPtr(&manifest));
}

export fn maka_plugin_manifest_len() u32 {
    return manifest.len;
}

export fn maka_plugin_alloc(size: u32) u32 {
    const aligned = (size + 7) & ~@as(u32, 7);
    if (aligned > heap.len - next_heap) return 0;
    const ptr = @intFromPtr(&heap) + next_heap;
    next_heap += aligned;
    return @intCast(ptr);
}

export fn maka_plugin_free(_ptr: u32, _size: u32) void {}

export fn maka_plugin_invoke(_input_ptr: u32, _input_len: u32) u64 {
    const ptr: u64 = @intCast(@intFromPtr(&result));
    return (ptr << 32) | result.len;
}
