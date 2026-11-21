# 🚀 快速启动指南

## 立即在 Chrome 中运行扩展

### 方法 1: 加载扩展（推荐）

1. **打开 Chrome 扩展页面**
   ```
   chrome://extensions/
   ```

2. **启用开发者模式**
   - 在右上角找到"开发者模式"开关
   - 点击开启

3. **加载扩展**
   - 点击"加载已解压的扩展程序"按钮
   - 文件选择器中导航到：
     ```
     /Users/ggbdpq/cc/test/x-track-by-cc-with-GLM-4.7/dist/
     ```
   - 选择此文件夹并点击"选择文件夹"

4. **验证安装**
   - 在扩展列表中看到"X-Track by CC with GLM-4.7"
   - 状态显示"已启用"

### 方法 2: 使用命令行（高级用户）

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --load-extension=/Users/ggbdpq/cc/test/x-track-by-cc-with-GLM-4.7/dist/

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --load-extension="C:\Users\ggbdpq\cc\test\x-track-by-cc-with-GLM-4.7\dist"

# Linux
google-chrome --load-extension=/Users/ggbdpq/cc/test/x-track-by-cc-with-GLM-4.7/dist/
```

## 测试扩展

### 1. 基础功能测试

1. **访问 Twitter/X**
   ```
   https://x.com
   ```

2. **打开开发者工具**（按 F12）

3. **检查控制台**
   - 应该看到：`X-Track: Content script loaded`
   - 应该看到：`X-Track: Injected network interceptor`

4. **滚动页面**
   - 查看控制台是否有浏览追踪日志
   - 格式：`X-Track: Tweet entered view: <推文ID>`

### 2. 数据验证

1. **打开开发者工具**
   - 按 F12 或右键 → "检查"

2. **转到 Application 标签**
   - 左侧找到"Storage"
   - 展开"IndexedDB"
   - 点击"xtrack_db"

3. **查看数据库**
   - 应该看到以下表：
     - `tweets` - 推文数据
     - `users` - 用户数据
     - `history` - 浏览历史
     - `bookmarks` - 书签
     - `likes` - 点赞
     - `myTweets` - 用户推文

### 3. 抓取功能测试

1. **访问用户主页**
   ```
   https://x.com/<用户名>
   ```

2. **查找浮动按钮**
   - 应该在右下角看到一个蓝色按钮
   - 显示"Start Scraping"

3. **点击按钮开始抓取**
   - 按钮变为红色，显示"Stop Scraping"
   - 控制台显示抓取进度

4. **检查数据**
   - 在 IndexedDB 中查看 `tweets` 表
   - 应该看到新抓取的推文

## 功能清单

### ✅ 已实现的功能

- [x] 网络拦截（8 个 API 端点）
- [x] 推文缓存（LRU, 5 分钟 TTL）
- [x] 浏览追踪（IntersectionObserver）
- [x] 智能抓取（手动/自动模式）
- [x] 数据存储（IndexedDB）
- [x] 浮动 UI（Profile/Bookmarks/Likes 页面）
- [x] 数据导出（JSON/CSV）
- [x] 国际化支持（英文/中文）

### 📊 数据收集

扩展会收集：
- 推文内容、作者、媒体
- 浏览时长和类型
- 书签和点赞
- 用户发布的推文

**注意**: 所有数据仅存储在本地，不会上传到任何服务器。

## 故障排除

### 扩展无法加载

**问题**: "扩展程序清单无效"

**解决方案**:
1. 确保加载的是 `dist/` 目录，不是项目根目录
2. 检查 `dist/manifest.json` 是否存在
3. 查看错误信息中的具体提示

### 功能不工作

**问题**: 扩展已加载但功能不工作

**解决方案**:
1. 刷新 Twitter 页面（F5）
2. 检查控制台是否有错误
3. 尝试禁用后重新启用扩展
4. 完全卸载后重新加载扩展

### 看不到浮动按钮

**问题**: 在 Profile/Bookmarks/Likes 页面看不到浮动按钮

**解决方案**:
1. 确认页面 URL 匹配：
   - Profile: `https://x.com/<用户名>`
   - Bookmarks: `https://x.com/i/bookmarks`
   - Likes: `https://x.com/<用户名>/likes`
2. 检查控制台是否有错误
3. 滚动到页面底部

### 数据未保存

**问题**: 浏览推文但 IndexedDB 中没有数据

**解决方案**:
1. 检查是否有"未知用户"的警告
2. 确认浏览时长超过 1 秒（阈值）
3. 查看 Background Service Worker 日志：
   - 去 `chrome://extensions/`
   - 找到扩展
   - 点击"Service Worker"查看日志

## 查看源代码

所有的 TypeScript 源代码都在 `src/` 目录下：

```bash
cd /Users/ggbdpq/cc/test/x-track-by-cc-with-GLM-4.7

# 查看类型定义
open src/types/index.ts

# 查看核心逻辑
open src/content/index.ts
open src/background/index.ts

# 查看文档
open src/docs/ARCHITECTURE.md
```

## 下一步

1. **阅读文档**
   - [README.md](README.md) - 项目概述
   - [DEVELOPMENT.md](DEVELOPMENT.md) - 开发指南
   - [src/docs/](src/docs/) - 技术文档

2. **查看源代码**
   - 浏览 `src/` 目录中的 TypeScript 文件
   - 所有代码都有详细注释

3. **修改和实验**
   - 尝试修改配置参数
   - 调整追踪阈值
   - 添加自定义功能

## 卸载

1. 访问 `chrome://extensions/`
2. 找到"X-Track by CC with GLM-4.7"
3. 点击"移除"按钮
4. 选择是否清除浏览数据

## 需要帮助？

- 查看 [DEVELOPMENT.md](DEVELOPMENT.md) 了解开发详情
- 查看 [src/docs/](src/docs/) 了解技术架构
- 检查浏览器控制台获取错误信息

---

**享受使用 X-Track by CC with GLM-4.7! 🎉**
