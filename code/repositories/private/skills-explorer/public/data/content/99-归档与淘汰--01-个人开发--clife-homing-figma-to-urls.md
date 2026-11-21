---
name: clife-homing-figma-to-urls
description: Use when Figma nodes, local SVG/PNG cuts, serviceComplete icons, assetUrls.ts, or 鸿溟美业 Tencent COS CDN URLs are needed for beauty-smart-advisor. Trigger for Figma 图标/图片导出、原格式 COS 上传、homing/ui/0、HOMING_TOKEN、FIGMA_TOKEN、ImageWebp URL 常量。
---

# Clife Homing Figma 转图片 URL

核心：把 Figma 节点或本地切图变成鸿溟美业 COS URL，并写成 TypeScript 常量。本地 SVG/PNG 按原格式上传；Figma 默认导出 PNG，需要 SVG/JPEG 时显式传 `--format svg` / `--format jpeg`。页面结构、样式、`ImageWebp` 消费方式交给 `clife-homing-figma-to-page`。

## 决策表

| 输入                                                    | 产物                        | 做法                                                                       |
| ------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------- |
| Figma URL / node-id + `FIGMA_TOKEN` + `HOMING_TOKEN`    | CDN URL + `assetUrls.ts`    | 运行 `scripts/figma-to-cos.mjs`，默认 PNG，SVG/JPEG 传 `--format svg/jpeg` |
| 本地 `.svg/.png/.jpg/.jpeg/.webp` 切图 + `HOMING_TOKEN` | 原格式 CDN URL + 可复制常量 | 运行 `scripts/upload-homing-cos.mjs --dir`                                 |
| 已有 CDN URL，只要写常量                                | `assetUrls.ts`              | 直接编辑目标 TS 文件，然后用 format skill 收敛                             |
| 只在做页面还原，没有上传/切图需求                       | 无                          | 转到 `clife-homing-figma-to-page`                                          |

调试 COS 签名、临时密钥、Key 规则、域名替换时，读 [reference.md](reference.md)。只做普通上传时先跑脚本，不展开 reference。

## 命令模板

从仓库根目录运行，脚本目录零安装，依赖 Node 内置能力和运行时按需缓存：

```powershell
cd E:\Projects\frontend\beauty-smart-advisor
$env:HOMING_TOKEN = 'TOKEN'
$env:FIGMA_TOKEN = 'figd_TOKEN'
node "$env:USERPROFILE\.agents\skills\clife-homing-figma-to-urls\scripts\figma-to-cos.mjs" `
  --url "https://www.figma.com/design/FILE_KEY/name?node-id=6323-2788" `
  --const-prefix SERVICE_COMPLETE
```

多个节点：

```powershell
node "$env:USERPROFILE\.agents\skills\clife-homing-figma-to-urls\scripts\figma-to-cos.mjs" `
  --url "https://www.figma.com/design/FILE_KEY/name" `
  --ids "6323:2788,6323:2944" `
  --const-prefix SERVICE_COMPLETE
```

Figma SVG / JPEG：

```powershell
node "$env:USERPROFILE\.agents\skills\clife-homing-figma-to-urls\scripts\figma-to-cos.mjs" `
  --url "https://www.figma.com/design/FILE_KEY/name?node-id=6323-2788" `
  --format svg `
  --const-prefix SERVICE_COMPLETE

node "$env:USERPROFILE\.agents\skills\clife-homing-figma-to-urls\scripts\figma-to-cos.mjs" `
  --url "https://www.figma.com/design/FILE_KEY/name?node-id=6323-2788" `
  --format jpeg `
  --const-prefix SERVICE_COMPLETE
```

本地切图：

```powershell
node "$env:USERPROFILE\.agents\skills\clife-homing-figma-to-urls\scripts\upload-homing-cos.mjs" `
  --dir "E:\path\to\assets" `
  --prefix homing/ui/0
```

## 输出位置

默认把 URL 常量写入：

```text
src/pages/serviceComplete/constants/assetUrls.ts
```

命名用业务语义，不用 Figma 自动图层名。输出后检查：

- URL host 是 `https://meiye.cos.clife.cn/`。
- Key 在 `homing/ui/0/` 下。
- 常量名能被页面组件直接理解。
- 没把 Figma 短时下载地址写进源码。

## 配置和凭证

- 真实 token/密钥优先用环境变量：`HOMING_TOKEN`、`FIGMA_TOKEN`、`COS_BUCKET`、`COS_REGION` 等。
- `.env.example` 是模板；本地 `.env` 只作临时配置，交付说明不回显完整凭证。
- 优先用 `HOMING_TOKEN` 拉临时密钥；拿不到 token 时，才用本地兜底密钥做脚本验证。
- 脚本目录里不安装依赖、不保留 `node_modules`；本地 SVG、PNG 等资源按原始格式上传。

## 项目事实

| 项           | 当前值                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| 临时密钥接口 | `GET {TENCENT_COS_TEMP_KEY_URL}`，Header `token`                                                               |
| 默认测试域名 | `https://itest.clife.net`                                                                                      |
| Bucket       | `meiye-1323116912`                                                                                             |
| Region       | `ap-guangzhou`                                                                                                 |
| 公网域名     | `meiye.cos.clife.cn`                                                                                           |
| 图片前缀     | `homing/ui/0`                                                                                                  |
| 默认格式     | Figma 默认 PNG，`scale=2`；传 `--format svg` 保留 SVG，传 `--format jpeg/jpg` 生成 JPG；本地上传保留文件扩展名 |

v1.7.1 服务报告画板：38=`6323:2788`，39=`6323:2944`，40 需要点选 Layers 确认；父节点 `6122:3167` 是整页画布，不作为图标上传。

## 高价值反模式

| 反模式                                    | 代价                               | 正确做法                                 |
| ----------------------------------------- | ---------------------------------- | ---------------------------------------- |
| 把 Figma `images[id]` 短时 URL 当生产地址 | 链接会过期                         | 下载后立即直传 COS                       |
| 为上传流程执行 `npm install`              | skill 目录膨胀且污染运行环境       | 直接跑内置脚本                           |
| 强制把 SVG 栅格化成 PNG                   | 黑金模式等主题图标失去矢量适配能力 | 上传时保留源格式，页面消费前确认组件兼容 |
| 把 COS 组合数据写回后台列表               | 会修改配置记录，超出取 URL 的目的  | 默认只返回 CDN URL                       |
| 在页面里写死 URL 或 Figma 图层名          | 后续替换和审查困难                 | 统一写入 `assetUrls.ts`                  |

## 交付格式

交付时给出：节点来源、生成的常量名、CDN URL、写入文件、验证命令和失败项。凭证只报变量名，不报真实值。
