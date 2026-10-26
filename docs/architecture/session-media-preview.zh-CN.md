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

# ACP 会话媒体发布

ACP 的 image、resource_link 和 embedded resource 通过 `PluginExecutorContext.publishMedia` 交给 Host，复用 `ChatImageDeliveryService` 的读取边界、联网策略、校验、队列、配额和 Artifact 保存。媒体格式由 Host 校验器决定；本变更沿用 PNG/JPEG/GIF/WebP 支持，SVG 格式与预览由独立变更承接。图片输出只携带当前 Session 的 Artifact 引用，不把 base64 写进消息事件。每次路径或 URL 发布独立捕获，避免同一轮覆盖源文件后复用旧图；已保存结果始终按 Artifact 引用回放，内联内容仍按字节去重。

正文结构化图片转为 `maka://runtime/attachments/<artifactId>` Markdown 引用。工具结果新增有序 `content.parts`，支持文本、已保存图片和 diff；旧 text/file_diff/image 保持可读。旧客户端无法解码新结果，兼容 epoch 从 229 升至 230，合并前需对照 main 确认。

通用复制层收集并重写混合内容的图片引用；ACP 会话仍受既有 provider-owned conversation cloning 限制，本变更不开放外部执行器会话复制。Goal 评估递归保留混合结果中的文字和 diff，省略图片，并沿用脱敏和长度限制。CLI 按顺序输出描述；没有媒体发布能力或发布失败时返回有界文字提示。

通知接收时完成准入并绑定当前轮次，串行处理以保留到达顺序。取消或断连中断媒体等待，但收尾已收到的文字和工具结果；prompt 返回后仍检测断连直至队列排空，迟到通知和媒体完成不会写回已结束轮次。慢图片归档会延迟后续文字，应在端到端验收中观察。

Host 最多 2 个并行捕获、128 个内存任务、512 个持久接收任务；解码中的内联字节最多 8 MiB，SQLite 暂存字节最多 32 MiB。有效原图接收上限为 8 MiB，预览仍限 2 MiB 和既有像素约束；超预览大小的已保存图片提供打开原件入口。ACP 每轮序列化媒体预算为 12 MiB，以容纳 8 MiB 原图的 base64 扩展。ACP 按唯一媒体计数和累计字节限制每轮保留内容，预算按裁剪后媒体对象的序列化 UTF-8 字节计费，audio 计入预算；未使用的媒体元数据、非文本 thought 和不展示的 user message 通知在入队前丢弃。重复工具快照复用媒体对象；纯文本和纯 diff 沿用旧规则，混合结果最多 64 项，超出明确提示省略。

验证覆盖媒体投影、真实 MIME、配额和网络失败、源文件删除后的归档回放、会话复制，以及取消和断连时的顺序与收尾。SVG 文件和代码块预览独立验收。

## 接收、保存与恢复

正文和 ACP 结构化媒体使用同一 Host 接收服务。已提交正文中的授权本地/远程图片主动登记持久任务，接收不再依赖图片是否滚入视口；预览字节仍按需读取。任务与 pending 状态原子写入 Artifact SQLite；已收到的字节先以有界 BLOB 暂存及 SHA-256 校验，再进入既有 fsync 文件和元数据提交流程。最终消息仍只存引用，最终图片仍存 Artifact 文件。

临时读取失败自动重试至多三次，次数与下次时间持久化；权限、格式、尺寸等永久失败退出队列，只保留可见失败原因。配额失败的有效暂存字节可供手动重试，但在新工作需要容量时按旧任务顺序回收；失败状态仍保留。接收缓冲区不是超出归档配额的永久文件仓库。删除会话同时清理任务和暂存字节。

消息正文结束与图片接收完成分别展示，不能用正文完成代表所有附件已保存。待接收时展示接收状态；已保存但超过预览上限时展示原件入口；真正缺失、被拒绝或超出归档配额的来源仍显示失败及可用的重试操作，不伪装成功。

启动恢复在中断运行封口前先完成已暂存字节的归档。ACP 图片的 Artifact 元数据保留准确 publicationRunId；如果已归档图片尚未进入该运行的 canonical 正文或工具结果，Host 写入一条明确标注的恢复图片正文，且对模型历史隐藏。确定性事件 ID 和 Artifact 创建时间保证再次崩溃后可幂等回放，不伪造原工具完成状态或顺序。已结束运行不重新打开；取消后晚到且未进入历史的图片不通过此路径追加。对于正文提交后尚未来得及登记任务的中断运行，启动补扫已提交正文恢复登记。

接收意图不等于已经收到字节：在首次源读取前消失的文件/URL无法凭空恢复；超过配额、磁盘写入失败和非法图片也不能承诺保存成功。已收到字节的进程崩溃恢复与源消失、已归档但尚未发布的消息恢复分别测试。
