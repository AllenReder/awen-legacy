# Electron 外壳迁移复查

日期：2026-09-30。分支：`refactor/electron-shell`；比较基线：`main`（`8eed626`）。

本轮讨论确认的架构决定见 [ADR-0030](../adr/0030-desktop-shell-electron-migration.md)。以下记录修复及验收边界，不代表所有平台已经完成原生验收。

## 决定与修复

| 项目                       | 处理结果                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 普通关闭、退出及同版本重启 | 复用现有 managed daemon 启动器、凭据、锁和所有权协议；Electron 不在退出时停止 daemon。                                                                                                            |
| 应用更新                   | 采用停止本地 daemon、安装、重新启动的同步流程；新版首次启动替换旧版 daemon，允许中断会话。                                                                                                        |
| SSH 接线缺失               | trust、plan、ensure、progress、cancel、密码提示及转发认证全部通过本地 daemon；保留 IPC 序列化后的失败代码。                                                                                       |
| macOS 签名                 | 使用 electron-builder 所需的 `APPLE_APP_SPECIFIC_PASSWORD`；无发布凭据时使用 CI 的 ad-hoc 配置。                                                                                                  |
| Windows 安装包收集         | 只接受输出目录根部的准确 NSIS 文件名，禁止递归误收集应用及辅助程序。                                                                                                                              |
| 打包资源                   | 统一为 `resources/runtime`，包含独立 Node、daemon、客户端及生产依赖；单独复制根部 `node_modules`，避免 electron-builder 自动排除。                                                                |
| Electron 与 preload 打包   | Electron 放入开发依赖；所有 preload 明确 external Electron，避免在沙箱内执行 npm 启动代码。                                                                                                       |
| 冒烟检查                   | 检查真实渲染、bridge、认证、SSH API、daemon 就绪及退出后的 daemon 存活；启动失败、超时和清理失败返回非零。                                                                                        |
| 开发启动                   | 同时运行 desktop、web、server watcher，自动生成所需后台输出。                                                                                                                                     |
| Linux 浏览器导入           | 从 t3code 采用 libsecret helper 的源码和许可证，修正构建路径及依赖；不新增 Linux 桌面安装包。                                                                                                     |
| 原生窗口按钮               | 移除重复 HTML 按钮；macOS 交通灯按 36px Topbar 和 renderer zoom 居中，保留原生按钮；Windows/Linux 保留原生控件。                                                                                  |
| 系统窗口交互与阴影         | 使用普通原生窗口配合 vibrancy / DWM acrylic，避免 Electron `transparent` 窗口影响系统最大化、标题栏双击、调整大小及 macOS 阴影。                                                                  |
| 系统级窗口模糊             | 使用 macOS vibrancy 和受支持 Windows 的 acrylic；保留 Window Glass 开关，主题更新及窗口重建保留设置。                                                                                             |
| 应用内模糊                 | Overlay 与 composer 共用 Content Backdrop Blur：0–32px，默认 16px，0 关闭；与系统窗口模糊独立，不复用旧半径数值；系统减少透明度优先。                                                             |
| 本地背景图片               | 用户选择后导入受控存储，通过同一个 `awen://app/artwork/…` URL 加载画布及缩略图；迁移旧设置并限制任意文件导入。                                                                                    |
| 版本与更新清单             | 版本工具仅使用现有 package manifests 和 macOS bundle build number；发布 ZIP、更新清单及 blockmap，并合并 macOS 两种架构的清单。界面 `stable` 映射到 Electron `latest`；alpha 默认跟随预发布渠道。 |
| Tauri 残留                 | 删除前端 Tauri adapter、依赖和旧浏览器原型；触控板阶段事件通过 Electron input-event 和 preload 传递。                                                                                             |

## 本机验证

- desktop、web、server、scripts 类型检查通过。
- desktop 全量测试：1,366 通过，46 跳过；跳过项不计作原生验收。
- web 相关测试：110 通过，覆盖外观、SSH 错误、认证、原生控件占位和导航手势。
- daemon 生命周期测试：20 通过，包括同版本复用及版本改变后的替换。
- contracts 设置测试：135 通过；版本、开发启动及更新清单测试：88 通过。
- 修改文件 lint 无错误；仍存在已有的 React 和未使用变量警告。`git diff --check` 及版本一致性检查通过。
- macOS arm64 打包应用启动检查通过：renderer、bridge、SSH API、daemon 就绪、普通退出后 daemon 存活。
- 最新 DMG 只读挂载后，同样的应用启动检查通过，并成功卸载卷。
- macOS arm64 DMG 与 ZIP 实际生成成功，分别约 354 MiB 与 347 MiB；更新清单引用准确的文件名。
- 实际开发模式启动通过：36px Topbar、16px 内容模糊、90px 原生按钮占位、无重复 HTML 控件，触控板 bridge 存在。

## 尚未完成的原生验收

- Windows NSIS 安装、Snap Layouts、acrylic 及 WSL 实机启动，需要 Windows 环境；已保留安装后检查的 CI gate。
- Linux libsecret helper 与 GUI 需要 Linux 环境；已配置编译依赖和 Xvfb 检查。
- macOS 交通灯位置的几何测试通过；Cua 返回 `Computer Use was not approved to use Awen`，因此未完成原生截图视觉验收。
- 本地 macOS 打包关闭了签名自动发现，不能据此声称 Developer ID 签名和公证通过。

## 交互回归追加修复

- Workspace 菜单携带 `onPointerDown` 拖拽回调；直接通过 IPC 传输会产生 `DataCloneError`，因此菜单未显示。Project、Workspace 等应用操作菜单统一使用应用内实现，保留指针回调与现有 Pane 拖放流程。系统文件选择器、菜单栏和文本编辑兜底菜单仍可使用原生实现。
- Electron 输入探针复现：DOM `wheel` 先于 `gestureScrollBegin`；阻止默认滚动后，Chromium 不再产生对应的手势开始/结束通知。导航从 wheel 直接启动，保留迟到阶段事件之前的位移；没有结束事件时按 120ms 空闲收尾。指针、键盘或窗口失焦取消待完成的滑动。
- 7 个相关测试文件、76 项测试通过，覆盖菜单回调、菜单关闭、Pane 拖放、Sidebar、阶段事件晚到、结束事件缺失和输入中断。web 类型检查通过，修改文件 lint 无错误。
- 真实 Electron 加载当前前端模块：菜单显示、拖拽回调触发、横向滚动输入切换 Tab 并结束动画均通过。探针通过 CDP 输入生成，未替代物理触控板验收；没有阶段事件时的空闲收尾不等同 AppKit 的精确手指/惯性阶段。
- 上方安装包检查在本节交互修复之前完成；这些修复需重新构建才能进入安装包。

原生手势事件接口依据 [Electron InputEvent 文档](https://www.electronjs.org/docs/latest/api/structures/input-event)；透明窗口限制依据 [Electron 窗口样式文档](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations)。所参考的 t3code 文件始终保持只读。

## 后续外观与滑动排查

- Tab 滑动达到完整位移时立即提交，不等待惯性尾部；较短滑动保留 Chromium 默认事件通路，以便松手阶段提交。相关 4 个测试文件、57 项测试通过。
- 原生窗口的背景着色改为独立 DOM 层。修改后外观滑块检查稳定，但旧实现的变暗现象未能稳定复现，暂不能确认用户报告的根因。
- 新增独立 Electron 自动检查：先运行 `pnpm build:desktop`，再运行 `pnpm --filter @awen/desktop check:appearance`。使用临时用户配置和 daemon，验证 Add Project 弹层实际像素模糊、完整滑动的 Tab 状态提交、设置滑块是否改变 Sidebar 背景，并输出截图；结束后清理测试配置和 daemon。
- Add Project 在独立实例中显示模糊；Project/Workspace 菜单缺少模糊的实际现象尚未复现，不能认定已经修复。自动生成的滑动事件也不能替代物理触控板验收。
