/**
 * Builds the reviewable starter SKILL.md body used for a new local skill.
 * Persistence and install authority remain with the caller.
 */
export function buildStarterSkillTemplate(id: string, name: string): string {
  return `---
name: ${name}
description: 把常用工作流写成可复用的本地指令。
allowed-tools:
  - Read
---

# ${name}

当用户要求你按固定流程完成某类任务时，先加载这个技能。

## 使用方式

1. 先确认用户的目标、输入材料和交付格式。
2. 阅读必要的本地文件或上下文，只收集完成任务需要的信息。
3. 按步骤输出结果；如果需要改文件，先说明要改哪里和原因。

## 边界

- 这个技能声明的工具只是需求提示，不会自动获得权限。
- 不要把敏感内容写进这里；它会作为本地技能指令进入模型上下文。
- 如果这个模板不适合你的工作流，可以直接改名或删除 ${id}。
`;
}
