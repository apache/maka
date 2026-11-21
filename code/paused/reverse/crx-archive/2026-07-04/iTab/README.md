# iTab v2.1.17 — 逆向工程 (dsv4 重做)

**文件数**: 647 (本轮最多) | **技术栈**: Vue 3 + Element UI + Tailwind + JSZip

## 关键变更

- 🔄 **注入模式变更**: content_scripts 声明式 → 动态注入 (chrome.scripting)
- 🆕 **PDF Export**: pdf.worker (970KB)
- 🆕 **Desktop Capture**: optional_permission
- 🆕 **Offscreen API**: 后台渲染支持
- 📏 **chrome_url_overrides**: newtab 替换
