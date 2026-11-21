# #5530 验证纪要（车道 M5，2026-11-07，判定帖出口）

- 单：yetone/magpie#5530「[Performance] 0.1.3117: WebContent 仍持有 1133 MB graphics 离屏缓冲（335 块大 backing store），窗口隐藏后不释放」——OPEN，c=1（维护者末评：部分修复 v0.1.3188=54dc257f1，等报告者报页面名/Retina 信息）
- 处置：**判定帖出口**（性能单纪律 #4893：先跑基线再判定；实为 GUI/资源面非网关代码缺陷，无可证明的 patch）
- take 帖 6694293063；判定帖 6694614944（GET 回读 OK，len 2862）
- worktree /private/tmp/mg-5530（GOCACHE=/tmp/mg-5530-gocache，分支 fix/5530-webcontent-graphics，基线 542ee03b4 含 54dc257f1；无代码改动，无提交）

## GUI 实测（Retina 基线，数字带环境）

- 环境：本机 darwin arm64，Built-in Liquid Retina XDR 3024×1964（2x）；`make build`（production tag）@542ee03b4；临时 HOME 注入真实 providers.json + models.json（235 providers/8938 模型）+ sessions.json；窗口调至报告者尺寸 1470×820，Providers tab
- 显示态：main WebContent graphics **7.9 MB/86 regions**、panel **16 MB/122 regions**——比报告者 1133 MB 低两个数量级（页面形态不同：我的 HOME 无 600 行清单）
- 隐藏/红点关闭后：未见大幅释放（页面仅 13–16 个 CALayerRemote，可释放量本就小；main/panel 归属未严格判别，不作 sleep 失效断言）

## 三个核心判定

1. **页面定位（答维护者悬着的「which page」）**：models.dev catalog 唯一 ≥600 模型的 provider=**nano-gpt（636，当前快照；报告者快照 608）**。报告者三计数同时吻合：608 行≈608 SVG（行 logo）、×7 div≈4315 div、×2.4 button≈1445 button。608 行≈22k px 单列@2x，全宽 tile≈6 MB/块 → 335 块/1133 MB 量级自洽=该清单无虚拟滚动整幅绘制。
2. **699 常驻 KeyframeEffect 来源**：app.js `sheet()`（行展开滑出动画）的 per-child WAAPI：`for (const c of box.children) c.animate(…, { fill: "backwards" })`——展开该 provider 即同时起 ~608 个 WAAPI 动画；finished 后对象可 GC，但 effect 记录挂在合成器未释放的层上（与 699 BlendingKeyframe/3322 CubicBezier 同源）。仅 69 个 CSSAnimation 在跑=sheet 自身高度动画。
3. **fill-mode 复发推测排除**：当前 `internal/gui/assets` 零独立 `animation-fill-mode`（仅 3 处简写关键字：1 both、2 backwards）——v0.1.1164 形态未回归，当代形态是上述 per-child WAAPI+无虚拟滚动长清单。

## PATCH 出口否决理由

- 虚拟滚动=产品级前端改动（报告者建议二），超出狩猎单范围
- sheet() children 动画 onfinish cancel：释放量取决于层回收，测试环境复现不出 600 行清单页面，无法用数字证明——不做不可证明的 patch
- 「隐藏不释放」半壁已被维护者 v0.1.3188 交付；大列表释放回放需真实安装环境展开 600 行 provider——留给报告者/维护者在真机上跑

## 环境清理

测试实例已杀净（pgrep=0）；临时 HOME（含用户 providers.json/缓存副本）已删；构建二进制保留于 /private/tmp/mg-5530/magpie；无 fork push（无代码改动）。
