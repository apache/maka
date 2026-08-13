# Maka 设置页深度 Review——以 Astryx 设计语言为基准

> 2026-08-03,基于 `settings/astryx-refactor` 分支(已 rebase 到最新 main)。
> 审计方式:Storybook 全页截图(中/英 × 亮/暗)+ Astryx 官方 `settings` / `settings-dialog` 模板与 `astryx docs` 原文精读。

## 一、Astryx 官方设置语言到底是什么

来自 CLI vendor 的官方模板(`@astryxdesign/cli/templates/pages/settings*`)与 `astryx docs principles / layout` 原文:

1. **开放式分组,不是卡片堆叠。** 官方两个 settings 模板中,设置行**零卡片**:
   分组 = `Heading level={3}` + supporting 副标题,行与行之间用 `Divider`,
   内容列上限 ~680px。Card 只出现在**强调性 callout**(隐私承诺、提示卡)上。
2. **原文规则:**
   - "Card = widget container, NOT list-item wrapper. dense/scannable data =
     rows: edge-to-edge, 32-40px rows, dividers."
   - 反模式清单:**"no stacked full-width Cards as page structure"**(整页
     全宽卡片堆叠 = "prototype look")、"no Cards in Cards"、"no
     Card-wrapped list items"、**"no decorative Badge — StatusDot/Token for
     status"**。
3. **开关行是组件原生能力。** 官方模板用
   `Switch labelPosition="start" labelSpacing="spread"`(标签在左、开关在右、
   整行铺开)直接成行——不需要任何自写行布局。
4. **表单节奏。** 段内 `gap 4`(16px),段间 `gap 6–8`(24–32px);
   一个视图一个 primary。

**Maka 自己的最佳内证:模型页。** 它已经是 edge-to-edge 行 + divider + 图标板
+ chevron,一眼就是 Astryx——而其余 13 页是另一种方言(每组一张卡)。

## 二、横切问题(按伤害排序)

### C1 · 页面结构 = 全宽卡片堆叠(官方明确反模式)
每个 `SettingsSection` 都渲染成一张带边框圆角卡。通用页 4 张、记忆页 3 张、
健康页 6 张(其中 5 张只装一行)。暗色下卡片边框几乎不可见,"卡"只剩噪音。
这正是 docs 说的 "content-first prototype look"。

### C2 · 嵌套容器(no Cards in Cards)
- 记忆页:卡内灰盒("检测到 1 个项目指令文件"、MEMORY.md 路径框)、
  灰卡内再套带边框的 `<pre>`(模型上下文预览)= 三层容器。
- 记忆条目列表:每条记忆一个灰盒 = "Card-wrapped list items"。

### C3 · Badge 滥用(no decorative Badge)
全站彩色药丸:等待授权/已拒绝/部分可用/系统拒绝/运行可用/阻塞发送/阻塞能力……
健康页同一信息出现三次(顶部句子药丸 + 行级 Badge + 行内 chip)。记忆条目里
甚至有整句话的 chip("生效条目,会进入本地记忆 prompt")。官方语言:状态用
`StatusDot`/`Token`,颜色只留给例外。

### C4 · 按钮洪水,无层级
- 记忆页 MEMORY.md 下 **9 个**并排文字按钮(已保存/打开/打开目录/重新载入/
  打开上一版/复制路径/复制上一版引用/重置并备份/恢复上一版),换行两排。
- 备份候选每行 3 个按钮 ×2 行;记忆条目每条 3 个按钮。
- 语音页 3 个 primary 蓝按钮(测试识别/运行录音自检/…);权限页"屏幕录制"
  行 3 个平级按钮其一为 primary。
官方语言:一行一个安静动作(`Link` 或 ghost),次要动作收进 `MoreMenu`。

### C5 · 蓝色当纹理(违反 Maka 自己的 Signal-Not-Texture 规则)
数据页大块蓝色 info Banner、语音页"等待运行本机录音自检"蓝条、关于页蓝色
识别块。信息性说明应是 muted 卡或 supporting 文本;蓝色只留给动作与状态。

### C6 · 读值行的右对齐长文本
工作区路径在数据页/关于页右对齐、锯齿状换 4 行 mono——极难读。长值应整行
展示(start-aligned)或折叠为"复制"动作。

### C7 · 行语法不统一
同为"选一个模型":通用页 = 标签左/选择器右;每日回顾 = 标签上/全宽选择器。
执行时间(08:00)占 640px 全宽输入框。触发器宽度各行不一(GLM-4.7 vs Auto)。

### C8 · 仪表盘化的 stat tiles
权限页 4 格、健康页 5 格,部分带彩色边框(warning/destructive 描边),
使用统计页数字风格互不一致($2.34 与 420 与 0 的字重/行高不同)。设置页
不是 dashboard;计数应退为 section 描述里的一句话或安静的 `Token`。

### C9 · 使用统计表格被裁切
请求日志表在 640 列内横向溢出,金额列被切掉一半,日期/模型名截断
("2026/8/3 1..."),横向滚动无可见 affordance。

### C10 · 杂项
- 权限页顶部悬空 meta 行("最近读取:35秒钟前 重新检测")无标题配对。
- 健康页底部 dashed 边框免责声明(词汇表外的样式)。
- 联网搜索:密钥输入框窄挤在行右 + 独立小眼睛按钮悬浮;"执行查询"行的
  帮助文本右对齐漂浮在按钮下。
- 关于页"复制环境信息"按钮 + 右侧说明文字挤在卡片底行。

## 三、逐页清单(问题 → 目标形态)

| 页面 | 现状问题 | 目标(Astryx 语言) |
|---|---|---|
| 通用 | C1;身份卡内三种行型混排 | 开放分组;Switch spread 行;表单行统一 Field 语法 |
| 外观 | 最接近目标;SelectableCard 合法(option grid) | 仅去掉外层卡感、统一 section 节奏 |
| 模型 | ✅ 已是正确形态 | 作为基准,不动 |
| 记忆 | C2/C3/C4 重灾区 | 状态行=List;路径=一行读值+复制;9 按钮→1 primary + MoreMenu;条目=edge-to-edge 行;句子 chip→StatusDot+文本 |
| 语音 | 3 个 primary;蓝条;私有"当前边界"文块 | 诊断动作降为 secondary;蓝条→muted 文本;边界=muted Card callout(官方 callout 用法) |
| 联网搜索 | C10;伪行(凭据操作/执行查询) | 密钥=全宽 Field(带 suffix);动作行归到 section 尾;状态 chip→StatusDot |
| 使用统计 | C8/C9 | 表格列预算+容器内横滚;tiles→统一 stat 排版 |
| 每日回顾 | C7 | 行语法对齐通用页(标签左/控件右,TimeInput 紧凑) |
| 数据 | C5/C6 | 路径整行;Banner→muted callout;destructive 动作贴其所属行 |
| 权限与能力 | C3/C8;诊断 dl 报表化 | tiles→一句话+Token;Badge→StatusDot;诊断块收进 Collapsible,行内布局用 MetadataList |
| 健康 | C3/C8;六段各装一行 | 合并为一个分层 List(分组头行);预警药丸→顶部一条 Banner(仅当有阻塞时) |
| 关于 | C5/C6 | 路径整行;识别块去蓝;隐私列表已 OK |
| Bot/远程接入 | 未细查,同语言迁移 | 随中枢自动获得 |

## 四、重构方案(第一性原理:框架风格出发,美观优先)

**方向:全面切换到官方开放式分组语言**(即模型页/官方模板形态),
卡片降级为例外(callout、option grid)。

1. **中枢一次切换**(`settings-section.tsx` + `rows.css`):
   `SettingsSection` 的 'rows' 体从 `Card` 改为开放行组——行间 `Divider`、
   无边框无底色;section 头下加 `Divider` 锚线(官方 dialog 模板节奏);
   段间距 32px。全部 14 页零调用点改动即换肤。
2. **行语法收敛为三种**:
   - `SettingsRow`:标签+说明(左,可换行)/ 控件或读值(右,有宽度上限);
   - `SettingsField`:全宽控件(TextArea、长输入、表格);
   - `SettingsActions`:段尾动作簇,一个 primary,其余 ghost/`MoreMenu`。
3. **状态语言**:新增 `SettingsStatus`(`StatusDot` + 文本)替换全部装饰性
   Badge;彩色药丸只保留真正的计数/枚举 `Token`。
4. **逐页清理 C4/C5/C6**(按第三节清单),记忆页单独做(动作收纳进
   `MoreMenu`、条目行化)。
5. **验证闭环**:四组合(zh/en × light/dark)截图全过;dead CSS review 归零
   (预计再删 memory.css/permission.css/health.css 大半);typecheck + 全检查。

预计削减:settings 专属 CSS 从 ~1900 行降到 <600 行;页面代码同步变薄。
