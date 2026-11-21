# 5575 r2（维护者 review 回炉，2026-11-08 发布）

- issue: yetone/magpie#5575（报告者 Buffnada）；维护者末评 6708733366（两处修改）
- head: `180a1106ee52e002c7d19d76d11a5687214c75ea`（fork 分支 `fix/5575-unstreamed-speed-r2`，base=upstream/main `46b10af87`）
- patch sha256 前16: `be46f4d56044030b`；干净 tip 检出 git am 树对比 byte-identical
- 帖: https://github.com/yetone/magpie/issues/5575#issuecomment-6712363157（GET 回读过，35929 字节）
- 修法：review 点1 = routing/client.js "fast" 分支收 told pace（lateTtft||lateTps），整段口径文案 "{n} tokens a second over the whole reply" + i18n 四语言新键；review 点2 = speed.go 分记（speedRec 第三组 whole/wholeW/wholeAt 样本，与流式 decode 平均分开），speedOf 优先流式口径、无新鲜流式样本才落 whole；fastest.go `s.TTFT>0 || s.TPS>0`（原 patch 行保留）
- 两 RED：①cjs 两场景×5语言 10 红（actual="none has answered…first in the list"/"hasn't answered…to be measured"）②TestAStreamedPaceIsntDilutedByAnUnstreamedOne 红（diluted 59.31 want 100，原 patch 树上）
- 消融回红四变异：client.js 口径行→GUI 10 红；分记行混算→diluted 红；speedOf whole 兜底→told no pace 红；fastest 测量判定→两 case 红（各 git diff --stat 复证）
- 矩阵：gateway 全包 nogui 40m ok 1003.8s 零失败；routes/usage 全包绿；速度组 count=5 绿；定向 race 绿；gofmt/vet×3/build×3 净；GUI 60/60（chromium+webkit×5语言）；i18n-keys 3 过 1 预存红（父提交对照同红）
- 未验证：报告者自己的 key 池与模型（用整段应答的替身 vendor 端到端验证）
