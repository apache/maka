

#### 原始文档记录
#### Git 提交归纳
+ ai-audio-editing-node-bff：AI 音频编辑页面、Node BFF、任务状态、波形处理与智能剪辑链路开发。提交依据：增强长任务快照恢复与排查留痕；支持直连COS音频上传与长音频波形处理；固定音频编辑任务接口路径。
+ homing-miniapp-node-bff：开发与问题修复。提交依据：搭建8087模拟Java联调服务。
+ homing-miniapp-workbench：AI 音频编辑页面、Node BFF、任务状态、波形处理与智能剪辑链路开发。提交依据：增加 CNB 内网穿透联调变量；优化音频编辑入口和任务轮询稳定性；优化波形加载态展示；支持 itest 音频编辑内网穿透联调。

提交明细：

+ `ai-audio-editing-node-bff` `0c0918c`：feat(audioEdit): 支持直连COS音频上传与长音频波形处理
+ `ai-audio-editing-node-bff` `ddb537a`：refactor(audioEdit): 固定音频编辑任务接口路径
+ `ai-audio-editing-node-bff` `f2238ec`：fix(audioEdit): 增强长任务快照恢复与排查留痕
+ `homing-miniapp-node-bff` `ca7839e`：feat(audioEdit): 搭建8087模拟Java联调服务
+ `homing-miniapp-workbench` `14ba3365`：refactor(audioEdit): 固定前端音频编辑任务接口路径
+ `homing-miniapp-workbench` `268f5e7f`：refactor(audioEdit): 统一文案常量并增强任务失败提示
+ `homing-miniapp-workbench` `280b05c5`：fix(audioEdit): 优化音频编辑入口和任务轮询稳定性
+ `homing-miniapp-workbench` `2bf308ca`：fix(audioEdit): 优化波形加载态展示
+ `homing-miniapp-workbench` `417b4cab`：chore(audioEdit): 增加 CNB 内网穿透联调变量
+ `homing-miniapp-workbench` `eec237f7`：feat(audioEdit): 支持 itest 音频编辑内网穿透联调

#### 填报建议
+ 任务：ai-audio-editing-node-bff：AI 音频编辑页面、Node BFF、任务状态、波形处理与智能剪辑链路开发；homing-miniapp-node-bff：开发与问题修复；homing-miniapp-workbench：AI 音频编辑页面、Node BFF、任务状态、波形处理与智能剪辑链路开发。
+ 工时：待填报。

### 2026-06-10
#### 原始文档记录
#### Git 提交归纳
+ ai-audio-editing-node-bff：AI 音频编辑页面、Node BFF、任务状态、波形处理与智能剪辑链路开发。提交依据：修复智能剪辑分段与 ffprobe 探测；整合 AI 音频编辑技术文档。
+ homing-miniapp-node-bff：开发与问题修复。提交依据：Initial commit from Create Next App。
+ homing-miniapp-workbench：AI 音频编辑页面、Node BFF、任务状态、波形处理与智能剪辑链路开发。提交依据：接入模拟 Java 音频编辑任务接口；修复另存为状态与手动剪辑波形样式；优化音频编辑波形时间线样式；优化音频编辑播放与波形交互。

提交明细：

+ `ai-audio-editing-node-bff` `1db4191`：docs(audioEdit): 整合 AI 音频编辑技术文档
+ `ai-audio-editing-node-bff` `acf774c`：fix(audioEdit): 修复智能剪辑分段与 ffprobe 探测
+ `homing-miniapp-node-bff` `f3d18c5`：Initial commit from Create Next App
+ `homing-miniapp-workbench` `2d0d030a`：feat(audioEdit): 优化音频编辑波形时间线样式
+ `homing-miniapp-workbench` `3e80569f`：feat(audioEdit): 优化音频编辑播放与波形交互
+ `homing-miniapp-workbench` `c468378d`：fix(audioEdit): 接入模拟 Java 音频编辑任务接口
+ `homing-miniapp-workbench` `d261fdb2`：fix(audioEdit): 修复另存为状态与手动剪辑波形样式

#### 填报建议
+ 任务：ai-audio-editing-node-bff：AI 音频编辑页面、Node BFF、任务状态、波形处理与智能剪辑链路开发；homing-miniapp-node-bff：开发与问题修复；homing-miniapp-workbench：AI 音频编辑页面、Node BFF、任务状态、波形处理与智能剪辑链路开发。
+ 工时：待填报。

### 2026-06-08
#### 原始文档记录
来源：`03-开发任务.md`  
一开始download全部，因为波形渲染需要这个数据，上传的时候采用分块进行。  
Java给node同时派发很多实例的话，采用node本身的任务排列，让它去排队，处理完一下到下一个。  
波形渲染、底部进度条  
智能剪辑 [https://meiye.cos.clife.cn/homing/ui/0/619421871a0a46a9a5e6500477c2f4d4.png](https://meiye.cos.clife.cn/homing/ui/0/619421871a0a46a9a5e6500477c2f4d4.png)  
智能剪辑弹窗图片提示 [https://meiye.cos.clife.cn/homing/ui/0/eb30890e33d14cb291b932a4d10bb85b.png](https://meiye.cos.clife.cn/homing/ui/0/eb30890e33d14cb291b932a4d10bb85b.png)

#### Git 提交归纳
+ ai-audio-editing-node-bff：AI 音频编辑页面、Node BFF、任务状态、波形处理与智能剪辑链路开发。提交依据：补充接口定义与常见 BUG 文档；修复 COS 配置与临时密钥鉴权；修复 ffmpeg runtime 路径解析；增加项目协作说明与工具目录占位。
+ homing-miniapp-workbench：AI 音频编辑页面、Node BFF、任务状态、波形处理与智能剪辑链路开发。提交依据：开发AI音频编辑页面；新增 AI 音频编辑入口与基础页面。

提交明细：

+ `ai-audio-editing-node-bff` `20303fa`：补充音频编辑异步任务契约与后续清单
+ `ai-audio-editing-node-bff` `31a8867`：fix(audioEdit): 修复 ffmpeg runtime 路径解析
+ `ai-audio-editing-node-bff` `3a08e5a`：feat(audioEdit): 新增异步任务队列与内部接口
+ `ai-audio-editing-node-bff` `5385847`：feat(audioEdit): 接入腾讯云 COS 分块上传
+ `ai-audio-editing-node-bff` `7a212f9`：docs(workspace): 增加项目协作说明与工具目录占位
+ `ai-audio-editing-node-bff` `7b1124e`：fix(audioEdit): 修复 COS 配置与临时密钥鉴权
+ `ai-audio-editing-node-bff` `b8a7a51`：refactor(audioEdit): 重组 Node BFF 模块分层
+ `ai-audio-editing-node-bff` `c0f0bd8`：docs(audioEdit): 补充异步任务架构方案
+ `ai-audio-editing-node-bff` `d2c2757`：docs(audioEdit): 补充接口定义与常见 BUG 文档
+ `ai-audio-editing-node-bff` `d6d7c8b`：fix audio waveform to use real ffmpeg data
+ `ai-audio-editing-node-bff` `ddaee61`：新增音频编辑测试探活接口
+ `ai-audio-editing-node-bff` `e03d4ec`：docs(audioEdit): 更新异步任务实现结果
+ `ai-audio-editing-node-bff` `e0a26cb`：feat(audioEdit): 支持任务级 COS 下载上传参数
+ `homing-miniapp-workbench` `8b13461c`：feat(audioEdit): 新增 AI 音频编辑入口与基础页面
+ `homing-miniapp-workbench` `eddce83b`：feat(audioEdit): 开发AI音频编辑页面

#### 填报建议
+ 任务：ai-audio-editing-node-bff：AI 音频编辑页面、Node BFF、任务状态、波形处理与智能剪辑链路开发；homing-miniapp-workbench：AI 音频编辑页面、Node BFF、任务状态、波形处理与智能剪辑链路开发。
+ 工时：待填报。

### 2026-06-05
#### 原始文档记录
来源：`03-开发任务.md`

```json
Hi, 我是您的面诊助手
```

#### 填报建议
+ 任务：按原始文档记录填报。
+ 工时：待填报。

### 2026-06-04
#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：删除预约助手本地开发文件；对齐预约助手取消预约旧版逻辑。

提交明细：

+ `beauty-smart-advisor` `3ecf4e85`：fix: 对齐预约助手取消预约旧版逻辑
+ `beauty-smart-advisor` `e8db1d98`：fix: 删除预约助手本地开发文件

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。
+ 工时：待填报。

### 2026-06-03
#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：improve reservation board android compatibility；样式兼容；补齐状态筛选未选中空心圆；关闭预约助手当前时间线自动滚动。

提交明细：

+ `beauty-smart-advisor` `1d62b79e`：fix(reservationBoard): 修复已完成和爽约状态展示
+ `beauty-smart-advisor` `1dd075dc`：fix: 补齐状态筛选未选中空心圆
+ `beauty-smart-advisor` `41ed11f7`：fix(reservationBoard): 修复当前时间线定位
+ `beauty-smart-advisor` `45a50bae`：fix: 样式兼容
+ `beauty-smart-advisor` `5b9832b9`：fix: 隐藏预约助手左侧已完成状态
+ `beauty-smart-advisor` `6162812c`：fix: improve reservation board android compatibility
+ `beauty-smart-advisor` `68c1f59b`：fix: 关闭预约助手当前时间线自动滚动
+ `beauty-smart-advisor` `77cb866e`：style: 统一预约助手浮层圆角为20px
+ `beauty-smart-advisor` `a38d7824`：fix: 新增预约后显式刷新日历灰点
+ `beauty-smart-advisor` `cf77e270`：fix: 单门店预约表单禁用门店树弹窗
+ `beauty-smart-advisor` `f05e8ceb`：fix: 修复预约助手顶部背景色分区
+ `beauty-smart-advisor` `fb8d8287`：fix: 修复预约助手今天时间线滚动定位

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。
+ 工时：待填报。

### 2026-06-01
#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：适配预约气泡多方向角标；接入骨架屏组件；Revert "feat(reservationBoard): 优化 boneyard 骨架屏边界和粗颗粒捕获"。
+ homing-miniapp-brand：骨架屏基础链路与页面接入验证。提交依据：接入全局 boneyard 骨架屏；Revert "feat(aiCoach): 接入小程序 boneyard 骨架 POC"。

提交明细：

+ `beauty-smart-advisor` `077bbd48`：feat(reservationBoard): 接入骨架屏组件
+ `beauty-smart-advisor` `1f5865ac`：Revert "feat(reservationBoard): 优化 boneyard 骨架屏边界和粗颗粒捕获"
+ `beauty-smart-advisor` `ac997a99`：fix(reservationBoard): 适配预约气泡多方向角标
+ `homing-miniapp-brand` `1233df78`：Revert "feat(aiCoach): 接入小程序 boneyard 骨架 POC"
+ `homing-miniapp-brand` `738c2fb1`：feat: 接入全局 boneyard 骨架屏

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复；homing-miniapp-brand：骨架屏基础链路与页面接入验证。
+ 工时：待填报。

### 2026-05-29
#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：保存预约时补传实时匹配customerId。
+ homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化。提交依据：新增睡眠报告评分说明气泡。
+ homing-sub-pedestal：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：保存预约时补传customerId。

提交明细：

+ `beauty-smart-advisor` `c19176e2`：fix(reservationBoard): 保存预约时补传实时匹配customerId
+ `homing-miniapp-brand` `642068cf`：feat: 新增睡眠报告评分说明气泡
+ `homing-sub-pedestal` `49a3587a`：fix(reservation): 保存预约时补传customerId

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复；homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化；homing-sub-pedestal：预约助手功能开发、接口联调、交互样式优化与缺陷修复。
+ 工时：待填报。

### 2026-05-28
#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：补充预约卡片气泡左侧指向预约来源的小尖角；修复时间轴非整半点闭店时卡片刻度偏移；初步还原预约助手弹窗与时间轴样式。

提交明细：

+ `beauty-smart-advisor` `39cec4a7`：fix(reservationBoard): 修复时间轴非整半点闭店时卡片刻度偏移
+ `beauty-smart-advisor` `7665653a`：fix(reservationBoard): 初步还原预约助手弹窗与时间轴样式
+ `beauty-smart-advisor` `f23e1e9f`：fix(reservationBoard): 补充预约卡片气泡左侧指向预约来源的小尖角

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。
+ 工时：待填报。

### 2026-05-27
#### 原始文档记录
来源：`03-开发任务.md`

```plain
到店时间的数据来源是门店组织树接口 /v1/homing/system/web/org/list 返回的 shopOpenTimes.startTime/endTime，前端拿到当天营业开始和结束时间后，按每 30 分钟一个步长生成可选时间，所以会包含 00:00，但 23:45 因为不在半小时刻度上不会生成。
当前前端时间选择器只支持半小时刻度，可选项按 00/30 分钟生成，23:45 虽然是后台配置的营业结束时间，但不在半小时刻度上，所以当前不能直接选到 23:45。
```

#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：UI还原门店树箭头与首页平板样式；还原预约助手首页与时间轴样式；切换到店日期时清空已选到店时间；还原日历图标和周视图灰点样式。
+ homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化。提交依据：优化皮肤健康趋势打卡标签展示。

提交明细：

+ `beauty-smart-advisor` `0d0656c3`：fix(reservationBoard): 还原日历图标和周视图灰点样式
+ `beauty-smart-advisor` `2a5b3dda`：fix(reservationBoard): 优化预约浮层安全区与关闭入口
+ `beauty-smart-advisor` `583ec9b3`：fix(reservationBoard): 还原预约助手首页与时间轴样式
+ `beauty-smart-advisor` `f3ad89fc`：fix(reservationBoard): UI还原门店树箭头与首页平板样式
+ `beauty-smart-advisor` `f745207f`：fix(reservationBoard): 切换到店日期时清空已选到店时间
+ `homing-miniapp-brand` `29e09d45`：feat(a2ui): 优化皮肤健康趋势打卡标签展示

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复；homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化。
+ 工时：待填报。

### 2026-05-26
#### 原始文档记录
来源：`关天豪-每日任务.md`

+ 完善【智慧顾问】预约助手体验
1. 新增 H5 通用骨架屏
2. 接入骨架屏预览配置
3. 修复重选门店清空顾问
4. 兼容老安卓间距样式
5. 统一预约助手样式变量

#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：新增 H5 通用骨架屏基础链路；修复修改预约重选相同门店清空服务顾问；移除 gap 以兼容老安卓间距样式；统一预约助手样式变量和通用样式。
+ homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化。提交依据：修复皮肤健康趋势默认选中和日期显示。

提交明细：

+ `beauty-smart-advisor` `1fb812e1`：feat(global-skeleton): 新增 H5 通用骨架屏基础链路
+ `beauty-smart-advisor` `b8ee331a`：style(reservationBoard): 统一预约助手样式变量和通用样式
+ `beauty-smart-advisor` `c2adc4ea`：style(reservationBoard): 移除 gap 以兼容老安卓间距样式
+ `beauty-smart-advisor` `c306ba14`：fix(reservationBoard): 修复修改预约重选相同门店清空服务顾问
+ `homing-miniapp-brand` `20c22403`：feat(a2ui): 修复皮肤健康趋势默认选中和日期显示

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复；homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化。
+ 工时：待填报。

### 2026-05-25
#### 原始文档记录
来源：`关天豪-每日任务.md`

+ 修复【智慧顾问】预约助手BUG
1. 修复月历选中态异常
2. 优化预约气泡边界
3. 补充无门店权限提示
4. 优化门店树弹层高度
5. 替换服务项选择组件
6. 优化表单图标和文案
7. 调整香氛灯光文案
8. 修复服务项搜索选中
9. 过滤不可选服务项

#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：修复服务项Picker搜索选中与不可选项过滤；调整预约助手表单样式和香氛灯光文案；使用NutUI Picker替换服务项选择组件；优化门店树权限与单门店弹窗样式。

提交明细：

+ `beauty-smart-advisor` `49f242fa`：fix(reservationBoard): 优化门店树权限与单门店弹窗样式
+ `beauty-smart-advisor` `7f2d9cb9`：fix: 调整预约助手表单样式和香氛灯光文案
+ `beauty-smart-advisor` `85e7d3ef`：fix(reservationBoard): 修复服务项Picker搜索选中与不可选项过滤
+ `beauty-smart-advisor` `bed94e6f`：fix(reservationBoard): 使用NutUI Picker替换服务项选择组件;
+ `beauty-smart-advisor` `cead795f`：fix(reservationBoard): 修复月历选中态与底部气泡阴影

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。
+ 工时：待填报。

### 2026-05-23
#### Git 提交归纳
+ beauty-smart-advisor：骨架屏基础链路与页面接入验证。提交依据：优化 boneyard 骨架屏边界和粗颗粒捕获。
+ homing-miniapp-brand：骨架屏基础链路与页面接入验证。提交依据：接入小程序 boneyard 骨架 POC。

提交明细：

+ `beauty-smart-advisor` `335f60de`：feat(reservationBoard): 优化 boneyard 骨架屏边界和粗颗粒捕获
+ `homing-miniapp-brand` `5bcbfd4c`：feat(aiCoach): 接入小程序 boneyard 骨架 POC
+ `homing-miniapp-brand` `5ff1dc0b`：feat(aiCoach): 接入小程序 boneyard 骨架 POC

#### 填报建议
+ 任务：beauty-smart-advisor：骨架屏基础链路与页面接入验证；homing-miniapp-brand：骨架屏基础链路与页面接入验证。
+ 工时：待填报。

### 2026-05-22
#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：解耦状态栏与我的预约筛选；接入预约头像默认图兜底；优化时间轴加载居中和备注换行；保留无服务项预约的顾问信息。

提交明细：

+ `beauty-smart-advisor` `21a1363f`：fix(reservationBoard): 修复详情进入修改预约表单不回显
+ `beauty-smart-advisor` `30b64056`：fix(reservationBoard): 修复闭店时间点预约不显示
+ `beauty-smart-advisor` `4654e0c5`：fix(reservationBoard): 接入预约头像默认图兜底
+ `beauty-smart-advisor` `5348fffe`：fix(reservationBoard): 切换预约标签时清空旧列表数据
+ `beauty-smart-advisor` `63535870`：fix(reservationBoard): 优化时间轴加载居中和备注换行
+ `beauty-smart-advisor` `68cfedae`：fix(reservationBoard): 修正预约修改取消时间限制判断
+ `beauty-smart-advisor` `8358e09d`：fix(reservationBoard): 修正已到店统计字段取值
+ `beauty-smart-advisor` `955ec9ff`：fix(reservationBoard): 修复预约保存和标签刷新问题
+ `beauty-smart-advisor` `9776e228`：fix(reservationBoard): 解耦状态栏与我的预约筛选
+ `beauty-smart-advisor` `c016f358`：fix(reservationBoard): 对齐预约时间口径和营业时段选项
+ `beauty-smart-advisor` `fe77ea70`：fix(reservationBoard): 保留无服务项预约的顾问信息

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。
+ 工时：待填报。

### 2026-05-21
#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：切换顾问按tab维度刷新预约列表；隐藏当前员工重复顾问tab；修复预约时间时区偏移；我的预约按 packageEmployeeId 过滤。
+ homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化。提交依据：增加测肤记录查看更多交互。
+ homing-sub-pedestal：开发与问题修复。提交依据：为 qiankun 启动状态增加默认值；修复项目名称特殊字符跳转异常；修正添加顾客服务顾问门店来源。

提交明细：

+ `beauty-smart-advisor` `5256fc76`：fix(reservationBoard): 修复预约时间时区偏移
+ `beauty-smart-advisor` `59070188`：fix(reservationBoard): 我的预约按 packageEmployeeId 过滤
+ `beauty-smart-advisor` `758a5e84`：fix(reservationBoard): 隐藏当前员工重复顾问tab
+ `beauty-smart-advisor` `b27d78ea`：fix(reservationBoard): 切换顾问按tab维度刷新预约列表
+ `beauty-smart-advisor` `b98ce29a`：fix(reservationBoard): 修复预约卡片和预约详情顾客名称和手机号取值字段问题
+ `beauty-smart-advisor` `cac1c728`：fix(reservationBoard): 我的预约 page-list 增加 employeeId 过滤
+ `beauty-smart-advisor` `d6afd39e`：fix(reservationBoard): 修复预约详情字段取值和旧快照闪烁
+ `homing-miniapp-brand` `a77aaa34`：feat(a2ui): 增加测肤记录查看更多交互
+ `homing-sub-pedestal` `2ef8b73f`：fix(customer): 修正添加顾客服务顾问门店来源
+ `homing-sub-pedestal` `321cd6ae`：fix(commodity-projects): 修复项目名称特殊字符跳转异常
+ `homing-sub-pedestal` `cd5cdb0f`：fix(app): 为 qiankun 启动状态增加默认值

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复；homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化；homing-sub-pedestal：开发与问题修复。
+ 工时：待填报。

### 2026-05-20
#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：调整预约表单下拉选择浮层；调整门店选择弹层和返回处理；优化预约看板卡片和选择器视觉。
+ homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化。提交依据：增加皮肤健康趋势打卡标签展示。

提交明细：

+ `beauty-smart-advisor` `4c797654`：refactor(reservationBoard): 调整预约表单下拉选择浮层
+ `beauty-smart-advisor` `64bf5a83`：style(reservationBoard): 优化预约看板卡片和选择器视觉
+ `beauty-smart-advisor` `86cae3d2`：refactor(reservationBoard): 调整门店选择弹层和返回处理
+ `homing-miniapp-brand` `3b141bcd`：feat(aiCoach): 增加皮肤健康趋势打卡标签展示

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复；homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化。
+ 工时：待填报。

### 2026-05-19
#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：优化预约操作 loading 体验；初始化终端员工登录缓存；优化预约助手卡片布局与表单交互；修复无服务预约修改失败。

提交明细：

+ `beauty-smart-advisor` `12eea6e6`：fix(reservationBoard): 优化预约助手卡片布局与表单交互
+ `beauty-smart-advisor` `44ff9993`：fix(reservationBoard): 修复时间轴渲染与预约弹窗限制
+ `beauty-smart-advisor` `52685223`：feat(reservationBoard): 优化预约操作 loading 体验
+ `beauty-smart-advisor` `53ddf3e7`：fix(reservationBoard): 修复无服务预约修改失败
+ `beauty-smart-advisor` `a710d41d`：fix(reservationBoard): 初始化终端员工登录缓存
+ `beauty-smart-advisor` `fa2968c7`：fix(reservationBoard): 修正预约页签展示逻辑

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。
+ 工时：待填报。

### 2026-05-18
#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：优化预约弹窗与时间轴紧凑态样式；限制到店前后 1 小时取消预约；优化预约弹窗箭头与日期滑动体验；修复预约助手统计与占用时长逻辑。

提交明细：

+ `beauty-smart-advisor` `1bd9b054`：fix(reservationBoard): 修复预约助手统计与占用时长逻辑
+ `beauty-smart-advisor` `44a85419`：fix(reservationBoard): 绑定预约接口上下文并优化刷新
+ `beauty-smart-advisor` `9e20bb0c`：fix(reservationBoard): 限制到店前后 1 小时取消预约
+ `beauty-smart-advisor` `ed0b32ac`：fix(reservationBoard): 优化预约弹窗箭头与日期滑动体验
+ `beauty-smart-advisor` `f3e9f0d9`：fix(reservation-board): 优化预约弹窗与时间轴紧凑态样式

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。
+ 工时：待填报。

### 2026-05-16
#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：优化安卓平板预约时间轴密度；使用 NutUI Popover 优化预约卡片气泡；优化预约助手弹窗与卡片交互样式；接入预约统计与日历占用接口。

提交明细：

+ `beauty-smart-advisor` `111fc2ec`：feat(reservation-board): 接入预约统计与日历占用接口
+ `beauty-smart-advisor` `2fa03ece`：fix(reservationBoard): 优化预约助手弹窗与卡片交互样式
+ `beauty-smart-advisor` `6e451053`：fix(reservationBoard): 使用 NutUI Popover 优化预约卡片气泡
+ `beauty-smart-advisor` `88a883c8`：fix(reservationBoard): 优化预约助手日历与时间轴交互
+ `beauty-smart-advisor` `d20650a0`：fix: 优化安卓平板预约时间轴密度

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。
+ 工时：待填报。

### 2026-05-15
#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：收敛预约助手结构边界；移除预约助手本地 mock 兜底；修复预约弹窗服务顾问添加逻辑；修复预约时间轴卡片布局。

提交明细：

+ `beauty-smart-advisor` `4abc93dc`：fix(reservationBoard): 修复预约卡片横向布局与类型提示
+ `beauty-smart-advisor` `606e5ee5`：refactor(reservationBoard): 收敛预约助手类型定义目录并统一接口DTO导出
+ `beauty-smart-advisor` `6b9ae757`：refactor(reservationBoard): 收敛预约助手结构边界
+ `beauty-smart-advisor` `76d4b025`：fix(reservationBoard): 修复预约时间轴卡片布局
+ `beauty-smart-advisor` `8dc85b10`：fix(reservationBoard): 接入预约助手左侧历史预约统计
+ `beauty-smart-advisor` `d4730988`：refactor(reservationBoard): 移除预约助手本地 mock 兜底
+ `beauty-smart-advisor` `d9ed9d8b`：fix(reservationBoard): 修复预约弹窗服务顾问添加逻辑

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。
+ 工时：待填报。

### 2026-05-14
#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：规范CSS属性书写顺序；优化预约看板布局与灰点状态模型；修复预约操作与卡片刷新问题；修复预约状态刷新和卡片显示问题。

提交明细：

+ `beauty-smart-advisor` `5fc09544`：feat(reservationBoard): 优化预约看板布局与灰点状态模型
+ `beauty-smart-advisor` `95072dcb`：feat(reservationBoard): 完善新增修改预约弹窗
+ `beauty-smart-advisor` `dc6c8e13`：fix(reservationBoard): 修复预约状态刷新和卡片显示问题
+ `beauty-smart-advisor` `e0eb21bd`：chore(stylelint): 规范CSS属性书写顺序
+ `beauty-smart-advisor` `faec1814`：fix(reservationBoard): 修复预约操作与卡片刷新问题

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。
+ 工时：待填报。

### 2026-05-13
#### 原始文档记录
来源：`关天豪-每日任务.md`

+ 接入【智慧顾问】预约助手接口
1. 接入预约操作接口
2. 接入新增修改详情接口
3. 接入列表与客户校验接口
4. 接入门店与顾问接口
5. 新增门店树选择组件

来源：`03-开发任务.md`  
taro-ui 后面打算废弃，不要再使用了。  
mermaid 语法画流程图

#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：接入预约操作接口；接入预约新增修改详情接口；接入预约列表与客户校验接口；接入门店与顾问接口。

提交明细：

+ `beauty-smart-advisor` `2ed0a39a`：feat(reservationBoard): 接入门店与顾问接口
+ `beauty-smart-advisor` `3700d766`：feat(reservationBoard): 新增门店树选择组件
+ `beauty-smart-advisor` `55c17edb`：feat(reservationBoard): 接入预约新增修改详情接口
+ `beauty-smart-advisor` `a4b015d2`：feat(reservationBoard): 接入预约列表与客户校验接口
+ `beauty-smart-advisor` `cebd6661`：feat(reservationBoard): 接入预约操作接口

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。
+ 工时：待填报。

### 2026-05-12
#### 原始文档记录
来源：`关天豪-每日任务.md`

+ 开发【智慧顾问】预约助手流程
1. 修复周月切换与时间线
2. 新增预约表单编辑流程
3. 新增预约操作底部面板
4. 新增右侧时间轴适配

#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：修复周月日期切换与时间线展示问题；新增预约表单与详情编辑流程；新增预约操作底部面板；新增右侧预约时间轴与看板数据适配。

提交明细：

+ `beauty-smart-advisor` `50e88e73`：feat(reservationBoard): 新增预约表单与详情编辑流程
+ `beauty-smart-advisor` `cdf1f58f`：feat(reservationBoard): 新增预约操作底部面板
+ `beauty-smart-advisor` `e48c2c5a`：feat(reservationBoard): 新增右侧预约时间轴与看板数据适配
+ `beauty-smart-advisor` `f3abe896`：fix(reservationBoard): 修复周月日期切换与时间线展示问题

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。
+ 工时：待填报。

### 2026-05-11
#### 原始文档记录
来源：`关天豪-每日任务.md`

+ 搭建【智慧顾问】预约助手页面
1. 新增顾问横向标签栏
2. 新增周视图日期切换
3. 新增月历与状态筛选
4. 初始化预约助手页面骨架

#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：新增顾问横向滚动标签栏组件；新增周视图快速日期切换条组件；新增月历视图与预约状态筛选组件；初始化预约助手页面骨架。

提交明细：

+ `beauty-smart-advisor` `2766030e`：feat: 初始化预约助手页面骨架
+ `beauty-smart-advisor` `349122f5`：feat(reservationBoard): 新增顾问横向滚动标签栏组件
+ `beauty-smart-advisor` `3cb89ec2`：feat(reservationBoard): 新增月历视图与预约状态筛选组件
+ `beauty-smart-advisor` `720f87ad`：feat(reservationBoard): 新增周视图快速日期切换条组件

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。
+ 工时：待填报。

### 2026-05-09
#### Git 提交归纳
+ beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复。提交依据：预约助手页面开发。
+ homing-miniapp-brand：主包瘦身、分包调整、动态加载优化与构建性能优化。提交依据：优化饮食饼图补绘时机 - 增加饼图分阶段补绘，修复长餐食列表下偶发空白和残影 - 放宽深度 selector 重试次数，提升 canvas 初始化稳定性；使用深度选择器修复饮食饼图渲染 - 采用微信原生 `>>>` 穿透 `shadow-root` 查询 canvas - 为分包 ECharts 增加 `canvasSelector` 透传能力 - 饼图通过 `AnalyseFoodContainer >>> .ec-canvas.xxx` 定位节点 - 删除第一套页面级 Overlay 方案，保留本地 Popup 链路 - 增加轻量兼容测试，防止误恢复旧方案；修复饮食评价饼图渲染异常问题。

提交明细：

+ `beauty-smart-advisor` `aba79b74`：预约助手页面开发
+ `homing-miniapp-brand` `9169ae58`：fix: 优化饮食饼图补绘时机 - 增加饼图分阶段补绘，修复长餐食列表下偶发空白和残影 - 放宽深度 selector 重试次数，提升 canvas 初始化稳定性
+ `homing-miniapp-brand` `e1d41cce`：fix: 修复饮食评价饼图渲染异常问题
+ `homing-miniapp-brand` `f601fbec`：feat: 使用深度选择器修复饮食饼图渲染 - 采用微信原生 `>>>` 穿透 `shadow-root` 查询 canvas - 为分包 ECharts 增加 `canvasSelector` 透传能力 - 饼图通过 `AnalyseFoodContainer >>> .ec-canvas.xxx` 定位节点 - 删除第一套页面级 Overlay 方案，保留本地 Popup 链路 - 增加轻量兼容测试，防止误恢复旧方案

#### 填报建议
+ 任务：beauty-smart-advisor：预约助手功能开发、接口联调、交互样式优化与缺陷修复；homing-miniapp-brand：主包瘦身、分包调整、动态加载优化与构建性能优化。
+ 工时：待填报。

### 2026-05-08
#### Git 提交归纳
+ beauty-smart-advisor：开发与问题修复。提交依据：修复服务进行中居中样式。

提交明细：

+ `beauty-smart-advisor` `dcd7e625`：style: 修复服务进行中居中样式

#### 填报建议
+ 任务：beauty-smart-advisor：开发与问题修复。
+ 工时：待填报。

### 2026-05-07
#### Git 提交归纳
+ homing-miniapp-brand：AI 智能教练产品推荐组件开发、接口联调与 UI 还原。提交依据：修改打卡弹窗高度；使用svg绘制饼图；优化打卡去重；首页完成打卡不显示按钮。

提交明细：

+ `homing-miniapp-brand` `1c4d60e7`：fix: 修复晨间护肤安卓滚动和暂无数据显示问题
+ `homing-miniapp-brand` `348282c0`：fix: 使用svg绘制饼图
+ `homing-miniapp-brand` `a703ad25`：style: 调整产品推荐售价和原价样式
+ `homing-miniapp-brand` `b52d8cbe`：fix: 首页完成打卡不显示按钮
+ `homing-miniapp-brand` `c21f020d`：fix: 修改打卡弹窗高度
+ `homing-miniapp-brand` `fe2c0d94`：chore: 优化打卡去重
+ `homing-miniapp-brand` `febeaefd`：fix: 完成打卡不显示按钮;无按钮增加底部高度

#### 填报建议
+ 任务：homing-miniapp-brand：AI 智能教练产品推荐组件开发、接口联调与 UI 还原。
+ 工时：待填报。

### 2026-05-06
#### Git 提交归纳
+ homing-miniapp-brand：AI 智能教练产品推荐组件开发、接口联调与 UI 还原。提交依据：迁移产品推荐字段并清理无用代码。

提交明细：

+ `homing-miniapp-brand` `1f6f6683`：fix: 迁移产品推荐字段并清理无用代码

#### 填报建议
+ 任务：homing-miniapp-brand：AI 智能教练产品推荐组件开发、接口联调与 UI 还原。
+ 工时：待填报。

### 2026-04-30
#### 原始文档记录
来源：`关天豪-每日任务.md`

+ 优化【智慧顾问】服务中样式
1. 还原空间疗愈设计稿

#### Git 提交归纳
+ beauty-smart-advisor：开发与问题修复。提交依据：服务进行中-空间疗愈显示按UI设计稿还原。

提交明细：

+ `beauty-smart-advisor` `b79e44da`：style: 服务进行中-空间疗愈显示按UI设计稿还原

#### 填报建议
+ 任务：beauty-smart-advisor：开发与问题修复。
+ 工时：待填报。

### 2026-04-29
#### Git 提交归纳
+ homing-miniapp-brand：AI 智能教练产品推荐组件开发、接口联调与 UI 还原。提交依据：产品推荐 UI还原；调整测肤记录-综合得分表格样式优化；样式调整优化。

提交明细：

+ `homing-miniapp-brand` `3ffff978`：style: 调整测肤记录-综合得分表格样式优化
+ `homing-miniapp-brand` `590631f2`：style: 样式调整优化
+ `homing-miniapp-brand` `b13bcf2b`：style: 产品推荐 UI还原

#### 填报建议
+ 任务：homing-miniapp-brand：AI 智能教练产品推荐组件开发、接口联调与 UI 还原。
+ 工时：待填报。

### 2026-04-25
#### Git 提交归纳
+ homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化。提交依据：移除 lunisolar 农历工具库，新增轻量节日标签引擎，优化日程顶部标签样式；优化打卡弹窗打开速度，消除重复请求。

提交明细：

+ `homing-miniapp-brand` `1130b47e`：refactor(Calendar): 移除 lunisolar 农历工具库，新增轻量节日标签引擎，优化日程顶部标签样式
+ `homing-miniapp-brand` `2977f879`：refactor(BottomSheet): 优化打卡弹窗打开速度，消除重复请求

#### 填报建议
+ 任务：homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化。
+ 工时：待填报。

### 2026-04-24
#### Git 提交归纳
+ homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化。提交依据：BottomSheet组件按职责拆分重构；修复BottomSheet弹窗组件显示问题。

提交明细：

+ `homing-miniapp-brand` `5ef2605f`：fix: 修复BottomSheet弹窗组件显示问题
+ `homing-miniapp-brand` `cc2c63c9`：refactor: BottomSheet组件按职责拆分重构

#### 填报建议
+ 任务：homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化。
+ 工时：待填报。

### 2026-04-23
#### Git 提交归纳
+ homing-miniapp-brand：主包瘦身、分包调整、动态加载优化与构建性能优化。提交依据：新增 git 快速指南；新增主包瘦身实战教程；新增主包拆分优化实施报告；重写 splitChunks 与 addChunkPages，主包瘦身核心配置。

提交明细：

+ `homing-miniapp-brand` `18836598`：refactor(subPackage): 子包侧 echarts 消费方切到 @/components/echarts-taro3-react
+ `homing-miniapp-brand` `206c58f7`：docs: 新增主包拆分优化实施报告
+ `homing-miniapp-brand` `25916082`：fix: 新增 lunisolar 农历工具库并修复日历文案显示问题
+ `homing-miniapp-brand` `37492e55`：chore(build): 开启 webpack 持久化缓存以加速本地构建
+ `homing-miniapp-brand` `4582a28b`：refactor(pages/mine, subPackage/memberBenefits): GradeCard 导入切到 @/components/gradeCard
+ `homing-miniapp-brand` `4d402549`：feat(app.config): 声明 commonPackage 分包并重构 preloadRule 指向它
+ `homing-miniapp-brand` `59593a59`：feat: 优化BottomSheet弹窗组件
+ `homing-miniapp-brand` `5d9e0786`：docs: 新增 git 快速指南
+ `homing-miniapp-brand` `68319e2e`：refactor(components): gradeCard 上移到 src/components，原位置保留 re-export
+ `homing-miniapp-brand` `72c87f1a`：chore(package): 新增 analyze:weapp 脚本
+ `homing-miniapp-brand` `8019536d`：perf(markdownPreview): markdown-it 动态加载，让大库脱离主包同步链
+ `homing-miniapp-brand` `80519ed4`：chore(gitignore): 忽略 bundle 分析产物 (bundle-report.html / bundle-stats.json)
+ `homing-miniapp-brand` `8de71464`：refactor(utils): 抽取 bleTenant 工具，消除 home 页对 bleDevicePackage 跨包依赖
+ `homing-miniapp-brand` `8e36692f`：refactor(A2UI, pages/aiCoach): 主包侧 echarts 消费方切到 @/components/echarts-taro3-react
+ `homing-miniapp-brand` `9d2fafd9`：perf(pagView): libpag-lite-miniprogram 动态加载
+ `homing-miniapp-brand` `a63e3a0b`：chore(script): 新增 analyze-main-bundle.js 用于 chunk 归因分析
+ `homing-miniapp-brand` `a8fd61a4`：refactor(echarts-taro3-react): subPackage 原位 re-export，主包版本轻微格式调整
+ `homing-miniapp-brand` `ad286a68`：perf(rum): aegis-mp-sdk 仅在生产环境按需动态 import
+ `homing-miniapp-brand` `b54bc0d7`：perf(userAgreement): HtmlRenderer + html2tree 动态加载，摘除主包 htmlparser2 依赖
+ `homing-miniapp-brand` `bb679b04`：perf(build): 重写 splitChunks 与 addChunkPages，主包瘦身核心配置
+ `homing-miniapp-brand` `d2a5c3d8`：refactor(utils): handleToken 独立成文件，阻断 utils/index.ts 副作用连坐
+ `homing-miniapp-brand` `d8cff594`：perf(progressivePhotoBox): photoswipe 动态加载
+ `homing-miniapp-brand` `da14c78e`：refactor(components): storeCard 上移到 src/components 并切换 mall/experience 引用
+ `homing-miniapp-brand` `db8d7b0c`：docs: 新增主包瘦身实战教程
+ `homing-miniapp-brand` `e6cbb4ab`：feat(commonPackage): 新增 commonPackage 分包占位页

#### 填报建议
+ 任务：homing-miniapp-brand：主包瘦身、分包调整、动态加载优化与构建性能优化。
+ 工时：待填报。

### 2026-04-22
#### Git 提交归纳
+ homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化。提交依据：日历样式修改；新增AI智能教练滚动恢复hook。

提交明细：

+ `homing-miniapp-brand` `77dcfcde`：feat: 新增AI智能教练滚动恢复hook
+ `homing-miniapp-brand` `d50ad6a7`：fix: 日历样式修改

#### 填报建议
+ 任务：homing-miniapp-brand：AI 智能教练组件交互、图表渲染、打卡与测肤相关体验优化。
+ 工时：待填报。

### 2026-04-21
#### Git 提交归纳
+ homing-miniapp-brand：AI 智能教练产品推荐组件开发、接口联调与 UI 还原。提交依据：产品推荐样式调整；优化产品推荐的左侧导航条样式；产品推荐 UI优化以及接口联调；统一 writeId 配置写入格式，减少后续无效变更。

提交明细：

+ `homing-miniapp-brand` `525dfdf2`：style: 产品推荐样式调整
+ `homing-miniapp-brand` `8d75e783`：feat: 产品推荐 UI优化以及接口联调
+ `homing-miniapp-brand` `97cbe36f`：style: 优化产品推荐的左侧导航条样式
+ `homing-miniapp-brand` `f4541937`：feat: 完善产品推荐组件UI设计以及部分字段联调
+ `homing-miniapp-brand` `f80ed85d`：chore: 统一 writeId 配置写入格式，减少后续无效变更

#### 填报建议
+ 任务：homing-miniapp-brand：AI 智能教练产品推荐组件开发、接口联调与 UI 还原。
+ 工时：待填报。

### 2026-04-20
#### Git 提交归纳
+ homing-miniapp-brand：AI 智能教练产品推荐组件开发、接口联调与 UI 还原。提交依据：保留本地开发配置；保留 ProductRecommendPreview 本地自测链路。

提交明细：

+ `homing-miniapp-brand` `2b0540d1`：chore: 保留 ProductRecommendPreview 本地自测链路
+ `homing-miniapp-brand` `9a9c5cca`：chore: 保留本地开发配置

#### 填报建议
+ 任务：homing-miniapp-brand：AI 智能教练产品推荐组件开发、接口联调与 UI 还原。
+ 工时：待填报。

### 2026-04-18
#### Git 提交归纳
+ homing-miniapp-brand：AI 智能教练产品推荐组件开发、接口联调与 UI 还原。提交依据：迁移ProductRecommend到A2UI。

提交明细：

+ `homing-miniapp-brand` `8899fb5b`：feat: 迁移ProductRecommend到A2UI

#### 填报建议
+ 任务：homing-miniapp-brand：AI 智能教练产品推荐组件开发、接口联调与 UI 还原。
+ 工时：待填报。

### 2026-04-17
#### Git 提交归纳
+ homing-miniapp-brand：AI 智能教练产品推荐组件开发、接口联调与 UI 还原。提交依据：新增产品推荐组件并补充接口定义。

提交明细：

+ `homing-miniapp-brand` `13301df3`：feat: 新增产品推荐组件并补充接口定义

#### 填报建议
+ 任务：homing-miniapp-brand：AI 智能教练产品推荐组件开发、接口联调与 UI 还原。
+ 工时：待填报。

### 2026-04-16
#### 原始文档记录
来源：`03-开发任务.md`  
node版本  
16.20.2  
本地安装  
npm install --legacy-peer-deps  
通过查看 config\dev.js 发现本地运行的是 test 环境  
所以本地跑 test环境  
npm run dev:weapp:itest



#### 填报建议
+ 任务：按原始文档记录填报。
+ 工时：待填报。



