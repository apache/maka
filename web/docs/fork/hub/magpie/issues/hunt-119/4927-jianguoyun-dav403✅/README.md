# #4927 坚果云 WebDAV 同步失败（"write in /dav (HTTP 403)"）— 车道 E 交付件

2026-11-03。判定可修（patch 路线），已发布。

## 判定

错误文案是 magpie 自产（`internal/davsync/dav.go` `forbidden()`）。403 文案的 2xx 分支
把"PROPFIND 地址目录（/dav）可列"当成"账号不可写 /dav"的证据，但被拒的写一直在
`/dav/magpie/magpie.magpie-backup`，且从未探测过 magpie 子文件夹的存在性。坚果云真实诱因
（Zotero 论坛一手证据 https://forums.zotero.org/discussion/102989/ ）：免费版上传流量超额时
PUT 被 403 拒绝（升级或等重置），其余一切正常——旧文案让用户去检查一个检查不了的东西。

## 修法（6a08e932f，基 a3768cdd1）

`forbidden()` 2xx 分支用既有 `there(folder)` 探测 magpie 子文件夹，区分：
- 文件夹在、写被拒 → "change files in /dav/magpie (HTTP 403): ... and the account's storage quota is not used up"
- 文件夹缺、建被拒 → "doesn't let magpie make its folder /dav/magpie (HTTP 403): make the folder magpie there first, or put an existing folder in the address"

行为零变化：同步路径请求数不变；额外 PROPFIND 只发生在 403 已是终态时。
9163c360f = RED 测试提交（消融基），6a08e932f = 修复。

## 验证

- 新 TestDAVWriteRefused：修前红（复现截图原文 "write in /dav (HTTP 403)"）、修后绿、
  单回退 dav.go 回红（消融）；TestDAVForbidden /ro case 同步更新（文案随行为）。
- davsync 全量 `-tags nogui` 绿（46.9s）；backup 绿；cli 有预存红
  （TestEveryRouteHasACommandOrIsNamed / POST /api/usage/checkin-account，基线 a3768cdd1 同红）。
- gofmt 绿；vet darwin/linux/windows 绿；build darwin/windows 绿，linux 交叉编译
  预存红（wails v3 `undefined: pointer`，基线同红）。

## 发布

- take：comment-6582118691
- 诊断+patch 帖（patch 内联 `git am` 格式）：comment-6582641663，GET 回读闭环
- fork 分支：ggbdpq/magpie fix/4927-jianguoyun-dav403（tip 6a08e932f，ls-remote 核实）
- 不自信项：无本机坚果云账号，坚果云超额→403 的行为依据是 Zotero 论坛一手用户报告；
  修复对三种诱因（超额/权限/拒建目录）给出的是更准的指引而非行为改变，不依赖该归因成立。
