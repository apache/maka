---
name: Fix BottomSheet white border and ghost
overview: 修复 BottomSheet 切换到 slider/skincare 视图时出现的 80% 白卡"两边白框"，以及关闭时的残影，最小改动原则，不动无关代码。
todos:
  - id: fix-content-wrap
    content: 在 BottomSheet/index.tsx 中条件渲染 .content 外层：仅 category 视图保留白卡，slider/skincare 直接使用自身 fixed 容器
    status: completed
  - id: add-destroy-on-close
    content: 给 Popup 加上 destroyOnClose 属性，消除关闭瞬间的白卡残影
    status: completed
  - id: verify
    content: 手动验证 category / nursing / water / life / mood 五个入口的打开与关闭表现
    status: completed
isProject: false
---

## 根因

文件：[src/aiAgentPackage/aiAgent/components/BottomSheet/index.tsx](src/aiAgentPackage/aiAgent/components/BottomSheet/index.tsx)

JSX 用 `<View className={styles.content}>` 硬包在所有视图外层。而 `.content` 在 `index.module.scss` 是一个 80% 宽、白底、1px 边框的圆角卡片；`slider` / `skincare` 视图的容器则是 `position: fixed` 全宽底部抽屉。两者同时渲染，导致切到子视图时画面中间残留一张 80% 白卡（两边白框）。

关闭时因为 `duration={0}` 且未开 `destroyOnClose`，这张白卡瞬间闪现一下造成残影。

## 最小改动

### 1. 条件渲染 `.content` 外层（修 "两边白框"）

只在 `currentView === 'category'` 时用 `.content` 包裹分类列表；`slider` / `skincare` 视图直接渲染自身的 fixed 容器，不再套一层白卡。

修改 [BottomSheet/index.tsx](src/aiAgentPackage/aiAgent/components/BottomSheet/index.tsx) 的 JSX（约 596-640 行）：

```tsx
<View className={styles.container}>
  {children ||
    (currentView === 'category' ? (
      <View className={styles.content}>
        <View className={styles.categoryList}>
          {categoryData.map(item => (
            <View key={item.id} className={styles.categoryItem} onClick={() => handleCategoryClick(item.name)}>
              <View className={styles.categoryIcon} style={{ backgroundColor: `${item.bgColor}1F` }}>
                <Image src={item.icon} className={styles.categoryIconImg} mode="aspectFit" />
              </View>
              <Text className={styles.categoryName}>{item.name}</Text>
            </View>
          ))}
        </View>
      </View>
    ) : currentView === 'skincare' ? (
      <View className={styles.skincareContainer}>
        {skincareCheckInData && (
          <SkincareCheckInPanel
            data={skincareCheckInData}
            onRecord={handleSkincareCheckInRecord}
            onDateChange={handleDateChange}
            onRoutineChange={handleSkincareRoutineChange}
          />
        )}
      </View>
    ) : (
      <View className={styles.sliderContainer}>
        {recordData && (
          <SliderRecordPanel data={recordData} onRecord={handleRecord} onDateChange={handleDateChange} />
        )}
      </View>
    ))}

  {currentView === 'category' && (
    <View className={styles.closeButton} onClick={onClose}>
      <View className={styles.closeIcon}></View>
    </View>
  )}
</View>
```

说明：原 `children || (…)` 的逻辑保留；`.content` 只套在 category 分支上；其余分支结构和样式完全不变。

### 2. Popup 加上 `destroyOnClose`（修 "残影"）

修改 [BottomSheet/index.tsx](src/aiAgentPackage/aiAgent/components/BottomSheet/index.tsx) 第 588-595 行的 Popup 属性：

```tsx
<Popup
  visible={internalVisible}
  position="bottom"
  duration={0}
  destroyOnClose
  className={styles.popup}
  overlayClassName={styles.overlay}
  onClose={onClose}
>
```

参考 NutUI 官方文档的 `destroyOnClose` 参数语义（关闭时卸载内部节点），以及项目内 `AfterSalePopup`、`memberModal` 等同款用法。

## 不动的部分

- `index.module.scss`：`.content` / `.sliderContainer` / `.skincareContainer` / 动画关键帧、全局 `.nut-popup` 覆盖一律不改（用户明确要求"不要改动其他无关的代码和样式"）
- 业务逻辑：`openCategory`、`handleRecord`、`handleDateChange`、`useEffect` 的状态重置全部保留
- Popup 的 `duration`、`className`、`overlayClassName` 保持原值

## 验证点

1. 入口类别 `category`：5 个分类卡片仍显示在 80% 白卡中，底部圆形关闭按钮正常
2. 点击"饮水 / 生活 / 心情" → 进入 `slider` 视图：只看到底部全宽白色抽屉，中间不再出现"两边白框"
3. 点击"护理" → 进入 `skincare` 视图：同上，只有底部全宽抽屉
4. 抽屉关闭（遮罩点击或内部按钮）后不出现白卡残影
5. `presetType` 直通 `nursing / water / life / mood` 的入口同样正常（父组件别处有直接传参）
