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

# maka-transport

[English](README.md)

通过本地 IPC 将前台 UI 连接到独立持有的 Host 部署。启动器提供可信连接配置以及方法和回执恢复权限。公共连接发现绑定 Root 的 Host；不存在时，通过可信 CLI 启动器自动启动。同进程 Host 借用 UI Store。`connections` 管理连接，`Updates` 协调获准的源配置更新。

可信本地应用可使用一个公开入口，通过显式 `startup::Request` 选择 Root、部署及端点权限：

```rust
let mut client = maka_host_runtime::application::host::startup::connect(&maka_executable, request).await?;
// 使用已认证 Client 的目录和调用接口。
client.close().await?;
```

可执行文件必须是可信 Maka CLI 的绝对路径。入口复用现有 Host，或请求该 CLI 启动 Host，校验 Root 和 Host 实例身份，并在 40 秒内完成调用方接入。它使用当前账户的 Root 命名空间，不安装、更新或修复部署。端点和 native 选择用于准备启动；复用运行中的 Host 时沿用其已发布目录及权限。`close` 断开当前会话；`quit` 请求在没有其他会话时关闭 Host。原始调用须保留到清理得到确认；结果未知的 mutation 应通过原始回执恢复判断，重新连接不会重试操作。 `refresh` 在运行中配置变更后，按当前会话原有的端点选择重新捕获服务注册，保留原有权限和已接受的调用。外部 UI peer 仍使用显式捕获与批准流程。

远端注册信息只描述可用服务，不能授予权限、替换调用方或改写已接受操作的目标。关闭 UI 时，先等待原始物理调用及本地持有的同进程 Host 清理。默认退出要求公共 Host 在没有其他会话时停止；此判断与会话接入原子执行。显式选择仅退出 UI 时，断开会话并保留后台工作。

本地和 WebSocket 通道使用四字节无符号长度前缀传输完整 JSON 帧。编解码器不另设整条消息配额。可变的启动与握手请求使用相同的完整帧；固定的规范 Ready 响应保留形状边界。部分读取在取消后保留已收到的字节，并完整保留后续帧及原始资源块。编码和解码仍会在内存中持有完整 JSON 值；只收到长度前缀时不会按声明长度预分配正文。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)
