# AI 辅助逆向工程 Skills 指南

**编写日期**: 2026-02-28
**更新日期**: 2026-07-06
**来源**: 从 [Chrome扩展逆向工程指南](Chrome扩展逆向工程指南.md) 拆分出的 Skills 参考
**上游项目**: [ReVa (Reverse Engineering Assistant)](https://github.com/cyberkaida/reverse-engineering-assistant)

---

> 本章节介绍四个专业的逆向工程 AI Skills，它们来源于 **ReVa (Reverse Engineering Assistant)** 项目，可以帮助你在面对复杂二进制文件、CTF 挑战或深度分析任务时获得 AI 辅助。

## 目录

1. [Skills 概览](#skills-概览)
2. [binary-triage — 二进制初步筛选](#1-binary-triage---二进制初步筛选)
3. [ctf-rev — CTF 逆向工程挑战](#2-ctf-rev---ctf-逆向工程挑战)
4. [ctf-pwn — CTF 二进制利用](#3-ctf-pwn---ctf-二进制利用)
5. [deep-analysis — 深度定向分析](#4-deep-analysis---深度定向分析)
6. [Skills 应用决策树](#skills-应用决策树)
7. [Skills 在 WebInk 分析中的虚拟应用](#skills-在-webink-分析中的虚拟应用)
8. [进阶学习路径](#进阶学习路径)
9. [总结](#总结)

---

## Skills 概览

| Skill 名称 | 主要用途 | 复杂度 | 典型场景 |
|------------|----------|--------|----------|
| **binary-triage** | 二进制初步分析 | ⭐⭐ | 快速了解未知二进制文件的功能 |
| **ctf-rev** | CTF 逆向挑战 | ⭐⭐⭐ | Crackme、算法恢复、隐藏逻辑分析 |
| **ctf-pwn** | CTF 漏洞利用 | ⭐⭐⭐⭐ | 缓冲区溢出、ROP、堆利用 |
| **deep-analysis** | 深度定向分析 | ⭐⭐⭐⭐⭐ | 长期分析、类型修复、函数重命名 |

---

### 1. binary-triage - 二进制初步筛选

#### 来源与安装

**GitHub 仓库**: [cyberkaida/reverse-engineering-assistant](https://github.com/cyberkaida/reverse-engineering-assistant)

**安装方式**:
```bash
# 通过 Claude Code Marketplace 安装
claude plugin marketplace add cyberkaida/reverse-engineering-assistant

# 或手动安装 ReVa Ghidra 扩展
export GHIDRA_INSTALL_DIR=/path/to/ghidra
gradle install
```

#### 功能描述

`binary-triage` 执行**初始二进制筛选**，通过调查内存布局、字符串、导入/导出和函数来快速了解二进制文件的功能。

它的工作方式类似于人类逆向工程师的"第一眼扫描"：
- 扫描字符串以获取功能提示
- 检查导入/导出函数以了解外部依赖
- 分析内存布局以识别关键段
- 快速识别可疑行为

#### 与 Chrome 扩展逆向的关联

虽然 binary-triage 主要设计用于 ELF/PE 二进制文件，但其**方法论**同样适用于 Chrome 扩展：

| 二进制分析概念 | Chrome 扩展对应 |
|---------------|---------------|
| 字符串扫描 | 搜索 `manifest.json` 关键词、API 调用 |
| 导入函数分析 | 检查 Chrome API 使用 (`chrome.*`) |
| 内存布局 | 目录结构分析 (`background/`, `content/`) |
| 段权限检查 | 权限声明 (`permissions`, `host_permissions`) |

**示例 - 应用到 WebInk 分析**:

```javascript
// 类似 binary-triage 的字符串扫描方法
const keywords = {
  '数据外传': ['fetch(', 'XMLHttpRequest', 'websocket', 'send('],
  '存储操作': ['chrome.storage', 'localStorage', 'IndexedDB'],
  '剪贴板': ['navigator.clipboard', 'document.execCommand'],
  '提取功能': ['Readability', 'turndown', 'innerHTML'],
};

// 在提取的代码中扫描关键词频率
for (const [category, patterns] of Object.entries(keywords)) {
  const count = codeContent.filter((line) =>
    patterns.some((p) => line.includes(p))
  ).length;
  console.log(`${category}: ${count} 次`);
}
```

#### 典型使用场景

1. **快速威胁评估**: 判断下载的二进制是否可疑
2. **功能分类**: 自动归类二进制文件类型（恶意软件、正常软件、工具）
3. **优先级排序**: 决定哪些样本值得深度分析

---

### 2. ctf-rev - CTF 逆向工程挑战

#### 来源与安装

**GitHub 仓库**: [cyberkaida/reverse-engineering-assistant](https://github.com/cyberkaida/reverse-engineering-assistant)

**安装方式**: 同 binary-triage

#### 功能描述

`ctf-rev` 专注于**解决 CTF 逆向工程挑战**，使用系统化分析来发现标志（flags）、密钥或密码。

它擅长处理：
- **Crackme**: 简单的密码验证程序
- **算法恢复**: 从混淆代码中还原原始算法
- **隐藏逻辑**: 发现反调试、加壳、虚拟机保护
- **密钥提取**: 找到硬编码的密钥或动态生成的密钥

#### 与 Chrome 扩展逆向的关联

CTF 逆向技术与 Chrome 扩展分析的**核心思维**是相同的：

| CTF 技巧 | Chrome 扩展应用 |
|----------|---------------|
| 控制流分析 | 理解消息传递流程 |
| 数据流追踪 | 追踪用户输入如何被处理 |
| 字符串提取 | 查找错误消息、API 端点 |
| 逻辑重构 | 还原原始 TypeScript 代码 |

**示例 - WebInk 中的"Crackme"时刻**:

```javascript
// 发现 "隐藏" 的配置验证逻辑
// 类似 CTF 中的密码检查
function validateConfig(config) {
  // 混淆后的版本检查
  const v = config.version || '';
  if (v !== '0.4.2' && !v.startsWith('0.4.')) {
    console.warn('Version mismatch detected');
    // 隐藏的功能降级
  }
}

// 使用 ctf-rev 思维：找到所有版本检查点
const versionChecks = code.match(/version.*?['"](\d+\.\d+\.\d+)['"]/g);
```

#### 典型使用场景

1. **Flag 提取**: 从 CTF 二进制中提取隐藏的 flag
2. **算法逆向**: 还原加密、哈希或自定义编码算法
3. **保护绕过**: 识别并绕过反调试、完整性检查

---

### 3. ctf-pwn - CTF 二进制利用

#### 来源与安装

**GitHub 仓库**: [cyberkaida/reverse-engineering-assistant](https://github.com/cyberkaida/reverse-engineering-assistant)

**安装方式**: 同 binary-triage

#### 功能描述

`ctf-pwn` 专注于**二进制利用漏洞**，通过发现和利用内存破坏漏洞来读取 flags。

它擅长处理：
- **缓冲区溢出**: 栈溢出、堆溢出
- **ROP (Return-Oriented Programming)**: 构建利用链
- **格式化字符串**: 泄露内存、任意写入
- **堆利用**: UAF、tcache、fastbin 攻击

#### 与 Chrome 扩展逆向的关联

虽然 Chrome 扩展主要使用 JavaScript（没有传统内存安全问题），但**漏洞思维**依然适用：

| 二进制漏洞 | Chrome 扩展对应问题 |
|-----------|------------------|
| 缓冲区溢出 | JSON 解析崩溃、正则 DoS |
| 权限提升 | 过度声明 `permissions` |
| 信息泄露 | 意外暴露用户数据 |
| ROP 利用 | 链式 API 调用绕过限制 |

**示例 - WebInk 中的"利用"场景**:

```javascript
// 类似"权限提升"的过度声明
// manifest.json
{
  "permissions": [
    "tabs",           // 实际只需要 activeTab
    "cookies",        // WebInk 不需要 cookie 访问
    "webNavigation"   // 可能的隐私风险
  ]
}

// "信息泄露"风险 - 用户数据意外暴露
function extractContent() {
  const content = {
    markdown: result,
    // 可能泄露用户浏览历史
    url: window.location.href,
    title: document.title,
    // Cookies 可能被意外包含
    cookies: document.cookie // ⚠️ 安全风险
  };
  return content;
}
```

#### 典型使用场景

1. **Shellcode 开发**: 编写利用载荷
2. **Exploit 编写**: 使用 pwntools 编写自动化利用脚本
3. **漏洞挖掘**: 发现零日漏洞

---

### 4. deep-analysis - 深度定向分析

#### 来源与安装

**GitHub 仓库**: [cyberkanda/reverse-engineering-assistant](https://github.com/cyberkaida/reverse-engineering-assistant)

**安装方式**: 同 binary-triage

#### 功能描述

`deep-analysis` 执行**聚焦的、深度优先的调查**，通过迭代分析和数据库改进来回答特定的逆向工程问题。

它的核心特点：
- **增量改进**: 每次分析都会改进数据库（重命名、类型修复、注释）
- **证据驱动**: 返回基于证据的答案，并建议新的分析线程
- **长上下文**: 可以处理大型二进制甚至整个固件镜像
- **人机协作**: 引导 AI 像人类一样探索二进制

#### 与 Chrome 扩展逆向的关联

`deep-analysis` 的**哲学**与我们分析 WebInk v0.4.2 的过程高度吻合：

| Deep Analysis 原则 | WebInk v0.4.2 分析应用 |
|-------------------|----------------------|
| 从已知入口点开始 | 从 `manifest.json` 和 background scripts 开始 |
| 增量改进理解 | 先建立基础类型，再逐步完善 |
| 保持分析数据库 | 维护 `src/types/` 类型定义文件 |
| 报告证据 + 新线程 | 每次发现记录在 `REVERSE_ENGINEERING_NOTES.md` |

**示例 - WebInk v0.4.2 的深度分析工作流**:

```typescript
// Phase 1: 初始扫描 (类似 binary-triage)
const initialScan = {
  files: 359,
  size: "12.2 MB",
  keywords: { "Monaco": 50, "Mermaid": 30, "Turndown": 20 }
};

// Phase 2: 深度分析 (类似 deep-analysis)
const deepAnalysis = {
  // 改进类型数据库
  improveTypes: () => {
    // 第一轮：基础类型
    interface WebInkConfig { /* ... */ }

    // 第二轮：添加 v0.4.2 新功能
    interface WebInkConfig {
      // v0.4.1 基础
      enableHighlight?: boolean;
      // v0.4.2 新增
      enableMonaco?: boolean;
      mermaidTheme?: string;
    }

    // 第三轮：从 v0.4.1 迁移缺失类型
    interface ExtractedContent { /* ... */ }
  },

  // 返回证据 + 新分析方向
  reportFindings: () => {
    return {
      evidence: "发现 content.06af5f40.js 包含 200+ 语言包",
      nextThread: "分析 Monaco Editor 如何动态加载语言包"
    };
  }
};
```

#### 典型使用场景

1. **长期项目**: 大型二边制文件的完整逆向工程
2. **函数重命名**: 系统性地改善代码可读性
3. **类型修复**: 自动检测并修复错误的类型定义
4. **文档生成**: 自动生成函数调用图、类图

---

## Skills 应用决策树

```
面对未知文件/任务
        │
        ├─ 是二进制文件 (ELF/PE/Mach-O)?
        │   ├─ 快速了解功能 ──────→ binary-triage
        │   └─ 深入特定问题 ──────→ deep-analysis
        │
        ├─ 是 CTF 挑战?
        │   ├─ 需要提取隐藏信息 ───→ ctf-rev
        │   └─ 需要利用漏洞 ───────→ ctf-pwn
        │
        └─ 是 Chrome 扩展?
            └─ 应用分析思维 ───────→ 本指南
```

---

## Skills 在 WebInk 分析中的虚拟应用

如果我们将 ReVa 的 Skills 应用到 WebInk v0.4.2 的分析，工作流将是：

```bash
# 1. binary-triage: 快速扫描
$ binary-triage webink-v042-source-code/
  发现:
  - 359 个文件
  - Monaco Editor 相关: 200+ 语言包
  - Mermaid 图表: 15+ 类型
  - 核心库: Turndown, Readability
  建议深度分析: Monaco Editor 集成方式

# 2. deep-analysis: 类型系统重建
$ deep-analysis --target types webink-v042-source-code/
  阶段 1: 基础类型定义 ✓
  阶段 2: 从 v0.4.1 迁移兼容类型 ✓
  阶段 3: 添加 v0.4.2 新功能类型 ✓
  发现: content/ 目录需要从 v0.4.1 补充

# 3. 安全审计 (类似 ctf-pwn 的漏洞思维)
$ ctf-pwn --target permissions webink-v042-source-code/
  检测结果:
  - ✅ 数据仅本地存储
  - ⚠️  host_permissions 范围可能过大
  - ⚠️  建议添加 DOMPurify 防止 XSS
```

---

## 进阶学习路径

```
第 1 阶段: 掌握 Chrome 扩展逆向工程指南
    ↓
    Chrome 扩展逆向工程基础
    - CRX 提取
    - 代码结构分析
    - 类型系统重建

第 2 阶段: 学习 binary-triage 思维
    ↓
    快速扫描与分类
    - 字符串扫描技术
    - 导入/导出分析
    - 内存布局理解

第 3 阶段: 掌握 deep-analysis 方法论
    ↓
    系统化深度分析
    - 增量改进数据库
    - 证据驱动决策
    - 长上下文处理

第 4 阶段: 探索 CTF 技巧 (ctf-rev/ctf-pwn)
    ↓
    高级逆向技术
    - 控制流分析
    - 数据流追踪
    - 漏洞利用原理
```

---

## 总结

| Skill | 核心价值 | 在 WebInk 分析中的对应 |
|-------|----------|---------------------|
| **binary-triage** | 快速了解未知文件 | 功能关键词频率分析 |
| **ctf-rev** | 系统化发现隐藏信息 | 识别混淆的核心逻辑 |
| **ctf-pwn** | 发现和利用漏洞 | 安全审计与权限分析 |
| **deep-analysis** | 深度、增量式改进 | 类型系统逐步完善 |

**关键洞察**: 虽然这些 Skills 主要为二进制逆向设计，但其**方法论**（系统化分析、增量改进、证据驱动决策）是通用的，可以应用于任何逆向工程任务，包括 Chrome 扩展。

---

**相关资源**:

- **ReVa GitHub**: [https://github.com/cyberkaida/reverse-engineering-assistant](https://github.com/cyberkaida/reverse-engineering-assistant)
- **作者 Twitch**: [https://twitch.tv/cyberkaida](https://twitch.tv/cyberkaida)
- **Ghidra 官网**: [https://ghidra-sre.org/](https://ghidra-sre.org/)
- [Chrome扩展逆向工程指南](Chrome扩展逆向工程指南.md) — 核心方法论
- [逆向工程案例库](逆向工程案例库.md) — 实战案例参考

---

*最后更新: 2026-07-06 — 从主指南拆分，独立为 Skills 专项文档*
