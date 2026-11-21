# tools/verify/

验证测试工具，确保复刻功能完整性。

## 工具列表

- `verify-all.mjs` - **全量验证入口**
- `verify-all-versions.mjs` - 验证所有版本数据
- `verify-capture.mjs` - 验证捕获数据完整性
- `verify-business.mjs` / `verify-business-details.mjs` - 验证业务数据
- `verify-documents.mjs` - 验证文档功能
- `verify-knowledge-lifecycle.mjs` - 验证知识生命周期
- `verify-navigation.mjs` - 验证导航结构
- `verify-route-state.mjs` - 验证路由状态
- `verify-storage.mjs` - 验证存储功能
- `verify-task.mjs` / `verify-task-copy.mjs` - 验证任务功能
- `verify-support.mjs` - 验证支持模块
- `verify-agent-edit.mjs` / `verify-super-copy.mjs` - 验证编辑功能

## 使用

```bash
npm run verify                      # 运行全部验证
node tools/verify/verify-task.mjs   # 运行单个验证
```
