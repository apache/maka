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

# 外部 Agent

[English](README.md)

通过公共 Executor 插件运行 ACP v1 Agent。配置、进程归属、文件、交互、HTTP 和私有存储
全部使用外部插件同样可用的能力，不需要 V8。

在“外部 Agent”设置页填写 Host 上的可执行文件绝对路径、参数和非秘密环境变量，
保存后检查连接并选择 Agent 提供的认证方式。安装与认证单独请求明确授权；
正常执行仍遵守 Session 沙箱。凭据保留在外部 Agent 自己的登录存储中。

可选的 Antigravity 安装器从 Google 的
[官方登记地址](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)
下载 1.2.1，支持 macOS、Linux、Windows 的 x64／ARM64。安装器限制并验证 ZIP 内容，
原子发布到不可变私有目录。macOS ARM64 固定归档和文件摘要；所有平台都将下载和文件摘要
存入进程不可写的 Host KV，复用时以此校验。缺失可信记录时重新下载官方归档，不采信缓存
自述。这些专有二进制不随 Maka 分发。安装只生成配置草稿，保存后才发布 Executor。

- 文本、思考、工具活动、文件回调和权限问答进入 Host 观测链路。
- 模型与思考选项使用 Agent 声明的配置选择器。
- 每个对话复用原进程；重启后仅通过已声明的 `session/load` 恢复持久化的外部身份。
- 创建与请求意图先落盘再发送；结果不确定时不会另开对话重试。取消会关闭受管理进程，
  未确认结束的请求不能继续。
- 不声明附件、外部对话分叉、终端回调或终端认证能力；不支持的输入明确报错。
- Executor 必须显式声明 `historyCopy` 才能从 Host 历史副本初始化；此 ACP 适配器不声称
  能复制外部 Agent 私有的对话状态。
- 修改某个 Agent 不影响未改动的 Agent。激活失败不撤销已保存配置，可协调重试。

独立 Remote 入口为 `manage`（读取／配置／协调／schema）和 `setup`
（检查／认证／安装流）。内置客户端使用等价的内容摘要绑定入口。

定向测试：`cargo nextest run -p maka-external-agent` 与
`cargo nextest run -p maka-runtime-host --test external_agents`。
被忽略的官方安装测试会实际下载并验证 ACP 初始化，不登录账户。
