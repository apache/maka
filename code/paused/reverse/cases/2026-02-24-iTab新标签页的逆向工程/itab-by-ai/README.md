# iTab 新标签页 - 逆向工程还原项目

> 基于 v1.6.36 版本的逆向分析还原

## 项目说明

本项目是对 Chrome 扩展 "iTab 新标签页" 的逆向工程还原，包含：

- 完整的 TypeScript 类型定义
- 还原的 API 层代码
- 还原的存储层代码
- 项目构建配置

## 目录结构

```
src/
├── types/           # TypeScript 类型定义
│   ├── index.ts     # 核心类型
│   ├── api.ts       # API 类型
│   └── storage.ts   # 存储类型
├── api/             # API 层
│   ├── baseRequest.ts   # 基础请求配置
│   ├── wallpaper.ts     # 壁纸 API
│   ├── user.ts          # 用户 API
│   └── index.ts         # 统一导出
├── storage/         # 存储层
│   ├── indexdb.ts       # IndexedDB 封装
│   ├── localStorage.ts  # LocalStorage 封装
│   ├── chromeStorage.ts # Chrome Storage 封装
│   └── index.ts         # 统一导出
├── composables/     # Vue 组合式函数 (待完善)
├── components/      # Vue 组件 (待完善)
├── utils/           # 工具函数 (待完善)
└── main.ts          # 入口文件 (待完善)
```

## 安装

```bash
npm install
```

## 开发

```bash
npm run dev
```

## 构建

```bash
npm run build
```

## API 端点

| 类别 | 端点 | 说明 |
|------|------|------|
| 壁纸 | `/wallpaper/category` | 获取壁纸分类 |
| 壁纸 | `/wallpaper/list` | 获取壁纸列表 |
| 壁纸 | `/wallpaper/random` | 随机壁纸 |
| 用户 | `/user/login` | 用户登录 |
| 用户 | `/user/info` | 获取用户信息 |
| 配置 | `/itab/config` | 获取配置 |
| 配置 | `/itab/update` | 更新配置 |

基础 URL: `https://api.codelife.cc`

## 存储系统

| 存储 | 用途 |
|------|------|
| LocalForage | 本地数据缓存 |
| IndexedDB | 大数据存储（带 TTL） |
| LocalStorage | 简单键值存储 |
| Chrome Storage | 扩展配置同步 |

## 技术栈

- Vue 3
- TypeScript
- Vite
- Axios
- Day.js
- LocalForage

## 注意事项

1. 本项目仅供学习研究使用
2. 请勿用于商业用途
3. 遵守原项目的使用条款

## 许可

本项目仅供学习研究使用，原代码版权归 iTab 开发者所有。

---

**逆向工程日期**: 2026-02-24
**原始版本**: 1.6.36
