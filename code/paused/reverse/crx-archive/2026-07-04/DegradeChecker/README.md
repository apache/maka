# ChatGPT Degrade Checker — 逆向工程项目归档

**归档日期**: 2026-07-04 | **AI**: Claude (DeepSeek-V4-Pro)
**项目**: ChatGPT Degrade Checker 降级检查 v2.4.6

---

## 📁 内容

```
2026-07-04-DegradeChecker-dsv4/
├── *.crx                     # 原始文件
├── extract_crx.py            # 通用提取脚本
├── degchecker-source-code/   # 提取的原始代码 (12 文件)
├── degchecker-dsv4/          # 还原项目
│   ├── dist/                 # ✅ 加载到 Chrome
│   ├── src/types/            # TypeScript 类型
│   ├── src/content/          # 内容脚本逻辑
│   └── src/docs/             # 文档
└── README.md
```

## 功能

- 📊 30+ GPT 模型使用统计（含 GPT-5 系列）
- 🔴 PoW 降智风险检测（通过难度值前导零分析）
- 👤 账号类型自动识别（免费/Plus/Pro/Team）
- 📦 聊天记录导出（JSZip）
- 🎨 浮动面板 + 迷你预览（贴边/拖拽）

## 核心发现

- **无 Background Worker**：纯 Content Script 方案
- **页面注入**：inject.js → fetch_script.js 拦截 API
- **localStorage 存储**：非 chrome.storage API
- **PoW 难度检测**：通过十六进制前导零数量判断降智级别
