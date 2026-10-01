# Workbench 交互与浮层统一验收

实现决策见 [ADR-0031](../adr/0031-continuous-workbench-navigation-and-shared-overlays.md)。本次仅重构导航与呈现基础设施，保留现有 Awen 主题、材质设置和业务状态模型。

## 实现范围

- `continuousNavigation.ts` 负责连续路线：当前 Layout pan → Tab crossing → 下一个 Layout pan。右键拖拽保持 1:1；macOS 双指仅在 Tab 对齐附近增加轻微阻力。
- `useWorkbenchNavigation.ts` 统一指针捕获、原生输入接入、内容归属、取消和几何测量。旧 `useTabSwitchGesture` / `useTabSwitchWheel` 已删除；离散 Shift+wheel 辅助逻辑独立于连续手势。
- 原生 Node-API 模块按窗口观察 AppKit precise scroll 输入，将位移、手势标识、顺序和阶段作为同一数据包发送。惯性只平移当前布局，结束后释放滚动归属。
- Tab indicator 读取同一份 live-card transition frame，同时表达 Viewport 比例与位置。循环连接使用 Tab 总宽度，排除栏尾空白；没有独立动画时钟。
- 所有应用右键菜单进入共享 Base UI 宿主；保留禁用、勾选、子菜单、危险操作、图标和拖拽回调。Pane header 的非拖拽右键释放及 Shift+F10 通过同一菜单入口提供 Close Pane。
- Dialog、AlertDialog、Menu、Popover、Select、Combobox、Autocomplete、Tooltip 和 anchored toast 共用玻璃材质、边框/阴影与动效。玻璃和内容分别缩放、淡入淡出，采样祖先保持稳定；堆叠通知保留其堆叠和滑动手势。
- 透明窗口的弹窗采样区域下增加局部主题底层，消除未过滤的锐利残影；关闭后清理，零模糊和 reduced-transparency 时停用。弹窗区域会牺牲桌面穿透，窗口其他区域不受影响。

## 自动化结果

- 前端全量阶段：432 个文件、5506 项测试通过；最终改动按影响范围复跑 5 个文件、78 项测试，以及连续控制器/手势中断专项 29 项，均通过。
- Electron 窗口回归：38 项通过。旧测试中窗口按钮横向 inset 仍期待 16，而迁移代码已采用 10；断言已按现有布局更新。
- Web / Desktop TypeScript 检查通过；Web production build 和 Desktop bundle build 通过。
- macOS 原生模块 arm64 / x64 均编译成功。隔离 Electron 探针确认 arm64 模块实际安装到窗口，桥接能力可用。
- 新增核心文件与共享浮层的 lint 通过；仓库原有部分组件仍有非阻断 lint 提示。

`node apps/desktop/scripts/check-renderer-appearance.mjs` 仅启动自己的临时 profile 和 daemon，结束后删除状态并保留截图。使用 Sidebar/Topbar/Workbench opacity 10、mask 30、overlay opacity 90，在真实应用内容层上覆盖有透明像素的 4px 条纹，分别比较 16px / 0px 模糊：

| 检查                       | 结果                           |
| -------------------------- | ------------------------------ |
| Add Project 条纹像素对比度 | 4 / 115                        |
| 实际右键菜单条纹像素对比度 | 1 / 203                        |
| 完整 Viewport 宽度右键拖拽 | 松手前激活下一个 Tab           |
| 关闭菜单                   | 无残留采样层                   |
| Shift+F10、方向键、Enter   | 菜单操作执行完成               |
| reduced-motion             | 内容 transition duration 为 0s |
| 调整内容模糊强度           | Sidebar RGBA 不变              |

## 透明度与背景动画修正

原实现把默认 overlay opacity 90 直接用作 90% 填色，遮住了玻璃采样；只给内容加动效，背景、边框和阴影立即出现。暗色现在使用低密度玻璃膜，默认填色 alpha 约 0.0343，100 仍为实色。设置显示为 Overlay density，保存字段保持兼容。

共享 GlassBackdrop 与内容同步执行 170ms 的淡入/放大和淡出/缩小，局部采样底层跟随玻璃的 opacity/scale，边框和阴影也淡入淡出。右键菜单从关闭状态进入打开状态，避免跳过初次入场；Escape 关闭保留过渡。Add Project 与 New Worktree 使用同一 DialogPopup。

隔离探针新增逐帧检查玻璃本身的 opacity/scale，而非仅检查文字；旧实现在入场断言失败。修正后 Dialog 和右键菜单入场、退场均通过。额外使用大面积红蓝背景验证颜色透过：Add Project / 右键菜单在玻璃内的通道差分别为 99 / 153，确认低频背景信息能够透出。针对材质、外观同步、设置搜索及 WorkspaceDialogs 的 76 项测试通过；Web 构建和 TypeScript 检查通过。

## 实机体验边界

自动化没有使用用户正在运行的窗口，也没有物理触控板输入。真实 macOS 触控板的方向、自然滚动设置、原生数据包与 DOM wheel 的交付顺序、阻尼手感和惯性尾部仍需实机验证。原生模块加载及纯控制器测试不能替代这项体验验收；Windows/Linux 的实体输入与安装包也未在本机运行。

实机应覆盖：长 Scrolling → BSP → 长 Scrolling 的一次连续横移；中途反向；半程暂停后释放与快速 flick；完全对齐后继续平移；松手后惯性不跨 Tab；内容内横向滚动不被抢占；手势期间点击、Escape、窗口失焦、缩放/resize 和关闭 Tab 后能够恢复下一次输入。
