# Taro H5 样式不精准与 Figma 还原排错

**一句话总结**：首页样式和设计稿对不上，逐层消融后定位到 Taro H5 的 rem 根字号被钳制（375 视口应为 20px 实际 22.08px，全部 rem 值偏大 10.4%），属于宿主配置问题须用户拍板；同时沉淀了「样式值必须带 Figma 节点号溯源注释」的红线。

## 背景

spec7 首页/复盘页按 Figma 还原后，用户反复反馈「现在最重要」「进行中徽标、标题」与设计稿不一致。先后排除了取值错、全局样式覆盖、浏览器最小字号，最后用 computed style 对比锁定根因。

## 核心命令

```bash
# 用 gua-figma 脚本提取 Figma 节点实测样式（token 从 gua-figma/.env 读，homing_token 是 COS 凭证别混用）
FIGMA_TOKEN=<FIGMA_TOKEN> node extract-styles.mjs --url "<含 node-id 的 Figma URL>" --json out.json

# 脚本在 skill 安装路径下可能静默无输出，先拷到项目 .debug 再跑
cp -r ~/.zcode/skills/gua-figma/scripts .debug/figma-restore/

# 定位样式被谁改坏：看单个 scss 相对基线的 diff
git diff HEAD -- src/pages/home/h5/components/SpecialSection/components/EventCard/index.module.scss

# 浏览器控制台取真实渲染值（多个 class 共存时用 [class*=] 模糊匹配）
getComputedStyle(document.querySelector('[class*="statusBadgeText"]')).fontSize

# 根因确认：查 html 根字号（Taro H5 rem 管线的一切都乘它）
getComputedStyle(document.documentElement).fontSize

# 全量搜代码里的小数 px（VS Code 正则同款）
rg -n "\d+\.\d+px" src/pages/home/h5 -g '*.scss'
```

## 关键结论

1. **computed fontSize 不等于代码值时，先查根字号再怀疑代码**：Taro H5 的 `pxtransform` 把 750 稿 px 转成 rem，运行时渲染值 = rem × `<html>` 的 font-size；根字号被 `maxRootSize/minRootSize`（config/index.js）钳制后全体样式按比例漂移。
2. **本例铁证**：同一元素两次查询 fontSize 不同（14.3px / 12.144px），根字号恒为 22.08px 而逻辑值应为 20px，22.08/20 = 1.104 —— 所有 rem 值精确偏大 10.4%，与截图观感完全吻合。改钳制属宿主配置，需用户拍板。
3. **截图不能作为取值来源**：目测猜值连错两轮（18/600、36/600），Figma REST 实测后一次到位（22/500/30.8、32/500/44.8）。视觉值只认 `extract-styles` 输出的字段。
4. **homing_token ≠ FIGMA_TOKEN**：前者是 COS 上传临时凭证，直接当 `X-Figma-Token` 用会 401；FIGMA_TOKEN 在 gua-figma/.env。
5. **9997:7227 是孤立矩形**：Figma URL 里的 node-id 不一定是可用的帧，先拉页面树（`/v1/files/<key>?depth=2`）按名字找正确的 FRAME。
6. **样式溯源注释写进 AGENTS.md 红线**：按设计稿取值的规则上方必须写 `/* 设计帧 <节点号>：<实测值> */`，间距要注明来源容器（如「容器 9589:5786 VERTICAL gap 12」），不许删改，值改注释不改视为缺陷。
7. **设计稿废弃图层会骗人**：同名状态徽标有紫色版（visible=false）和绿色版两层，照 JSON 树还原会做错，须过滤 `visible=false` 并对照渲染图。
8. **多方案对同一批文档级替代**：python 端读文件 → 逐条 `old,new` 替换 → 统一写回，每条未命中打印 NOHIT，比手工编辑可靠且可复跑。
9. **类型检查配置随源码演进**：service 引入新模块（如 `@/utils/int64`）后，最小 tsconfig 的 `paths` 要同步补；`.debug` 下的边界声明文件路径相对 `baseUrl` 解析，写错只报"找不到模块"不提示路径差一级。

## 遗留

- rem 钳制（maxRootSize/minRootSize）调整属宿主配置，等用户确认后再改；当前所有页面在 375 视口下均偏大 10.4%。
