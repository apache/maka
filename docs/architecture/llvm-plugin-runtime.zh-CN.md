<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# LLVM IR 插件运行时

这条链路把 Maka 的插件入口从“只能加载 TypeScript/JavaScript 模块”扩展为“任何能生成约定 Wasm ABI 的语言都可以接入”。LLVM IR 是编译和审计层，不是运行时 API：C、C++、Rust、Zig、Swift 或自定义 LLVM 前端最终都生成同一个 Wasm core module。

## 第一阶段 ABI

manifest 在已有 `runtime` 节点上声明格式：

```json
{
  "runtime": {
    "entry": "dist/plugin.wasm",
    "format": "wasm",
    "abi": "maka:plugin/runtime@1",
    "llvm": { "major": 18 }
  }
}
```

Wasm 模块不导入宿主函数，只导出下面的接口：

```text
memory: WebAssembly.Memory
maka_plugin_manifest_ptr() -> i32
maka_plugin_manifest_len() -> i32
maka_plugin_alloc(size: i32) -> i32
maka_plugin_free(ptr: i32, size: i32)
maka_plugin_invoke(input_ptr: i32, input_len: i32) -> i64
```

`i64` 按高 32 位指针、低 32 位长度编码返回 JSON 字节串。manifest 描述工具名、参数 schema 和 contribution id；调用输入是 `{kind, toolId, input}`，返回值是任意 JSON 值。

Runtime Host 会在 worker 中实例化模块，限制模块文件、线性内存、输入输出大小，并对单次调用设置超时。当前阶段没有宿主 imports，因此插件不能直接访问文件、网络、Runtime Context 或 Node API；需要这些能力时必须新增版本化 capability ABI，而不是把 Node 对象塞进 Wasm。

## LLVM 编译链

示例在 [`experiments/llvm-plugin/plugin.ll`](/Users/likun/Desktop/workspace-for-maka/maka/experiments/llvm-plugin/plugin.ll)。具备 LLVM Wasm backend 和 `wasm-ld` 后，可以按下面的方式生成模块：

```sh
clang --target=wasm32-unknown-unknown -O2 -c plugin.ll -o plugin.o
wasm-ld plugin.o --no-entry --export-memory \
  --export=maka_plugin_manifest_ptr \
  --export=maka_plugin_manifest_len \
  --export=maka_plugin_alloc \
  --export=maka_plugin_free \
  --export=maka_plugin_invoke \
  --initial-memory=131072 -o plugin.wasm
```

示例目录中的 `build.mjs` 支持通过 `CLANG` 和 `WASM_LD` 环境变量替换工具链路径；它只生成发布包中的 Wasm，不把 LLVM 或 linker 放进 Runtime Host。

`runtime.llvm.major` 是可观测的编译元数据，`runtime.llvm.irDigest` 可选，用于把审计到的 IR 与发布包绑定。它不改变 ABI 版本，也不让 Host 依赖某一个 LLVM 版本。

## 后续演进

当前实现是 Component Model 之前的实验性 core-Wasm transport。`@1` 只是当前 wire format 的版本号，不代表长期兼容承诺。下一步可以在不改变 Maka 工具层适配器的前提下增加 `maka:plugin/component@1`：用 WIT 描述同一组接口，再由 Wasmtime/Component runtime 提供资源、取消和 capability 隔离。执行器、LSP、UI bridge 等高权限贡献不应直接复用当前 tool ABI，应该各自拥有显式的 capability 和生命周期协议。

Rust SDK、C ABI 头文件以及 Rust/C/Zig 模板位于 [`experiments/llvm-plugin/sdk`](/Users/likun/Desktop/workspace-for-maka/maka/experiments/llvm-plugin/sdk)。它们的目的不是锁定 ABI，而是让多个语言实现尽快暴露 ABI 的真实问题。

## 为什么 Rust 插件可以接入

Rust 本身不是 Maka Runtime Host 需要识别的插件格式。Rust 编译器的后端会把 Rust 代码经过 LLVM 降低为目标平台代码；指定 `wasm32-unknown-unknown` 后，产物就是 Wasm core module。Maka 只需要加载这个模块，并检查它是否导出了 `maka:plugin/runtime@1` 要求的内存、manifest、分配器和 invoke 函数，因此不需要在 TypeScript 层嵌入 Rust，也不需要让 Host 理解 Rust 的类型系统。

这层关系可以概括为：

```text
Rust + Arrow Compute
        │ rustc / LLVM backend
        ▼
wasm32-unknown-unknown core module
        │ Maka Plugin ABI @1
        ▼
WasmPluginRuntime worker
        │ existing Tool adapter
        ▼
PluginToolService -> Maka Tool
```

LLVM 在这里是编译后端和可审计产物的来源，不是 Maka 的运行时依赖。只要 C、C++、Rust、Zig、Swift 或其他 LLVM 前端生成相同 ABI，Host 侧的工具适配器都可以复用。

## Arrow Compute 示例

[`experiments/llvm-plugin/arrow-data-analysis`](/Users/likun/Desktop/workspace-for-maka/maka/experiments/llvm-plugin/arrow-data-analysis) 是一个可运行的 Rust 插件包示例。它使用 Apache Arrow Rust 的数组和 aggregate kernels，实现两个 Tool 操作：

- `summary`：对一个数值列计算 `sum`、`min`、`max`、平均值和 null 统计。
- `group_sum`：按字符串列分组，对每组执行相同的 Arrow 数值聚合。

它的 `maka.extension.json` 声明 Wasm runtime，`maka.composition.yml` 把 Tool 注册到 profile，构建后通过现有 `HostPluginPlatform` 安装和激活。E2E 会实际解析 Rust 生成的 Wasm、注册 `arrow_analyze`、执行聚合并卸载插件；`deepseek-e2e.mjs` 还可以在设置 `DEEPSEEK_API_KEY` 后验证 DeepSeek 自动选择该 Tool，再把 Arrow 结果交回模型生成说明。

从仓库根目录构建并运行：

```sh
cd experiments/llvm-plugin
node sdk/build.mjs rust ../arrow-data-analysis
cd ../..
node experiments/llvm-plugin/arrow-data-analysis/e2e.mjs
node experiments/llvm-plugin/arrow-data-analysis/deepseek-e2e.mjs
```
