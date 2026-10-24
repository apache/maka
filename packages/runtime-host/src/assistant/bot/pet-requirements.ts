/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/** On-demand asset contract; not a creation workflow or system prompt. */
export const PET_PACK_REQUIREMENTS = `# 桌面宠物素材规范

宠物包是一个目录，包含 pet.json 和一张 PNG 或 WebP 动画图集。它与聊天头像、表情包独立，不需要与助手人设相同；更改助手人设不会要求更换宠物。角色、画风、素材来源和制作方式由你自行决定。

## 图像要求
- 透明背景，只画角色及随动作变化的必要道具；不要把气泡、状态文字、按钮、格线或帧编号画进图里。
- 所有帧等宽等高，排列成规则网格，从左到右、从上到下编号，从 0 开始。人物比例、脚底基线和留白一致，动作不越出格子、不被裁切。
- 单帧推荐 256×256；这是建议，不是固定尺寸。帧数、网格和播放速度按动作需要选择，不要求每种动作帧数相同。
- 现有格式限制：图集文件不超过 4 MiB，整图宽高分别不超过 8192 像素，单帧宽高分别不超过 2048，行列分别为 1～64，总有效帧数为 1～256。
- 每种动作要有可辨认的姿态变化，循环衔接自然；不要把同一张静态图重复编号当作完成了动画。可以复用合适的帧。

## 动作名称
必需：idle（空闲）、working（执行工作）、needs-input（需要用户回应）、ready（有消息或结果）、blocked（受阻）。
可选：swarm（后台探索）、cancelled（取消）、poke（点击反馈）、wake（唤醒）、sleep（休眠）。助手模式推荐提供 swarm。
桌面宠物点击时播放一轮 poke，不改变原有点击操作；连续空闲 10 分钟且没有运行工作、后台探索、记忆维护、待处理消息或输入交互时播放 sleep，有活动时恢复。缺少可选动作会回退到基础动作。空闲图像还会叠加呼吸、轻晃、轻伸展的轮换动效。不保证其他界面都会触发全部可选动作；后台探索不表示助手不能同时聊天或执行其他任务。

## pet.json
- schema 固定为 maka.pet/v1；id 用 1～64 位小写英文字母、数字、点、下划线、连字符，首尾为字母或数字；displayName 为显示名称（最多 80 字符），description 可选（最多 500 字符）。
- spriteSheet：path 是包内相对路径，扩展名须与 format（png 或 webp）一致；frameWidth/frameHeight 为单帧尺寸；columns/rows 为网格行列数；frameCount 为有效帧数，不超过 columns×rows。真实图片尺寸必须恰好等于 frameWidth×columns、frameHeight×rows。
- animations：每个动作填写 frames（非空的帧编号数组，每项小于 frameCount）、fps（1～60 的整数）、loop（布尔值）。非循环动作可设置 fallback，指向包内已定义的动作；不写时默认 idle。
- 不包含脚本、绝对路径或越出包目录的路径。不要自行添加现有格式不支持的字段。

下面只是合法格式示例，不规定动作内容或制作步骤。配套图集为 1024×1536：
\`\`\`json
{
  "schema": "maka.pet/v1",
  "id": "my-pet",
  "displayName": "我的宠物",
  "spriteSheet": {
    "path": "sprites.png", "format": "png",
    "frameWidth": 256, "frameHeight": 256,
    "columns": 4, "rows": 6, "frameCount": 24
  },
  "animations": {
    "idle": {"frames": [0,1,2,3], "fps": 4, "loop": true},
    "working": {"frames": [4,5,6,7], "fps": 6, "loop": true},
    "needs-input": {"frames": [8,9,10,11], "fps": 4, "loop": true},
    "ready": {"frames": [12,13,14,15], "fps": 6, "loop": true},
    "blocked": {"frames": [16,17,18,19], "fps": 4, "loop": true},
    "swarm": {"frames": [20,21,22,23], "fps": 6, "loop": true}
  }
}
\`\`\`

## 现有接入边界
使用 AssistantPetPack：requirements 查看本规范；list 查看已安装宠物；create 提交 manifest（上面的 JSON 对象）和 spriteSheetPath（当前工作区里的图集文件路径）。代码负责读取图片、校验并安装到当前 Host 的宠物库，无需转发图片内容。安装不会切换或启用宠物；需启用或换宠物时，用 select 传已安装的 petId（或通过桌面宠物设置选择）；status 可查看当前选择。同 ID 同内容可安全重试，内容不同需换新 ID。桌面也保留宠物包目录导入和选择能力。AssistantCharacterPack 的 add_image/set_avatar 只管理聊天图片和头像，不会安装或启用宠物；不要把图集当作表情包登记。文件生成成功不等于宠物已启用，按实际可用的工具或桌面入口处理。
`;
