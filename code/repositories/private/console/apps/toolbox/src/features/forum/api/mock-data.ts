import type { Category, Post, Topic, User } from "@/features/forum/schemas/forum";

/** 相对当前时间生成 ISO 时间戳，让论坛看起来始终“活跃” */
function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60_000).toISOString();
}
function hoursAgo(h: number): string {
  return minutesAgo(h * 60);
}
function daysAgo(d: number): string {
  return hoursAgo(d * 24);
}

export const users: User[] = [
  { id: "u1", username: "ggbdpq", nickname: "ggbdpq", title: "站长 · 逆向爱好者", trustLevel: 4, postCount: 1024, joinedAt: daysAgo(720), isAdmin: true, color: "#2563eb" },
  { id: "u2", username: "pwn_college", nickname: "Pwn 小学生", title: "二进制菜鸡", trustLevel: 3, postCount: 342, joinedAt: daysAgo(500), isAdmin: false, color: "#dc2626" },
  { id: "u3", username: "ida_pro_fan", nickname: "IDA 重度用户", title: "", trustLevel: 2, postCount: 187, joinedAt: daysAgo(430), isAdmin: false, color: "#059669" },
  { id: "u4", username: "frida_hooker", nickname: "Frida 一钩子入魂", title: "移动端安全", trustLevel: 3, postCount: 256, joinedAt: daysAgo(380), isAdmin: false, color: "#7c3aed" },
  { id: "u5", username: "kernel_404", nickname: "内核不存在", title: "", trustLevel: 2, postCount: 98, joinedAt: daysAgo(300), isAdmin: false, color: "#ea580c" },
  { id: "u6", username: "wasm_witch", nickname: "Wasm 女巫", title: "前端 / 运行时", trustLevel: 2, postCount: 143, joinedAt: daysAgo(260), isAdmin: false, color: "#0891b2" },
  { id: "u7", username: "crawler_mole", nickname: "爬虫鼹鼠", title: "", trustLevel: 1, postCount: 56, joinedAt: daysAgo(180), isAdmin: false, color: "#65a30d" },
  { id: "u8", username: "rust_ace", nickname: "Rust ACE", title: "内存安全布道师", trustLevel: 3, postCount: 210, joinedAt: daysAgo(350), isAdmin: false, color: "#b45309" },
  { id: "u9", username: "debug_cat", nickname: "调试猫", title: "", trustLevel: 1, postCount: 33, joinedAt: daysAgo(90), isAdmin: false, color: "#db2777" },
  { id: "u10", username: "llm_tuner", nickname: "大模型调参侠", title: "AI 工程化", trustLevel: 2, postCount: 120, joinedAt: daysAgo(150), isAdmin: false, color: "#4f46e5" },
];

export const categories: Category[] = [
  { id: "c1", slug: "reverse-engineering", name: "逆向工程", description: "IDA、Ghidra、反编译、协议分析，一切逆向相关", color: "#2563eb", topicCount: 8, postCount: 96 },
  { id: "c2", slug: "binary-security", name: "二进制安全", description: "Pwn、漏洞挖掘、利用开发、CTF 赛题讨论", color: "#dc2626", topicCount: 5, postCount: 64 },
  { id: "c3", slug: "mobile-security", name: "移动安全", description: "Android/iOS 逆向、Frida、抓包与加固脱壳", color: "#7c3aed", topicCount: 4, postCount: 41 },
  { id: "c4", slug: "web-dev", name: "Web 开发", description: "前端框架、后端架构、全栈踩坑与最佳实践", color: "#059669", topicCount: 5, postCount: 58 },
  { id: "c5", slug: "ai-llm", name: "AI 与大模型", description: "LLM 应用、Prompt 工程、本地部署与微调", color: "#4f46e5", topicCount: 4, postCount: 37 },
  { id: "c6", slug: "devops", name: "运维与工具", description: "Docker、CI/CD、效率工具、装机与折腾", color: "#ea580c", topicCount: 3, postCount: 25 },
  { id: "c7", slug: "career", name: "职场与成长", description: "求职面试、职业规划、学习方法论", color: "#0891b2", topicCount: 3, postCount: 29 },
  { id: "c8", slug: "water-cooler", name: "灌水茶馆", description: "技术之外的闲聊，晒桌面、晒键盘、晒猫", color: "#65a30d", topicCount: 3, postCount: 43 },
];

export const topics: Topic[] = [
  {
    id: "t1", title: "【精华】逆向工程入门路线图 2026 版：从汇编到实战 CrackMe", categoryId: "c1",
    tags: ["入门", "教程", "精华"], authorId: "u1",
    participantIds: ["u1", "u2", "u3", "u5", "u9"],
    replyCount: 46, viewCount: 5203, likeCount: 328, pinned: true, closed: false,
    createdAt: daysAgo(30), lastActivityAt: minutesAgo(12),
    excerpt: "整理了自己三年逆向学习的完整路径：x86/x64 汇编 → PE 结构 → IDA 静态分析 → 动态调试 → 实战 CrackMe 100 题……",
  },
  {
    id: "t2", title: "某 App 的签名校验绕过实录：从 jadx 到 Frida 一把梭", categoryId: "c3",
    tags: ["Frida", "Android", "实战"], authorId: "u4",
    participantIds: ["u4", "u1", "u7"],
    replyCount: 23, viewCount: 1892, likeCount: 96, pinned: false, closed: false,
    createdAt: daysAgo(3), lastActivityAt: minutesAgo(34),
    excerpt: "目标 App 做了三层签名校验，本文记录完整的分析过程，hook 点选择和踩坑记录……",
  },
  {
    id: "t3", title: "Ghidra 11 自定义 Processor 开发：分析一个冷门 MCU 固件", categoryId: "c1",
    tags: ["Ghidra", "固件", "Sleigh"], authorId: "u3",
    participantIds: ["u3", "u5", "u1"],
    replyCount: 15, viewCount: 987, likeCount: 74, pinned: false, closed: false,
    createdAt: daysAgo(5), lastActivityAt: hoursAgo(1),
    excerpt: "拿到一个 8051 变种的固件，官方没有现成插件，只能自己写 Sleigh 描述文件……",
  },
  {
    id: "t4", title: "堆利用笔记：House of Water 在 glibc 2.42 上的复现", categoryId: "c2",
    tags: ["Pwn", "glibc", "堆利用"], authorId: "u2",
    participantIds: ["u2", "u5", "u1", "u9"],
    replyCount: 31, viewCount: 2145, likeCount: 187, pinned: true, closed: false,
    createdAt: daysAgo(12), lastActivityAt: hoursAgo(2),
    excerpt: "新版 glibc 的 tcache 防护又加强了，记录一下新版利用手法的完整复现过程，附 exp……",
  },
  {
    id: "t5", title: "React 19 的 Compiler 到底要不要开？生产环境实测数据", categoryId: "c4",
    tags: ["React", "性能优化"], authorId: "u6",
    participantIds: ["u6", "u8", "u1"],
    replyCount: 28, viewCount: 1673, likeCount: 89, pinned: false, closed: false,
    createdAt: daysAgo(2), lastActivityAt: hoursAgo(3),
    excerpt: "在三个真实项目上开了 React Compiler，bundle 体积、渲染耗时、内存占用全量对比……",
  },
  {
    id: "t6", title: "用 Rust 写了一个 PE 解析器，比 Python 快 200 倍", categoryId: "c1",
    tags: ["Rust", "PE", "工具"], authorId: "u8",
    participantIds: ["u8", "u1", "u2"],
    replyCount: 19, viewCount: 1234, likeCount: 102, pinned: false, closed: false,
    createdAt: daysAgo(6), lastActivityAt: hoursAgo(5),
    excerpt: "周末项目：从零实现 PE 结构解析，支持导入表/导出表/重定位，已开源到 GitHub……",
  },
  {
    id: "t7", title: "本地部署 70B 模型的最低配置实测：4 张 4090 够不够？", categoryId: "c5",
    tags: ["LLM", "部署", "硬件"], authorId: "u10",
    participantIds: ["u10", "u6", "u1", "u7"],
    replyCount: 35, viewCount: 2876, likeCount: 156, pinned: false, closed: false,
    createdAt: daysAgo(4), lastActivityAt: hoursAgo(6),
    excerpt: "量化到 Q4 之后显存需求、吞吐、延迟的完整测试报告，附 vLLM 和 llama.cpp 对比……",
  },
  {
    id: "t8", title: "CTF 选手转型安全研究员：我这一年的心路历程", categoryId: "c7",
    tags: ["职业", "随笔"], authorId: "u2",
    participantIds: ["u2", "u9", "u1"],
    replyCount: 42, viewCount: 3102, likeCount: 245, pinned: false, closed: false,
    createdAt: daysAgo(8), lastActivityAt: hoursAgo(8),
    excerpt: "从打比赛到挖真实漏洞，思维方式需要哪些转变？聊聊这一年的迷茫与收获……",
  },
  {
    id: "t9", title: "iOS 逆向环境搭建 2026：Dopamine 越狱 + 全套工具链", categoryId: "c3",
    tags: ["iOS", "越狱", "教程"], authorId: "u4",
    participantIds: ["u4", "u9"],
    replyCount: 17, viewCount: 1456, likeCount: 78, pinned: false, closed: false,
    createdAt: daysAgo(9), lastActivityAt: hoursAgo(10),
    excerpt: "A12+ 设备的完整越狱与调试环境配置，包括 SSH、Frida、class-dump 一条龙……",
  },
  {
    id: "t10", title: "Vite 8 升级踩坑记：Rolldown 模式下的插件兼容性", categoryId: "c4",
    tags: ["Vite", "前端工程化"], authorId: "u6",
    participantIds: ["u6", "u8"],
    replyCount: 12, viewCount: 876, likeCount: 45, pinned: false, closed: false,
    createdAt: daysAgo(1), lastActivityAt: hoursAgo(12),
    excerpt: "升级后三个自研插件全挂了，记录 Rolldown 与 Rollup 钩子行为差异……",
  },
  {
    id: "t11", title: "自制机械键盘：从画 PCB 到 QMK 固件烧录全流程", categoryId: "c8",
    tags: ["硬件", "键盘", "晒物"], authorId: "u9",
    participantIds: ["u9", "u7", "u1", "u5"],
    replyCount: 38, viewCount: 2231, likeCount: 198, pinned: false, closed: false,
    createdAt: daysAgo(15), lastActivityAt: hoursAgo(16),
    excerpt: "历时两个月，终于做出了自己的第一把 40% 配列键盘，附全部开源资料……",
  },
  {
    id: "t12", title: "Windows 内核回调入门：用 ObRegisterCallbacks 保护进程", categoryId: "c2",
    tags: ["Windows", "内核", "驱动"], authorId: "u5",
    participantIds: ["u5", "u2", "u1"],
    replyCount: 21, viewCount: 1567, likeCount: 134, pinned: false, closed: false,
    createdAt: daysAgo(11), lastActivityAt: hoursAgo(20),
    excerpt: "写一个最小可用的内核驱动，实现对指定进程的句柄访问拦截……",
  },
  {
    id: "t13", title: "Prompt 工程的尽头是 Code：Agent 工作流的结构化实践", categoryId: "c5",
    tags: ["Agent", "Prompt"], authorId: "u10",
    participantIds: ["u10", "u1"],
    replyCount: 9, viewCount: 654, likeCount: 38, pinned: false, closed: false,
    createdAt: hoursAgo(30), lastActivityAt: daysAgo(1),
    excerpt: "把复杂 Prompt 拆成可组合的代码模块后，Agent 的稳定性提升了 3 倍……",
  },
  {
    id: "t14", title: "Docker 镜像瘦身实战：从 1.2GB 到 87MB 的七个技巧", categoryId: "c6",
    tags: ["Docker", "优化"], authorId: "u7",
    participantIds: ["u7", "u6"],
    replyCount: 14, viewCount: 923, likeCount: 67, pinned: false, closed: false,
    createdAt: daysAgo(2), lastActivityAt: daysAgo(1),
    excerpt: "多阶段构建只是开始，还有 distroless、静态链接、layer 合并等组合拳……",
  },
  {
    id: "t15", title: "TLS 指纹对抗：curl-impersonate 的原理与二次开发", categoryId: "c1",
    tags: ["协议", "爬虫", "TLS"], authorId: "u7",
    participantIds: ["u7", "u4", "u1"],
    replyCount: 18, viewCount: 1345, likeCount: 91, pinned: false, closed: false,
    createdAt: daysAgo(7), lastActivityAt: daysAgo(1),
    excerpt: "JA3/JA4 指纹是怎么被识别的？如何通过修改 BoringSSL 编译参数模拟真实浏览器……",
  },
  {
    id: "t16", title: "Zustand vs Jotai vs Redux Toolkit：2026 年状态管理怎么选", categoryId: "c4",
    tags: ["前端", "状态管理"], authorId: "u8",
    participantIds: ["u8", "u6", "u1"],
    replyCount: 26, viewCount: 1789, likeCount: 112, pinned: false, closed: false,
    createdAt: daysAgo(5), lastActivityAt: daysAgo(2),
    excerpt: "三个库在五个真实项目中的使用体验对比，附选型决策树……",
  },
  {
    id: "t17", title: "面试被问「手写一个 Binder 通信 demo」，我是怎么挂的", categoryId: "c7",
    tags: ["面试", "Android"], authorId: "u9",
    participantIds: ["u9", "u4"],
    replyCount: 33, viewCount: 2567, likeCount: 143, pinned: false, closed: false,
    createdAt: daysAgo(10), lastActivityAt: daysAgo(2),
    excerpt: "复盘一场社招面试：从 AIDL 到驱动层，面试官到底想考察什么……",
  },
  {
    id: "t18", title: "符号执行入门：用 angr 自动求解 CrackMe", categoryId: "c2",
    tags: ["angr", "符号执行", "教程"], authorId: "u2",
    participantIds: ["u2", "u3", "u1"],
    replyCount: 24, viewCount: 1678, likeCount: 129, pinned: false, closed: false,
    createdAt: daysAgo(14), lastActivityAt: daysAgo(3),
    excerpt: "不动手调试，让符号执行引擎自己算出 flag！angr 的 find/avoid 策略详解……",
  },
  {
    id: "t19", title: "晒一下我的 Homelab：4 台二手服务器 + 全屋 2.5G 组网", categoryId: "c8",
    tags: ["Homelab", "晒物", "网络"], authorId: "u5",
    participantIds: ["u5", "u7", "u9", "u1"],
    replyCount: 52, viewCount: 3892, likeCount: 267, pinned: false, closed: false,
    createdAt: daysAgo(20), lastActivityAt: daysAgo(3),
    excerpt: "总价不到八千的家庭数据中心方案，跑 Proxmox 虚拟化 + 20 个服务……",
  },
  {
    id: "t20", title: "WASM 逆向初探：把 .wasm 反编译回可读伪代码", categoryId: "c1",
    tags: ["WASM", "前端安全"], authorId: "u6",
    participantIds: ["u6", "u1"],
    replyCount: 11, viewCount: 743, likeCount: 52, pinned: false, closed: false,
    createdAt: daysAgo(4), lastActivityAt: daysAgo(4),
    excerpt: "遇到 WASM 混淆的加密逻辑怎么办？wabt + ghidra-wasm-plugin 组合拳……",
  },
  {
    id: "t21", title: "【公告】论坛使用指南与版块规则（发帖前必读）", categoryId: "c8",
    tags: ["公告", "置顶"], authorId: "u1",
    participantIds: ["u1"],
    replyCount: 8, viewCount: 4521, likeCount: 89, pinned: true, closed: false,
    createdAt: daysAgo(60), lastActivityAt: daysAgo(5),
    excerpt: "欢迎来到这里！为了保证讨论质量，请花三分钟读完本指南……",
  },
  {
    id: "t22", title: "Claude/GPT/Gemini 写逆向分析脚本哪家强？实测 50 个样本", categoryId: "c5",
    tags: ["LLM", "逆向", "评测"], authorId: "u1",
    participantIds: ["u1", "u10", "u2"],
    replyCount: 29, viewCount: 1987, likeCount: 134, pinned: false, closed: false,
    createdAt: daysAgo(6), lastActivityAt: daysAgo(5),
    excerpt: "让三家大模型各写 50 个 IDAPython 脚本，成功率、代码质量全面对比……",
  },
  {
    id: "t23", title: "从零写一个 x64 调试器（一）：断点与单步的实现原理", categoryId: "c2",
    tags: ["调试器", "Windows", "系列教程"], authorId: "u5",
    participantIds: ["u5", "u2", "u3"],
    replyCount: 36, viewCount: 2456, likeCount: 203, pinned: false, closed: false,
    createdAt: daysAgo(18), lastActivityAt: daysAgo(6),
    excerpt: "INT3 断点、硬件断点、内存断点分别怎么实现？系列教程第一篇……",
  },
  {
    id: "t24", title: "我的 2025 年度技术总结：从全栈转安全的一年", categoryId: "c7",
    tags: ["年度总结", "随笔"], authorId: "u3",
    participantIds: ["u3", "u1", "u9"],
    replyCount: 47, viewCount: 3345, likeCount: 289, pinned: false, closed: true,
    createdAt: daysAgo(45), lastActivityAt: daysAgo(7),
    excerpt: "写了六年代码后转型安全研究，聊聊这一年的得与失，以及给想转型朋友的建议……",
  },
  {
    id: "t25", title: "eBPF 抓包新姿势：不装客户端也能做全链路追踪", categoryId: "c6",
    tags: ["eBPF", "Linux", "可观测性"], authorId: "u5",
    participantIds: ["u5", "u7"],
    replyCount: 13, viewCount: 1089, likeCount: 76, pinned: false, closed: false,
    createdAt: daysAgo(8), lastActivityAt: daysAgo(8),
    excerpt: "用 eBPF uprobe 挂钩 SSL_read/SSL_write，零侵入抓取 HTTPS 明文……",
  },
];

export const posts: Post[] = [
  // t1: 逆向入门路线图
  { id: "p1-1", topicId: "t1", authorId: "u1", floor: 1, likeCount: 328, createdAt: daysAgo(30), content: "整理了自己三年逆向学习的完整路径，希望能帮到想入门的朋友。\n\n**第一阶段：打基础（1-2 个月）**\n- x86/x64 汇编：推荐《汇编语言》王爽 + Modern x64 Assembly\n- C 语言指针与内存布局必须过关\n- PE 文件结构：用 010 Editor 模板逐个字段看\n\n**第二阶段：工具（1 个月）**\n- IDA Pro 静态分析：F5 反编译、重命名、结构体还原\n- x64dbg 动态调试：断点、硬件断点、内存访问断点\n\n**第三阶段：实战（长期）**\n- CrackMe 100 题，从 Level 1 开始刷\n- 每道题写 writeup，输出倒逼输入\n\n楼下补充资源链接，欢迎交流。" },
  { id: "p1-2", topicId: "t1", authorId: "u2", floor: 2, likeCount: 45, createdAt: daysAgo(29), content: "补充一个：pwn.college 的逆向章节也很棒，免费而且环境都是现成的，不用自己搭。" },
  { id: "p1-3", topicId: "t1", authorId: "u9", floor: 3, likeCount: 12, createdAt: daysAgo(28), content: "请问汇编零基础直接看王爽那本够吗？需要先学 C 吗？" },
  { id: "p1-4", topicId: "t1", authorId: "u1", floor: 4, likeCount: 38, createdAt: daysAgo(28), content: "@调试猫 建议先学 C，至少要把指针和结构体搞明白。否则看到反汇编里的 `[rbp-8]` 这种寻址会一脸懵。" },
  { id: "p1-5", topicId: "t1", authorId: "u5", floor: 5, likeCount: 27, createdAt: daysAgo(27), content: "补充 Windows 平台：《加密与解密》第四版依然是最好的中文参考书，虽然老但原理不过时。" },
  // t2: 签名校验绕过
  { id: "p2-1", topicId: "t2", authorId: "u4", floor: 1, likeCount: 96, createdAt: daysAgo(3), content: "目标 App 做了三层签名校验：Java 层、Native 层、还有一个藏在 so 里的 CRC 自校验。\n\n**Java 层**：jadx 直接搜 `getPackageInfo`，hook `PackageManager` 返回伪造签名即可。\n\n**Native 层**：JNI 里调用了 `dlopen` + `dlsym` 动态获取校验函数，静态看不出来。用 Frida 的 `Interceptor.attach` 挂 `dlsym`，等它解析到校验函数地址后再替换返回值。\n\n**CRC 自校验**：最恶心的一层，so 加载时校验自身代码段。直接 patch 掉校验分支，注意要先过前两层，否则它会延迟触发崩溃。\n\n完整脚本已贴到 GitHub Gist，楼下放链接。" },
  { id: "p2-2", topicId: "t2", authorId: "u1", floor: 2, likeCount: 23, createdAt: daysAgo(3), content: "CRC 那层其实还有个更优雅的方案：把校验函数 hook 成永远返回 true，不用改 so 文件，升级也不怕 patch 失效。" },
  { id: "p2-3", topicId: "t2", authorId: "u7", floor: 3, likeCount: 15, createdAt: daysAgo(2), content: "mark，正好在分析同一个 App，它的协议加密也好烦，等大佬更新。" },
  // t4: 堆利用
  { id: "p4-1", topicId: "t4", authorId: "u2", floor: 1, likeCount: 187, createdAt: daysAgo(12), content: "glibc 2.42 对 tcache 的防护又加强了，老的 double free 手法全部失效。\n\n新版关键点：\n1. tcache entry 的 `next` 指针加密从单点异或变成了链式加密\n2. `e->key` 检查升级为双 key 交叉验证\n3. 但是！fastbin 的校验逻辑没变，可以借 fastbin 过渡\n\n完整利用思路：先通过 UAF 泄漏 heap base 和 libc，然后用 fastbin dup 构造重叠 chunk，最后劫持 tcache_perthread_struct……\n\nexp 在附件，glibc 2.42-0ubuntu1 实测通过。" },
  { id: "p4-2", topicId: "t4", authorId: "u5", floor: 2, likeCount: 34, createdAt: daysAgo(11), content: "链式加密这个改动确实狠，本质是 safe-linking 的加强版。补充一个泄漏思路：利用加密链的已知明文反推 key。" },
  { id: "p4-3", topicId: "t4", authorId: "u1", floor: 3, likeCount: 28, createdAt: daysAgo(10), content: "置顶了。这种质量的技术贴值得更多人看到。建议楼主把 glibc commit 链接也贴上。" },
  { id: "p4-4", topicId: "t4", authorId: "u2", floor: 4, likeCount: 19, createdAt: daysAgo(10), content: "@ggbdpq 已补充，commit 是 `a1b2c3d`，另外附了调试用的 pwndbg 配置。" },
  // t5: React Compiler
  { id: "p5-1", topicId: "t5", authorId: "u6", floor: 1, likeCount: 89, createdAt: daysAgo(2), content: "在三个真实项目（中后台、C 端 H5、数据可视化）上开了 React Compiler，跑了一周的数据：\n\n| 指标 | 中后台 | H5 | 可视化 |\n|---|---|---|---|\n| 重渲染次数 | -62% | -41% | -73% |\n| 首屏耗时 | -8% | -3% | -15% |\n| bundle 增量 | +18KB | +18KB | +18KB |\n\n**结论**：重交互项目收益巨大，静态内容多的项目感知不强。\n\n**坑**：有两个三方库的 ref 转发写法不兼容，需要加 `\"use no memo\"` 豁免。" },
  { id: "p5-2", topicId: "t5", authorId: "u8", floor: 2, likeCount: 21, createdAt: daysAgo(2), content: "我们项目也开了，补充一个坑：和 zustand 的 `useShallow` 配合时有个边缘 case 会少渲染，官方 issue #1234 还在跟。" },
  { id: "p5-3", topicId: "t5", authorId: "u1", floor: 3, likeCount: 9, createdAt: daysAgo(1), content: "数据很扎实，感谢分享。这个论坛前端我就打算开 Compiler 试试。" },
  // t21: 论坛公告
  { id: "p21-1", topicId: "t21", authorId: "u1", floor: 1, likeCount: 89, createdAt: daysAgo(60), content: "欢迎来到 ggbdpq 论坛！这里是一个以**逆向工程和安全研究**为主，兼顾前后端开发与 AI 的小众技术社区。\n\n**发帖规范**：\n1. 技术帖请发在对应版块，标题写清楚主题\n2. 转载内容必须注明出处\n3. 禁止讨论针对未授权目标的攻击手法\n4. 灌水请去「灌水茶馆」\n\n**等级体系**：回帖、获赞都能提升信任等级，Lv3 以上可以创建 wiki 帖。\n\n希望大家玩得开心，有问题随时 @ 我。" },
  { id: "p21-2", topicId: "t21", authorId: "u9", floor: 2, likeCount: 11, createdAt: daysAgo(55), content: "新人报道！冲着逆向路线图那篇帖子来的，希望能坚持下来。" },
  { id: "p21-3", topicId: "t21", authorId: "u1", floor: 3, likeCount: 6, createdAt: daysAgo(55), content: "@调试猫 欢迎！坚持写 writeup 是进步最快的方式。" },
];

export const siteStats = {
  topicCount: topics.length,
  postCount: posts.length + topics.reduce((s, t) => s + t.replyCount, 0),
  userCount: 268,
  onlineCount: 42,
};
