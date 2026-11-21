# Cursor 提示词：按原型复刻 tcode 桌面 UI

在 `ui/refresh-workbench` 分支上改 `impls/typescript/src/shell/web.html`，目标是让界面和 `docs/ui/tcode-ui-复刻/prototype.html`（先把我给的 prototype.html、复刻规范.md 放到这个目录）一致。原型的布局和数值来自 deepseek-harness（MIT），在 web.html 顶部注释写上署名。

规则：
1. 只改 web.html，不动后端和协议。规范第 8 节列的 id 一个都不能删、不能改名；元素可以挪位置、换外观，绑定的事件和行为要保持原样。
2. 按规范第 7 节分 4 期做，每期单独一个 commit。每期做完都跑一遍 `npm run test:ui`，必须全绿；再用 Playwright 截 1440×900 的图，和 `prototype.html?scene=…` 对应场景比对，差异写进 commit message。
3. 先把规范第 2 节的 tokens 写成 CSS 变量（亮色、暗色两套），后面不准出现散落的颜色硬编码。
4. P1 Sidebar：做全宽「新会话」按钮；去掉「搜索」导航和常驻搜索框，改成「项目」分区头里的 3 个图标（搜索、视图选项、添加项目）；项目列表和会话列表合并成一棵树（项目行 34px / 会话行 32px / 右侧显示时间 / 每个项目先显示 5 条，其余折叠成「展开其余 N 个」）；底部改成头像加版本号，点开向上弹菜单。
5. P2：顶栏去掉「需要配置模型」pill 和「查看变更」按钮，只在右上放一个面板图标（还是用 #diff-toggle）。Hero 去掉两个蓝按钮，换成项目 chip 和模式 chip；模型缺失时只在 composer 上方显示一条 #notice；composer 底行布局是：+ / 权限 select / 右侧模型 select / 发送。
6. P3：把设置整页改成模态，左侧导航 6 项，改动即时保存，保存后弹 toast。
7. P4：视图选项菜单、项目 hover 卡片、⋯ 菜单、56px 折叠 rail、暗色主题。快捷键按规范第 4 节实现。
8. WebKit 兼容：毛玻璃要同时写 `-webkit-backdrop-filter`；不要用 `field-sizing`。
9. 不要复制 harness 的鲸鱼 logo、Montserrat 字体，界面里不出现 DeepSeek 品牌文案。
每期结束后报告：改了什么、截图对比结果、测试结果、还有哪些没对齐。
