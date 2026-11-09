<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# 哔哩哔哩

一个可独立安装、更新和卸载的多命令插件。保留原插件 ID `maka.web.bilibili`，
更新原「B站搜索」即可，不会出现两份安装记录。

| 命令 | 实现 |
| --- | --- |
| 打开首页 | Quicklink 模板 → `https://www.bilibili.com/` |
| 打开动态 | Quicklink 模板 → `https://t.bilibili.com/` |
| 打开我的个人空间 | BrowserMCP `bilibili/me` 识别当前登录账号，Quicklink 模板 → `https://space.bilibili.com/{uid}` |
| 打开稍后再看 | Quicklink 模板 → `https://www.bilibili.com/watchlater/#/list` |
| 搜索视频 | BrowserMCP / OpenCLI `bilibili/search`, `type: video` |
| 搜索 UP 主 | 同一适配器，`type: user`；回车通过 UID 打开该 UP 主空间 |

主页可搜索各条命令；进入「哔哩哔哩」可查看完整列表。输入 `bili 关键词` 会生成
视频与 UP 主两种搜索选项，回车后才请求网站。视频和 UP 主搜索各自保留当前关键词、
结果及页码。每次打开我的空间时重新识别已连接 Chrome 的当前账号，不缓存 UID，也不再读取旧的手动 UID。未登录或连接失败时提供重试、首页登录和连接入口。

跳转复用 `../links/template.ts` 的 `expandTemplate`，不复制 Quicklink 解析器，
不向用户的 Quicklink 集合写入重复条目。搜索和识别当前账号需要现有 BrowserMCP 连接，
首页、动态、稍后再看不启动 BrowserMCP。没有额外的插件类型或安装流程。

## 收藏夹与观看历史

- 「B站收藏夹」列出当前账号创建的全部收藏夹，输入名称筛选；进入收藏夹后输入关键词并回车，搜索该收藏夹中的视频。
- 「B站观看历史」按最近观看排序，输入关键词并回车搜索历史。两者支持下一页、刷新，选中视频回车打开。
- 每次读取验证当前账号，切换账号会丢弃旧结果及收藏夹选择。收藏和历史数据只存于插件进程内存，不写入插件存储。
- 使用 BrowserMCP 的登录页面上下文读取 B站固定 GET 接口。Manifest 的 `web.commands[].request` 声明固定 HTTPS origin/path 和允许的查询参数，宿主只执行 GET，不接受插件提供的浏览器脚本、请求头或任意地址；临时标签页在请求结束时关闭。
- 该版本需要支持声明式 `request` 的 Maka 宿主；旧宿主会拒绝新 manifest，不能静默降级为读取错误账号。

历史搜索参数对照 B站自身前端 `https://s1.hdslb.com/bfs/static/shanks/history-record/assets/index-d270e984.js`（2026-11-06）：`pn`, `keyword`, `business=archive`，响应使用 `list` 与 `has_more`。历史浏览使用 cursor 接口 `type=archive`。
