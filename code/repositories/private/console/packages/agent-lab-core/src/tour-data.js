// src/app/tour-data.js —— 走读模式的关卡数据（纯数据，无 DOM，node 可直接 import 做校验测试）。
//
// 每一关 = 一段真实源码（行区间）+ 为什么这样写 + 在哪能看到它运行。
// 行号是 1-based 闭区间，与源文件逐行对齐——tour-test.mjs 会校验区间不越界，
// 源码改动导致行号漂移时测试立刻红。
//
// runTo：声明"这一步对应哪种断点事件"。走读面板的「运行到这」= 挂上该断点 +
// 自动发演示任务，扣住时卡片亮起——讲解与实跑互相印证。
// watch：没有对应断点的关卡，给"看哪里"的观察指引。

export const DEMO_TASK = '运行 test.js，修复 math.js 让所有测试通过'

export const TOUR_SECTIONS = [
  {
    id: 'agent',
    title: 'agent 循环',
    file: 'agent.js',
    subtitle: 'agent.js · runAgent——一个 while 循环就是整个 agent',
    steps: [
      {
        id: 'a1',
        title: '入口：runAgent 是个 async generator',
        lines: [98, 102],
        anchor: 'async function* runAgent',
        teach: [
          '`async function*`：函数每 `yield` 一个事件就暂停，等消费者来拉下一个。agent 的"节奏控制权"不在自己手里，在外层 for-await 的手里——期3 的断点系统（暂停/单步/慢放）全部建立在这个特性上，agent 代码本身对此一无所知。',
          '五个参数各司其职：`model` 是钥匙，`context` 是全部状态（会被原地修改），`tools` 是能力清单，`signal` 是停止按钮，`opts` 只装 compaction 配置。没有 max_steps——循环到模型自己说停为止。',
        ],
      },
      {
        id: 'a2',
        title: 'while(true)：一圈 = 一轮，转前先检查压缩',
        lines: [104, 117],
        anchor: "type: 'compact_start'",
        teach: [
          '这个 `while (true)` 就是 coding agent 的全部结构：每圈发一次 LLM 请求、执行一轮工具，然后回到顶部。你在这个页面看到的每一次"循环转动"，都是这里又转了一圈。',
          '圈首第一件事是压缩检查：`messages.length` 超过阈值，先把旧消息交给 LLM 总结替换（期6 的 compaction）。注意 `compact_start/end` 只在真正触发时才发——不到阈值时这一段等于不存在，事件流不加噪音。压缩的完整实现在第 11、12 关展开。',
        ],
        runTo: { bp: 'compact_end', hint: '需先把设置 → 高级里的阈值调低（如 8/4），再发几轮对话把消息推过阈值' },
      },
      {
        id: 'a3',
        title: '调 stream()：三个累积器 + 整个 context 全量发送',
        lines: [118, 124],
        anchor: 'for await (const ev of stream(',
        teach: [
          '`text` / `toolCalls` / `stopReason` 三个累积器在循环体内清零——每轮从空白开始收集。LLM 的回复是流，agent 的账本要自己记。',
          '`for await (const ev of stream(...))`：把**整个 context 原样发给模型**。agent 没有"挑选历史"的逻辑——context 就是它的全部记忆，每轮都全量带上。右侧 Context tab 里的卡片，就是这里发出去的东西。',
        ],
      },
      {
        id: 'a4',
        title: 'text_delta 转发：打字机效果的来源',
        lines: [125, 128],
        anchor: "type: 'assistant_text'",
        teach: [
          'LLM 每吐一小段文字（可能只有一个字），agent 就地累积并立刻 `yield` 出去。终端里逐字出现的打字机效果，源头就是这一行转发。',
          '注意 `src` 标的是 `llm.js · stream` 而不是 agent——事件**诞生**在 llm.js，agent 只是转发。行首的 [文件 · 函数] 标签永远告诉你"这步是谁 yield 的"。',
        ],
        watch: '运行任意任务，盯着终端看逐字出现——每个字都是一帧 text_delta 经这两行转发出来的',
      },
      {
        id: 'a5',
        title: 'tool_call：写在循环里，实际在流末尾才到',
        lines: [129, 131],
        anchor: 'toolCalls.push',
        teach: [
          '模型决定调工具时，工具调用的**参数是分片到达的 partial JSON**。llm.js 攒到流结束、parse 完整后才 yield 一个 tool_call（见 llm 篇第 6 关）——所以这两行虽然写在 for await 循环里，实际在每个流的末尾才执行。',
          '此刻的 `args` 已是完整对象。挂上 tool_call 断点，扣住时 DebugBar 的预览就是这里的 `ev.name` 和 `ev.args`——先审阅参数，满意再放行去执行。',
        ],
        runTo: { bp: 'tool_call' },
      },
      {
        id: 'a6',
        title: 'done 与 error：回合的两种非正常出口',
        lines: [132, 146],
        anchor: "stopReason === 'aborted'",
        teach: [
          'aborted（点了"停止"）：丢弃这轮攒的 tool_calls，只推一条纯文本 assistant 消息，`yield turn_end` 后 `return`。为什么丢弃？API 要求每个 tool_call 必须有配对的 tool_result，半途而废的调用没有结果，带着进下轮会直接 400。',
          'error（网络/服务端错误）：把错误转成一条 assistant 文本推进 context，让对话记录如实反映"这轮失败了"，然后 return。agent 不吞错、不重试——把错误原样交给用户看。',
        ],
      },
      {
        id: 'a7',
        title: '塞回 context + max_tokens 截断保护',
        lines: [148, 163],
        anchor: 'buildAssistantMessage(text, toolCalls)',
        teach: [
          '第 144 行 `context.messages.push(...)` 是 agent 的"记忆生长点"：这轮模型说的话（文本 + 工具调用）从此成为历史的一部分，下一轮会原样发回去。Context tab 里每多一张 assistant 卡，就是这里 push 了一次。',
          'max_tokens 截断时 tool args 可能是不完整的 JSON——执行它等于赌运气。教学版的处理：不执行，把错误当 tool_result 放回 context，`continue` 让模型自己看到失败后重发。错误信息本身就是给模型的提示词。',
        ],
      },
      {
        id: 'a8',
        title: 'end_turn：没有 tool_call，循环自然结束',
        lines: [165, 171],
        anchor: "type: 'turn_end'",
        teach: [
          '循环唯一的"正常出口"：模型没调任何工具 → 它认为任务做完了 → `yield turn_end` + `return`。agent 的停止条件不是外部限制，而是**模型自己的判断**——这就是"loop 到模型说停为止"。',
          '第 161 行是防御：个别 API 会返回 finish_reason=tool_use 却不带 tool_call delta，此时视为正常结束而不是死循环。终端里 `── turn 结束（end_turn）──` 的分隔线就是这条 yield 画的。',
        ],
        runTo: { bp: 'turn_end' },
      },
      {
        id: 'a9',
        title: '串行执行工具：一个做完再做下一个',
        lines: [173, 203],
        anchor: 'toolMap.get',
        teach: [
          '`toolMap.get(tc.name)` 查注册表；命中就 `await tool.execute(tc.args, signal)`。执行是串行的——pi 有 sequential/parallel 两种模式，教学版统一串行：顺序可预测，事件流好读。',
          '看 `src` 的三种标注：正常结果和工具抛错都标 `tools.js · xxx.execute`（错误发生在工具内部）；工具名不存在时标 `agent.js · runAgent`（结果由 agent 生成）。行首标签永远指向"这件事真正发生的地方"。',
          '每个 tool_result 都立刻 yield——所以工具执行期间终端是逐个出结果的，而不是全做完一起出。扣 tool_result 断点可以逐个审阅结果再放行。',
        ],
        runTo: { bp: 'tool_result' },
      },
      {
        id: 'a10',
        title: '回环：tool_result 进 context，回到 while 顶部',
        lines: [205, 212],
        anchor: 'buildToolResultMessage(results)',
        teach: [
          '被 abort 跳过的调用补上 `error: aborted`（API 的配对要求，见第 6 关）；然后 `buildToolResultMessage` 把所有结果包成一条 user 消息推进 context。',
          '函数到这里就结束了——没有 goto，没有递归，是 `while (true)` 的圈把它带回了第 100 行。此刻的 context 比上一圈长（多了 assistant 的调用 + 这条结果），下一轮模型会看到自己的动作和结果。**这个环，就是 agent 篇前十关的缩写**——后两关是圈首支线：compactContext 压缩深潜。',
        ],
        runTo: { bp: 'round_start' },
      },
      {
        id: 'a11',
        title: 'compactContext（上）：把旧消息切成两段去总结',
        lines: [38, 76],
        anchor: 'slice(0, -keepRecent)',
        teach: [
          '第 2 关说圈首会检查消息数、超阈值就压缩——实现全在这个函数。两把刀切开记事本：`slice(0, -keepRecent)` 切出要被总结替换的旧消息，`slice(-keepRecent)` 切出原样保留的近期消息（模型正在干的事，细节不能丢）。',
          '旧消息序列化成纯文本，配上临时的 systemPrompt（"请将以下对话总结为…"），发起一轮**独立的** LLM 调用——同一个外脑，这次接的是"总结员"人设，不是 agent 人设。`streamFn` 参数是唯一的依赖注入：平时直接用 llm.js 的 stream，无头测试时注入假 LLM，压缩逻辑就能脱离网络单测。',
        ],
        watch: '想亲眼看：设置 → 高级把阈值调低（如 8/4），多聊几轮——仪表盘转黄后，紫色总结包在地图上 agent⇄llm 走一趟',
      },
      {
        id: 'a12',
        title: 'compactContext（下）：三重失败保护，宁可不压',
        lines: [78, 87],
        anchor: 'failed || !summary',
        teach: [
          '三重保护：abort 了不压、LLM 出错不压、摘要为空不压——任何一样不满足就 `return null`，context 原封不动。原则只有一句：**保留原始消息永远比一个空摘要安全**。宁可记事本继续胖着，也不能让一次失败的总结把记忆擦成空白。',
          '全部成功时，用一条 `[context summary]` 消息顶掉整段旧消息、拼上保留的近期消息。Context tab 里旧卡片折叠成一张摘要卡、水位骤降回绿——就是这两行的视觉效果。设置里的阈值默认 50/20，正常玩很难攒到，演示时可调低。',
        ],
        runTo: { bp: 'compact_end', hint: '需先把设置 → 高级里的阈值调低（如 8/4），再发几轮对话把消息推过阈值' },
      },
    ],
  },
  {
    id: 'llm',
    title: 'llm 流式',
    file: 'llm.js',
    subtitle: 'llm.js · stream——把 SSE 字节流解析成四种事件',
    steps: [
      {
        id: 'l1',
        title: '先翻译再出门：contextToOpenAIMessages',
        lines: [16, 57],
        anchor: "role: 'tool'",
        teach: [
          '我们内部的 Context 结构和 OpenAI 的 messages 格式是两套语言：内部的 tool_result 塞在 user 消息的 blocks 里，OpenAI 却要求它是独立的 `role: "tool"` 消息。这个纯函数只做翻译，不含任何网络逻辑——**格式转换和通信彻底分开**，两边都能单独测试。',
          '右侧 Context tab 打开「wire 视角」开关，看到的就是这个函数的输出——真正飞向 API 的 JSON。',
        ],
        watch: 'Context tab → 点「wire」开关：所见即此处函数的返回值，真正发出去的消息体',
      },
      {
        id: 'l2',
        title: '请求构造：一次 fetch，流式开关',
        lines: [120, 131],
        anchor: 'stream: true',
        teach: [
          '`stream: true` 是整个文件的题眼——不开它，API 会等全部生成完一次性返回；开了它，回复按生成顺序逐块到达。浏览器里 agent 的"实时感"全部来自这一个布尔值。',
          'body 里除了 messages 还有 tools 清单（agent 篇第 3 关传进来的 toolDefs）：name + description + JSON Schema parameters。模型看不到工具代码，只看这份说明书来决定"有没有能力做某事"。',
        ],
        watch: 'fetch 是浏览器原生 API；signal 参数让"停止"按钮能一路掐到网络层',
      },
      {
        id: 'l3',
        title: '两个错误出口：网络炸了 vs 服务端拒绝',
        lines: [133, 150],
        anchor: 'response.ok',
        teach: [
          'fetch 自己抛异常（断网/DNS/CORS）进 catch：先判断是不是 abort——是就体面地 yield `done: aborted`，不是才 yield error。',
          '`response.ok` 为假（401 密钥错、429 限流、500…）时读出响应体文本包进 Error。两种错误最终都变成 `error` 事件 → agent 篇第 6 关把它转成文本进 context。层层转译，错误信息不丢。',
        ],
        watch: '设置里点「测试连接」可最快看到错误路径（故意填个错 key）',
      },
      {
        id: 'l4',
        title: '读 SSE 流：chunk 边界 ≠ 行边界',
        lines: [152, 181],
        anchor: 'getReader()',
        teach: [
          '`getReader()` + `TextDecoder` 逐块读字节流。关键在缓冲区 `buf`：网络 chunk 可能半行就到（甚至半个字），所以必须攒到看见 `\\n` 才切出一行——按行处理前先按块累积，是流式解析的第一课。',
          '每行剥掉 `data: ` 前缀才是 JSON；`[DONE]` 是哨兵直接跳过。解析出的 textDelta 立刻 yield——agent 篇第 4 关的打字机，燃料从这里出。',
        ],
        watch: '运行任务时观察地图：llm→agent 蓝色小包的频率就是 text_delta 到达的频率',
      },
      {
        id: 'l5',
        title: 'handleSSELine：delta 分派与 partial JSON 累积',
        lines: [59, 94],
        anchor: 'argsBuf +=',
        teach: [
          '每个 data 帧是一个 choice 增量：`delta.content` 有字就转成 textDelta；`delta.tool_calls` 则按 `index` 找到（或新建）缓冲条目，把 `function.arguments` 的**字符串片段**往上拼——此刻它还不是合法 JSON，只是一串碎玻璃。',
          'finish_reason 的翻译表也在这里：API 说 `tool_calls` 我们记 `tool_use`，说 `length` 记 `max_tokens`，说 `stop` 保持默认 `end_turn`。统一词汇后，agent 侧不用关心背后是哪家 API。',
        ],
      },
      {
        id: 'l6',
        title: 'flushToolCalls：流结束才拼图，然后说 done',
        lines: [183, 188],
        anchor: 'flushToolCalls',
        teach: [
          '高亮这段调用的 `flushToolCalls` 在 94-105 行：流结束（reader done 或 [DONE] 之后）才把每个缓冲条目的 argsBuf `JSON.parse` 成完整对象——碎片拼完了再装框。parse 失败兜底空对象，不让一个坏调用打断整轮。',
          '然后按 index 排序逐个 yield tool_call，最后一个 `done` 事件附上 stopReason。**这就是 agent 篇第 5 关说的"tool_call 写在循环里、实际在流末尾才到"的出处。**',
        ],
        runTo: { bp: 'tool_call' },
      },
    ],
  },
  {
    id: 'tools',
    title: 'tools 工具箱',
    file: 'tools.js',
    subtitle: 'tools.js · 4 个工具——模型只看说明书，execute 永远留在本地',
    steps: [
      {
        id: 't1',
        title: '四件套：说明书发给模型，execute 留在本地',
        lines: [28, 61],
        anchor: "name: 'read_file'",
        teach: [
          '`read_file` 展示了一个工具的标准长相：`name` 是模型点单时喊的名字，`description` 是模型唯一的判断依据，`parameters` 是 JSON Schema（有哪些参数、什么类型、哪个必填）。这三个字段随每轮请求发给模型（llm 篇第 2 关 body 里的 tools 清单），`execute` 函数永远留在你的浏览器里——模型看不到工具代码，只看说明书。',
          '`write_file` 多一个 `content` 参数，返回一句回执 `wrote math.js (312 chars)`。回执是写给模型看的：短而准——模型不需要全文复述，只需要知道"写成功了、多长"。工具的返回值永远是一段文字，因为模型的输入只能是文字。',
        ],
        runTo: { bp: 'tool_call' },
      },
      {
        id: 't2',
        title: 'truncateOutput：出口上的保险丝，尾部优先',
        lines: [13, 26],
        anchor: 'slice(-maxLines)',
        teach: [
          '工具的输出会**全文进 context**（下一轮全量发给模型），而 context 按 token 计费且有限。读到一个一万行的文件若原样塞回去，对话很快被垃圾撑爆——所以出口上装一根保险丝，超过 200 行就截断。',
          '截的是尾部（`slice(-maxLines)`）：错误信息、测试失败的原因几乎总在输出的末尾，保尾部就是保线索。沙盒文件都很小，正常跑不到这——"看不到它工作"恰是它工作正常的证明。',
        ],
        runTo: { bp: 'tool_result' },
      },
      {
        id: 't3',
        title: 'edit：唯一匹配才动手，报错写给模型看',
        lines: [63, 88],
        anchor: 'old_string matches',
        teach: [
          '为什么不都用 write_file 全量重写？贵且险——重写整个文件耗 token，模型还可能顺手"改丢"没让它动的部分。`edit` 只送三段文本：路径、旧文本（`old_string`）、新文本（`new_string`），又省又准。',
          '核心纪律是唯一匹配：`old_string` 在文件里必须恰好出现一次，找不到或多处命中都抛错拒绝执行——匹配到多处时替换哪个全看运气，AI 改错地方比不改更糟。注意报错文案 `must be unique` 是写给**模型**看的：它会作为 tool_result 进 context，模型读到后通常换一段更长的 old_string 重试。工具的报错，就是 AI 的纠错教材。',
          '最后一行的函数替换也有讲究：`replace(old, newString)` 里 `$&`、`$\`` 会被当特殊符号解释，换成 `() => new_string` 就原样返回。新文本里恰好有 `$` 时（价格、正则），这层保护就生效。',
        ],
        runTo: { bp: 'tool_result' },
      },
      {
        id: 't4',
        title: 'run_js：执行验证是 coding agent 的灵魂',
        lines: [90, 106],
        anchor: 'signal.aborted',
        teach: [
          '修 bug 的完整闭环是"改了 → 跑测试 → 看结果 → 再改"。没有 run_js，agent 只能盲改，改没改对全靠猜——这十几行是四个工具里地位最高的。浏览器没有 shell（原版是 run_bash），改为在沙盒里真执行 JS 并捕获全部 console 输出。',
          '开头的 `signal.aborted` 检查是和"停止"按钮的连线：比赛结束的哨声吹响后，不再开新的回合。挂 tool_result 断点跑演示任务，最后扣住的那次多半就是它——test.js 的通过/失败输出，就是从这里发出的。',
        ],
        runTo: { bp: 'tool_result' },
      },
      {
        id: 't5',
        title: 'builtinTools：能力清单的插件化',
        lines: [108, 112],
        anchor: 'builtinTools',
        teach: [
          '四个工具装进一个数组交给外界（cli 区块 1 的 `builtinTools()` 调用），随后 agent 把它劈成两半：说明书给模型（toolDefs），真工具留本地（toolMap）——见 agent 篇第 1 关的两行初始化。',
          '想给 agent 加新能力：写一个同结构的对象加进这个数组，agent.js 和 llm.js 一行都不用改。这就是能力插件化——工具的增删不触碰循环本身。',
        ],
        watch: 'Context tab 开「wire」开关：请求 JSON 的 tools 数组里就是这四个工具的说明书（不含 execute）',
      },
    ],
  },
]
