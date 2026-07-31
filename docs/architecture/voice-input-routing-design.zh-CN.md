---
doc_id: architecture.voice-input-routing
title: "Voice 输入：模型能力路由与 Codex 式语音协调器"
language: zh-CN
implementation_status: implemented
document_status: active
last_verified: 2026-07-30
owners:
  - maka-desktop
---

# Voice 输入：模型能力路由与 Codex 式语音协调器

> 本文取代原先“所有语音先经过本地 whisper.cpp”的方案。Voice 不是单一 STT
> 功能，而是三种不同产品能力：把原始音频直接交给 Agent 模型、把语音转成
> Composer 草稿，以及持续的实时语音协调会话。

## 1. 结论

Maka 应按模型能力和用户配置选择语音链路：

1. **原生音频 Agent**：当前 Agent 模型和实际 provider adapter 都支持音频输入时，
   将本次录音作为用户消息直接交给该模型，不在 Maka 前置转写。
2. **配置式语音识别**：当前 Agent 模型不能接收音频时，调用用户显式配置的识别
   connection/model，把结果放进 Composer 草稿，用户确认后发送。
3. **Realtime Voice Coordinator**：提供独立的实时语音会话。语音模型负责对话、
   打断和任务协调，实际长任务仍由 Maka Agent Runtime 执行。

路由必须 fail closed：

- 不使用 macOS 听写或系统 Speech Framework 作为隐式 fallback；
- 不内置、静默下载或自动选择本地 Whisper；
- 未配置识别模型时，不假装录音成功，直接展示可操作错误；
- 不能仅根据 model id 猜测能力；模型声明和当前 provider wire 都必须支持；
- 不在失败后静默切换到另一个会上传音频的 provider。

三条链路在同一功能提交中交付，但保持彼此独立的运行时状态机和安全边界。

## 2. 产品模式

### 2.1 原生音频 Agent（Native Audio Task）

适用于一次有明确起止的语音任务：

```text
按下 Composer 麦克风
  → 录制有界音频
  → 当前 Agent 模型能力检查
  → 原始音频作为本次 user turn 直接发给当前模型
  → 模型理解语音、调用现有工具并继续 Agent loop
```

该模式保留语气、停顿等转写可能损失的信息。用户停止录音并确认发送后才创建
用户消息；Maka 不先把音频变成文字再冒充原始指令。

“模型支持 audio”还不够。直接路线的最低能力是：

- input modality 包含 `audio`；
- endpoint/协议允许在 chat/agent turn 中发送 audio；
- 支持文本输出；
- Maka 对该 provider 的 adapter 已实现对应 wire format；
- 若该 Agent 要工作，仍需满足现有 tool/function calling 约束；
- 会话中持久化明确的“语音任务”标记，原始音频只在本次 operation 内存中存在。

当前 request/response adapter 不保证能从原生 audio turn 取回逐字 transcript，因此不伪造
文本投影；可审计记录使用语音任务标记，模型实际收到的仍是原始音频。

### 2.2 配置式识别（Dictation/STT）

适用于当前 Agent 模型不接受音频，或者用户明确选择“听写到输入框”：

```text
按下 Composer 麦克风
  → 录制有界音频
  → 调用已配置的 recognition connection/model
  → 得到 transcript
  → 追加到原会话的 Composer 草稿
  → 用户编辑并手动发送
```

识别模型是 Voice 设置中的显式依赖，不从当前聊天模型名称推断，也不从操作系统
能力兜底。没有配置时返回：

```text
尚未配置语音识别模型
[前往 Voice 设置] [取消]
```

认证信息复用现有 connection 的安全存储。设置里选择的是 connection、model 和
adapter/endpoint role，而不是任意字符串。

### 2.3 Realtime Voice Coordinator

这是独立产品面，不与一次性 Composer 录音混在同一个状态机里：

```text
麦克风 ⇄ Realtime Voice Model
                 │
                 ├─ start_task
                 ├─ steer_task
                 ├─ check_task
                 └─ summarize_task
                         │
                  Maka Agent Runtime
```

Voice Coordinator 负责自然对话、插话、追问和播报进度；复杂任务通过受限协调工具
交给正常 Maka Agent。任务继续遵守原 Agent 的权限、审批、工作区和会话规则。

首版约束：

- 同一 Maka 实例只允许一个 realtime voice session；
- Voice 断开不取消已经启动的后台 Agent 任务；
- Coordinator 不直接获得无限制 filesystem/shell 工具；
- 语音会话只拿到用于启动、查询和引导任务的窄工具面；
- Realtime 模型、输出声音和 connection 必须显式配置。

## 3. Codex / ChatGPT Voice 的参考结论

OpenAI 当前产品将两件事分开：

- **Voice chat** 是持续的双向语音会话，可自然打断、追问，并能启动、检查和引导
  Codex 任务；
- **Voice dictation** 只把语音转成 Composer 中可编辑的文字。

产品架构上，实时语音模型维护低延迟对话，较深的研究、推理和 Agent 工作可委派给
另一个 frontier model。这个结构说明 Maka 不应把“听写输入”和“持续 Voice Agent”
做成一个模糊按钮，也不应让实时模型直接接管所有长任务。

API 层也有三条对应能力：

- request-based audio：处理一次有界录音；
- transcription endpoint：只返回转写文本；
- Realtime API：维护低延迟、多轮、可调用工具的音频 session。

浏览器/renderer 连接 Realtime 时优先使用 WebRTC；长期 API key 留在可信主进程，
renderer 只获得主进程临时签发的短期 token。

参考资料：

- <https://learn.chatgpt.com/docs/features/voice>
- <https://openai.com/index/introducing-gpt-live/>
- <https://developers.openai.com/api/docs/guides/audio>
- <https://developers.openai.com/api/docs/guides/realtime>
- <https://developers.openai.com/api/docs/guides/realtime-webrtc>
- <https://developers.openai.com/api/docs/guides/speech-to-text>

## 4. Maka 当前实现缺口

### 4.1 模型元数据丢失 audio 能力

`packages/core/src/llm-connections.ts` 的 `ModelInfo.capabilities` 当前只有：

```ts
chat
vision
reasoning
functionCalling
imageGeneration
```

没有 audio input/output、transcription、realtime voice 或 endpoint role。

`scripts/sync-model-metadata.mjs` 虽然读到上游 `modalities.input`，目前只把 `image`
映射成 `vision`，会丢弃 `audio`。因此仓库里即使出现 `gpt-audio`、ASR 等 model id，
运行时也无法可靠选路。

### 4.2 Agent 协议没有明确 AudioPart

`packages/runtime/src/model-protocol.ts` 的 `UserContent` 目前支持 text、image 和通用
file。通用 file 可以装下某些音频 MIME，但不能表达：

- 这是要作为模型原生音频输入，而不是普通附件；
- provider 需要 `input_audio`、multipart transcription 或 realtime event 中的哪一种；
- 音频格式、时长、transcript 和 retention；
- 当前消息是否能在 tool loop 和崩溃恢复中重放。

因此不能只在 UI 塞一个音频文件并期待所有 provider 自动工作。

### 4.3 Voice 目前只是麦克风自检

现有 Settings Voice 链路为：

```text
getUserMedia → MediaRecorder 录制约 2 秒 → 检查大小/时长 → 丢弃
```

它可继续作为硬件测试，但不能与 Composer voice route 共用“成功”语义。

## 5. 能力模型

### 5.1 不再增加一组松散布尔值

建议把模型能力拆成三个维度：

```ts
type ModelModalities = {
  input: Array<'text' | 'image' | 'audio'>;
  output: Array<'text' | 'image' | 'audio'>;
};

type ModelEndpointRole =
  | 'agent_chat'
  | 'audio_chat'
  | 'transcription'
  | 'realtime_voice'
  | 'speech_generation';

type ModelTransport =
  | 'openai_chat_audio'
  | 'openai_audio_transcriptions'
  | 'openai_realtime'
  | 'provider_native';

type ModelVoiceCapabilities = {
  modalities: ModelModalities;
  endpointRoles: ModelEndpointRole[];
  transports: ModelTransport[];
  transcriptOutput: boolean;
};
```

已有 `functionCalling` 等能力保留。Voice 路由同时检查：

```text
model metadata ∩ connection/provider capability ∩ implemented adapter capability
```

三者缺一不可。

### 5.2 元数据来源

- 同步脚本保留上游 input/output modalities；
- endpoint role 和 transport 不能仅凭 model id 猜，优先来自 provider discovery；
- discovery 不完整时使用仓库内可评审的 curated override；
- 用户自定义模型允许手动声明，但首次使用前运行 capability probe；
- probe 失败只标记该 route 不可用，不自动换 provider。

## 6. 路由器

新增纯函数 `resolveVoiceRoute`，由 Core 持有决策规则：

```ts
type VoiceIntent = 'send_task' | 'dictate' | 'voice_chat';

type VoiceRoutePlan =
  | { kind: 'native_audio_task'; modelId: string; adapter: string }
  | { kind: 'transcription_to_draft'; modelId: string; adapter: string }
  | { kind: 'realtime_voice'; modelId: string; transport: 'webrtc' }
  | {
      kind: 'blocked';
      reason:
        | 'recognition_not_configured'
        | 'realtime_not_configured'
        | 'model_not_ready'
        | 'adapter_unsupported'
        | 'permission_denied';
    };
```

决策顺序：

```text
intent == voice_chat
  → 要求已配置且 adapter 已实现的 realtime voice model

intent == dictate
  → 要求已配置且 adapter 已实现的 transcription model

intent == send_task
  → 当前 Agent 模型支持 native audio 且 adapter 已实现
      → native_audio_task
  → 否则 recognition model 已配置且可用
      → transcription_to_draft
  → 否则
      → blocked(recognition_not_configured)
```

`send_task` 走 STT fallback 后只进入草稿，不自动提交。用户需确认识别结果后再次发送。
这是因为原始音频未到当前 Agent 模型，语义已经发生了一次转换。

## 7. 设置与 Composer UX

### 7.1 Voice 设置

新增三个清晰分组：

1. **Agent 原生音频**
   - 使用当前会话 Agent 模型；
   - 展示当前模型是否支持；
   - 不另配“默认 audio model”替换 Agent。
2. **语音识别**
   - recognition connection；
   - transcription model；
   - language/keywords 等 provider 可选项；
   - “测试识别”按钮。
3. **Realtime Voice**
   - realtime connection/model；
   - 输出 voice；
   - “测试会话”按钮。

模型选择器按 endpoint role 和 adapter readiness 过滤，并解释为什么某个模型不可用。

### 7.2 Composer

麦克风按钮根据路由预检显示状态：

- 当前模型原生支持：提示“录音将直接发送给当前 Agent 模型”；
- 将使用识别模型：提示“录音将由 X 转写到输入框”；
- 无可用路线：按钮仍可聚焦，但点击后展示配置错误和设置入口；
- 不用绿色成功状态掩盖“只录了音但没有可处理模型”。

录音交互：

- 点击开始、点击停止；`Esc` 取消；
- 60 秒和 16 MB 双重上限；
- 停止后 `send_task` 原生路线展示发送确认；
- STT 路线处理完成后按 `draftKey` 追加到原会话最新草稿；
- 切换会话时不把结果写进新会话；
- 所有失败都保留原有草稿。

## 8. 数据协议与持久化

### 8.1 明确 AudioPart

扩展运行时协议：

```ts
type AudioPart = {
  type: 'audio';
  data: DataContent;
  mediaType: string;
  format: 'wav' | 'webm' | 'mp3' | 'm4a';
  durationMs: number;
  transcript?: string;
  retention: 'operation_memory';
};
```

provider adapter 负责 lowering：

- audio chat adapter → provider 原生音频 content part；
- transcription adapter → multipart audio/transcriptions 请求；
- realtime adapter → 独立 session events，不复用普通 Agent backend。

adapter 未明确实现时，通用 `FilePart` 不得自动升级成原生音频。

### 8.2 原始音频生命周期

默认保持现有隐私方向：

- 录音前明确显示将访问的 provider；
- 原始音频只在 renderer 和当前 operation-owned runtime 内存中存在；
- 不写入日志、遥测、Memory、普通附件目录或长期缓存；
- tool loop 运行期间保留音频，以便同一模型调用能重建当前 turn；
- turn 完成、失败或取消后立即释放；
- 只持久化 provider 返回并经过用户可见处理的 transcript 及最小元数据。

原生音频模型必须能提供 transcript，或者使用同一显式配置的识别路线补齐投影。
如果无法得到 transcript，该模型首版不标记为 Maka native audio compatible。

崩溃发生在原生音频 turn 中途时，该 turn 标记为不可自动恢复；有 transcript 时允许用户
以文字重新发送。为了恢复而静默落盘原始音频不在首版范围。

### 8.3 认证边界

- 长期 provider credential 只存在于现有安全 connection store；
- 普通 request-based audio 由可信 runtime 发起；
- Realtime WebRTC 由 main 使用长期 key 请求 ephemeral token；
- renderer 永远不获得长期 API key；
- IPC 校验 origin、窗口、operation id、MIME、字节数和时长。

## 9. Adapter 设计

### 9.1 `NativeAudioAdapter`

```ts
interface NativeAudioAdapter {
  supports(model: ModelInfo, connection: ConnectionInfo): boolean;
  lower(part: AudioPart): ProviderContentPart;
}
```

首个实现可针对 OpenAI-compatible audio chat，但必须按实际 endpoint 验证，不能认为
所有 OpenAI-compatible 服务都接受同样的 audio content part。

### 9.2 `VoiceRecognitionAdapter`

```ts
interface VoiceRecognitionAdapter {
  probe(connection: ConnectionInfo, model: ModelInfo): Promise<Readiness>;
  transcribe(input: BoundedAudio, signal: AbortSignal): Promise<Transcript>;
}
```

当前实现支持标准 `/v1/audio/transcriptions` 风格：

- multipart/form-data；
- base URL、API key、headers 来自 connection；
- model 来自 Voice 设置；
- 强制 timeout、响应体上限和 transcript schema 校验；
- 不记录音频、authorization header 或完整 provider 错误体；
- 支持语言和 prompt/keywords，但不把它们写死为 OpenAI 专属字段。

本地识别将来可以作为一种显式安装的 adapter，而不是默认行为。

### 9.3 `RealtimeVoiceAdapter`

独立于普通 request backend：

- main 创建 session/ephemeral token；
- renderer 用 WebRTC 传音频和接收音频；
- data channel 承载 transcript、tool call、interruption 和 session state；
- Coordinator tool call 经 main 校验后映射到 Maka 内部任务 API；
- 断线、重新连接、barge-in 和单 session 互斥由独立状态机负责。

## 10. 安全与失败语义

- 麦克风权限仍只允许可信主窗口顶层 renderer 请求 audio；
- 任何 route 在开始录音前完成 provider/模型预检；
- 明确展示音频会发给哪个 provider；
- route 选定后固定到 operation，录音途中改设置不改变目标；
- provider 失败后不自动改发另一 provider；
- 取消会终止录音、网络请求、tool loop 起点和 realtime session；
- 服务端 401/403 映射为 connection 配置错误；
- 404/unsupported 映射为 adapter/model 不兼容；
- 413/客户端超限映射为录音过长；
- 429/5xx 可重试，但重试前再次提示会重新上传同一段音频；
- 错误日志只保留 route、模型匿名标识、阶段和结构化错误码。

## 11. 一次性交付范围

本实现一次完成以下能力：

- 模型 modalities、endpoint roles、transports、curated metadata 和 adapter readiness；
- `resolveVoiceRoute` 的 native / STT / Realtime 三路 fail-closed 路由；
- Composer 有界录音、无声检测、16 kHz 单声道 WAV、`draftKey` 归属和取消状态机；
- 标准 OpenAI-compatible `/v1/audio/transcriptions` 识别到可编辑草稿；
- `AudioPart` 从 Core/Runtime 贯穿到 provider adapter 边界，原生音频直接进入 Agent loop；
- Voice 设置中的 recognition 和 realtime connection/model 配置及真实识别自检；
- main 侧 Realtime ephemeral token broker、renderer WebRTC/data channel；
- `start_task/steer_task/check_task/summarize_task` 四个窄协调工具；
- 单 Realtime session 互斥、operation 过期与一次性消费、长期密钥不出 main；
- 路由、模型边界、音频 lowering、STT multipart、Realtime secret 和 lease 测试。

验收语义：支持音频的 Agent 模型收到原始音频；不支持时只使用显式配置的 STT；
未配置立即报错；Realtime 长任务仍由普通 Maka Runtime 和原权限边界执行。

## 12. 测试矩阵

必须覆盖：

- 模型 metadata 声称 audio、adapter 不支持 → blocked；
- adapter 支持、模型 metadata 不支持 → blocked；
- native agent audio 完整成功路径；
- native route 无 transcript → 保存语音任务标记，不伪造文本；
- Agent 不支持 audio + STT 已配置 → transcript 到草稿；
- Agent 不支持 audio + STT 未配置 → 设置错误；
- 用户明确选择 dictate，即使 Agent 支持 audio 也走 STT；
- route 固定后修改设置不改变上传目标；
- 录音中取消、上传中取消、tool loop 开始前取消；
- 60 秒、16 MB、无声音、非法 MIME；
- 401、403、404、413、429、5xx 和 timeout；
- 转写期间切会话、编辑原草稿、删除会话；
- provider 失败不静默 fallback；
- raw audio 不进入日志、遥测、Memory 和附件；
- Realtime renderer 不获得长期 API key；
- Voice Coordinator 只能调用任务协调工具；
- 同一实例第二个 realtime session 被拒绝。

## 13. 暂不做

- macOS 系统听写或 Speech Framework fallback；
- 默认 whisper.cpp、本地模型下载和打包；
- 常驻监听、唤醒词、后台偷录；
- STT 完成后自动提交；
- 模型 id 字符串启发式选路；
- 未实现 adapter 的通用 audio file 自动发送；
- 默认保存原始录音或提供录音历史；
- Realtime Coordinator 直接拥有不受限 shell/filesystem 权限。

## 14. 已采用的产品取舍

原生音频 turn 的 raw audio 仅在本次 operation 内存中保留，完成后只保存明确的语音
任务标记；中途崩溃不自动恢复。加密保存原始音频未采用，因为它会改变
`persistAudio: false` 隐私契约，并引入独立保留期、删除和用户 consent 设计。
