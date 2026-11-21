# CubeSeller (魔方卖家助手)

**原始名称**: CubeSeller | **商店版本**: 11.1.5 | **Manifest**: V3 | **扩展 ID**: ddicoofdkbcdkkeecgafcoabogcgicfp

## 功能概述

CubeSeller 是一款面向电商卖家的 Chrome 扩展, 支持从 65+ 主流电商和内容平台的商品详情页批量提取图片、视频和评论内容。

核心功能:
- 商品主图、SKU 图、详情图的一键提取和分类展示
- 商品视频批量下载
- 评论图片 (买家秀) 采集 (支持分页)
- 图片打包下载 (JSZip ZIP 打包)
- 图片翻译 (OCR + 多语言翻译, 通过 ushangtech.com)
- 批量抠图 (背景移除, 通过 ushangtech.com)
- 文件重命名、排序 (自动/大图优先/小图优先)
- 自定义提取规则配置

## 技术架构

- **框架**: Vue 3.5.27 + Element Plus Icons 2.3.2
- **打包器**: Webpack
- **ZIP 打包**: JSZip 3.10.1
- **规则引擎**: 配置驱动的 CSS 选择器提取规则 (JSON 配置, 65+ 平台)
- **Content Script ISOLATED world**: Vue 3 提取面板 + DOM 抓取引擎
- **MAIN world bridge**: `windowDataMessage.js` 安全提取页面 JS 变量
- **Background proxy**: 跨域图片抓取 (fetch blob → base64) + Cookie 管理 + DNR Referer 伪造
- **本地客户端**: 配套桌面应用 `192.168.1.105:3100` (魔方卖家助手)

## 权限

`scripting`, `activeTab`, `downloads`, `declarativeNetRequest`, `storage`, `cookies`, `unlimitedStorage` + `*://*/*` host

## 安全等级: HIGH

主要风险: `cookies` 权限 + `*://*/*` 范围可读取任意网站 HttpOnly Cookie; 电商数据批量采集存在版权和合规风险; DNR Referer 伪造绕过 CDN 防盗链。

## 支持平台

1688、淘宝、天猫、京东、拼多多、苏宁易购、唯品会、考拉海购、小红书、抖音、Shopee、Lazada、Alibaba、Aliexpress、Amazon、Wish、Shein、Temu、Etsy、Coupang、Farfetch、Instagram、Pinterest、Google Images、Bing Images、百度图片、微博、微信公众平台、Pixiv 等 65+ 个平台。

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 11.1.5 | 2026-07-06 | DeepSeek V4 Pro | [2026-07-06-dsv4/](2026-07-06-dsv4/) |
