# linkpull

给一个链接：**文章导出 Markdown，视频按清晰度下载**。单二进制，Windows/macOS/Linux 通用，附本机单页 GUI。

```
linkpull https://www.bilibili.com/video/BVxxxx -q 1080     # B站视频
linkpull https://www.bilibili.com/video/BVxxxx -p all      # 多P 全下
linkpull "https://space.bilibili.com/xxx/lists/123?type=series"   # 合集/系列批量
linkpull https://www.bilibili.com/read/cvxxxx              # B站专栏 → article.md + images/
linkpull https://www.youtube.com/playlist?list=PLxxxx      # 播放列表批量
linkpull https://www.youtube.com/watch?v=xxxx --info       # 列出清晰度
linkpull https://x.com/user/status/123 -q 2                # 推特视频
linkpull https://go.dev/blog/xxx                           # 任意文章网页 → Markdown

linkpull login bilibili    # 终端扫码登录，cookie 自动生效（解锁 1080P+/4K）
linkpull serve             # 本机 GUI：http://127.0.0.1:8765
```

## 支持范围

| 平台 | 路线 | 说明 |
|---|---|---|
| 哔哩哔哩 | 纯 Go（WBI 签名 + DASH API） | 视频（多清晰度/弹幕 XML+ASS/封面）、专栏、合集/系列批量、多P、b23.tv 短链；**未登录最高 480P**，扫码登录解锁 |
| YouTube | yt-dlp 外挂适配器 | 视频与播放列表批量；走代理 |
| Twitter/X | fxtwitter API 为主 + yt-dlp 兜底 | 视频推文多分辨率；文字/图片推文导出 Markdown；走代理 |
| 抖音 | yt-dlp 适配器 | **需在 config.yaml 配 `cookies.douyin`**（浏览器导出的 fresh cookies 即可，无需登录）；签名对抗由 yt-dlp 社区维护，坏则如实报错 |
| 任意网页 | readability 正文抽取 | 兜底路线，正文转 Markdown（图片可本地化） |

代理按平台自动分流：B站/抖音强制直连，YouTube/Twitter/网页走 `.env` 里的代理。

## 安装依赖

- **ffmpeg**（B站音视频合成、mp3 转码必需）：`winget install Gyan.FFmpeg`
- **yt-dlp**（仅 YouTube/推特兜底需要）：`winget install yt-dlp.yt-dlp`

缺失时启动自检会给出上述提示，不会自动下载。

## 配置

`.env`（代理，参考 `.env.example`）：

```
HTTPS_PROXY=http://127.0.0.1:7897
```

`config.yaml`（复制 `config.yaml.example`，可选）：

```yaml
output_root: downloads
quality: best            # 默认清晰度
codec: h264              # h264 | hevc | av1
cookies:
  bilibili: E:/path/cookies.txt   # Netscape 格式，B站 1080P+ 需要
```

cookie 查找顺序：`--cookie-file` > `config.yaml` 的 `cookies.<平台>`。

## flags

```
-q string          清晰度：--info 列表中的序号或标签（默认最高）
--info             只列出可选清晰度，不下载
-a                 仅下载音频（--audio-format m4a|mp3）
--codec s          编码偏好 h264|hevc|av1
-p all             多P 视频下载全部分P
-o dir             输出根目录（默认 downloads）
--cookie-file f    Netscape cookie 文件
--images mode      文章图片 local|remote（默认 local）
--force            已存在也重新下载
--as-article       跳过平台 extractor，按通用文章抽取
--proxy url        代理覆盖
```

## 输出结构

```
downloads/<平台>/<作者>/<标题>/
  ├─ 标题.mp4 / 标题.m4a | .mp3
  ├─ danmaku.xml    # B站弹幕归档（标准 XML）
  ├─ danmaku.ass    # 同一份弹幕转好的 ASS 字幕，播放器直接挂载
  ├─ cover.jpg
  ├─ article.md     # 文章（含图片相对路径）
  ├─ images/        # 文章图片（--images local 时）
  └─ info.json
```

## GUI

`linkpull serve` 后浏览器打开 http://127.0.0.1:8765：贴链接 → 探测 → 选清晰度 → 下载，任务进度秒级轮询，批量任务逐项显示进度。仅监听本机，无鉴权。

## Chrome 剪藏插件

`extension/` 目录是配套的浏览器剪藏器（依赖 serve 在跑）：

1. Chrome 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选本仓库的 `extension/` 目录；
2. 右键菜单三连：**剪藏此链接 / 剪藏选中文字 / 剪藏整页文章**（可打标签）；工具栏 popup 里有同样的按钮、标签输入、最近 20 条剪藏清单和「导出全部（zip）」。

剪藏落盘在 `downloads/clips/<域名>/`，与下载同一套 Markdown + 图片本地化管线；单篇与整包（zip）均可从插件一键导出。

**SPA 动态页**：整页剪藏由插件上报**已渲染 DOM** 给 serve 抽取，JS 渲染的页面（小红书/公众号等）与静态页同质量；未装插件时 serve 直连抓取，正文实在抽不到自动降级为链接卡片。

## 收藏库

GUI 的「📚 收藏库」页是所有剪藏的整理台：

- **全文搜索**：标题/URL/标签/正文（磁盘 Markdown 直接遍历，文件即索引）；
- **标签**：剪藏时打标，随时改（条目上「改标签」），按标签过滤；
- **批量导入**：粘贴多行 URL 自动逐条剪藏，已在库的自动跳过，失败降级链接卡片；
- **重复检测**：同 URL 重复剪藏会提示，可选择强制重剪；
- 单篇删除（连文件）与整包 zip 导出。

## 排错

- **B站 `-509 请求过于频繁` / `-352 风控`**：稍后再试，或扫码登录后重试（未登录触发更频繁）。
- **B站 480P 封顶**：游客上限如此，`linkpull login bilibili` 解锁。
- **抖音报 fresh cookies**：浏览器登录/打开过抖音后导出 cookies（ Netscape 格式）填入 `cookies.douyin`，无需登录态，够"新鲜"即可。
- **YouTube/推特报 DNS 或网络错误**：检查 `.env` 代理是否活着。
- **平台改版排查**：B站专栏路径支持 `LINKPULL_DEBUG=1` 转储响应结构。

## 开发

```bash
go build -o linkpull.exe ./cmd/linkpull
go test ./...
go vet ./...
```

架构：`internal/core`（模型与 extractor 契约）→ `internal/extract/*`（平台适配，互不可见，坏一个不连坐）→ `internal/app`（CLI/GUI 共用编排层：探测→下载→批量展开）→ `internal/media`（下载管线/ffmpeg）+ `internal/article`（文章管线）+ `internal/danmaku`（XML→ASS）+ `internal/server`（GUI）。外部进程一律经 `internal/proc` 以 argv 数组调用（不经 shell）。URL 统一经 SSRF 守卫（拒绝内网/保留地址）。
