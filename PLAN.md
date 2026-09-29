# Workspace / Agent Session 执行上下文统一重构计划

日期：2026-09-29。分析基线：`issue-164`，HEAD `fda5411`，PR #239（目标分支 main）。

本文是诊断与实施建议；本次只新增此计划，没有修改运行时代码。下述新类型、命令与目录布局均是提案。

## 1. 结论

用户描述的方向性异常有一个可以确定复现的前端机制：**服务端 Thread 的 `worktreePath: null` 是有效的 main checkout 状态，却被 `??` 当成缺失值，回退到创建 Session 时遗留在 composer draft 中的 test 路径。**

这导致 Sidebar 已按服务端归属移动，而工具栏仍查询 test 目录的 Git 状态。随后分支选择又基于这个错误目录判断是否需要迁移，造成部分选择被跳过或在错误目录操作。

更深的问题确实是执行上下文的表示和决策分散，但并非所有底层逻辑都需要重写。当前已经有稳定 Thread 身份、Workspace 目录登记、Session 迁移 authority、provider 恢复与执行锁。应在这些实现上统一数据和命令，让 UI 不再拼接执行上下文。

建议分阶段完成：先锁定并修复这个方向性回归，再统一读取与操作入口，随后收敛契约、持久化和事件。最终删除兼容入口，避免新增一层 facade 后原路径仍继续写数据。

## 2. 已确认的故障链

### 2.1 从创建到第二次切换

1. `apps/web/src/components/AwenSidebar.tsx:createEagerAgentSession` 同时创建服务端 Thread 和本地 draft context。main 创建时二者路径为 `null`；test 创建时二者路径为 test 目录。
2. `composerDraftStore.ts:clearComposerContent` 清空输入内容所在的 `draftsByThreadKey`，没有同时删除 `draftThreadsByThreadKey` 中的执行上下文。`getDraftThreadByRef` 仍能读取旧 context。这里不能把“发送后清空输入框”等同于“旧 Session 上下文已消失”。
3. `AwenSessionService.ts:dispatchAssignment` 迁移到 main 时，将 Thread 的 `projectId` 改为目标目录记录，并写入 `worktreePath: null`、目标 branch。
4. `BranchToolbar.tsx` 与 `BranchToolbarBranchSelector.tsx` 都读取：

   ```ts
   const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
   ```

   因而 test 创建的 Session 回到 main 后，重新选中了旧 test 路径。

5. Selector 用 `activeWorktreePath ?? activeProjectCwd` 查询 Git。`resolveBranchToolbarValue` 在 current checkout 模式下优先显示查询得到的实际分支，所以显示 test；更新一个 optimistic branch 标签无法纠正查询目录。
6. 再点 test 时，`resolveWorkspaceSwitch` 以为当前目录已经是 test，返回 `switchWorkspace: false`，进入 metadata 更新路径而非 Workspace 迁移。再点 main 则可能再次请求迁移到已归属的 main，收到 `already-in-workspace`。选未占用分支还可能继续针对错误的 test 目录 checkout。

main 创建的 Session 没有非空的旧 draft 路径：去 test 时服务端非空路径有效，回 main 时旧 draft 也为空，所以表现正常。差异来自出生时保留的 context，不是 main/test 分支名称本身。

### 2.2 验证范围和证据

运行了临时探针 `/tmp/awen-workspace-context-repro.cjs`，直接读取当前 Selector 中的路径表达式，以及 `BranchToolbar.logic.ts` 中的三个真实函数：`resolveBranchToolbarValue`、`resolveBranchSelectionTarget`、`resolveWorkspaceSwitch`。Git 状态用两个目录对应 main/test 的确定性输入替代。

命令：`node /tmp/awen-workspace-context-repro.cjs`，重复运行结果一致：

```text
PASS main-born -> test
PASS main-born -> main
FAIL test-born -> main {"expectedCwd":"/repo","actualCwd":"/repo-test","label":"test"}
select test again: {"switchWorkspace":false,"targetPath":null}
FAIL: migration skipped although committed Workspace is main
```

对照命令：`AWEN_PROBE_FIXED=1 node /tmp/awen-workspace-context-repro.cjs`。只在探针里替换为按对象选择 authority：

```ts
(serverThread ? serverThread.worktreePath : draftThread?.worktreePath) ?? null;
```

三个方向均 PASS，再点 test 得到 `switchWorkspace: true`。未更改生产源码。

这是实际计算路径的最小复现，**不是完整 React、真实 Git、provider 或桌面端到端复现**。它证明了错误目录、错误标签和跳过迁移的充分机制；“所有其他选项均无反应”、现场 RPC 错误以及用户 provider 的实际运行目录仍需集成测试或桌面验证。临时探针只供本次诊断，不应当作长期回归测试。

排查的三个假设：

| 假设                     | 预测                                                 | 本次结果                                                       |
| ------------------------ | ---------------------------------------------------- | -------------------------------------------------------------- |
| 旧 draft 覆盖服务端 null | test 出生才出现方向性错误；改变 authority 选择后消失 | 已由最小探针验证                                               |
| Git 缓存失效遗漏         | 即便 cwd 正确，也暂时显示旧分支                      | 可能是独立风险；不是解释本次最小复现所必需                     |
| 后端只改 Sidebar         | provider / Thread assignment 未跟随                  | 代码已有 provider 迁移和归属提交，不能据此认定；现场运行未验证 |

当前 checkout 未安装 `node_modules`，未运行仓库完整测试；探针使用 Node 内建 TypeScript 擦除。`_refs/` 在此 checkout 不存在，未声称比对过参考项目。实施时若恢复参考目录，应优先复用其中成熟的 Git/provider 基础设施，不重造此类底层实现。

## 3. 状态为什么容易再次分裂

| 位置                                  | 当前职责 / 表示                                                                         | 问题与处理方向                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/contracts/src/workspace.ts` | 产品 `AwenProjectId`、目录级 `ProjectId`、Workspace `awenProjectId`、派生 `WorkspaceId` | 相同 Project 词汇指向不同实体；领域接口显式使用 WorkspaceId     |
| `CONTEXT.md`、ADR-0026                | Session = durable Thread；Workspace 独立于 branch                                       | 已有正确原则，应贯彻到所有读写入口                              |
| Thread shell                          | `projectId + worktreePath + branch`                                                     | 与 Workspace root / Git HEAD 重叠，易产生互相矛盾的组合         |
| `composerDraftStore.ts`               | 输入内容、draft Session、Workspace 绑定、envMode、worktreeBranchName                    | 输入草稿承担了执行归属与准备计划的职责                          |
| `ChatView.tsx`                        | activeThread、pending mode/base、Git cwd、首发 bootstrap、终端/文件上下文               | 同一数据在大组件中多次推导；整对象选取与逐字段 fallback 并存    |
| `BranchToolbar*`                      | 自行读取 Thread/draft/Project，查 Git，判断迁移或 checkout                              | 展示组件同时承担领域决策，与 ChatView 可得出不同目录            |
| `AwenSidebar.tsx` / `shellReducer.ts` | 使用 Workspace 内嵌 sessions 投影渲染归属                                               | 与 Thread shell 并行表示同一个关系，需一致事件与统一客户端索引  |
| `AwenSessionService.ts`               | provider move、提交 assignment、恢复                                                    | 是应保留和深化的核心；不应由 UI stop/update 两个请求替代        |
| `AwenWorkspaceService.ts`             | 注册、创建、目录保护、重试复用                                                          | 继续作为 Workspace 生命周期实现；不要再出现裸 Git 创建旁路      |
| `ws.ts:dispatchBootstrapTurnStart`    | New worktree setup、注册、重定位、取消、发送编排                                        | 业务流程过重，抽入可直接测试的执行上下文模块                    |
| `CheckpointReactor.ts`                | 按执行 cwd 查登记目录                                                                   | 与当前 PR 的注册修复相关；最终消费已验证的 Workspace 执行上下文 |

当前 PR 相对本地 main 的 diff 为 17 个文件、约 +1080/-199 行。跨层修改本身合理；问题在于同一语义仍分别存在于多处。旧的 server/draft 回退模式也不全是本 PR 新增，不能把全部架构债归因于这个分支。

Migration 057 已将目录事实集中到目录记录，Workspace owner 表仅保留产品归属和创建事实。应沿着这一方向前进，不再新增第二份可写的 root/title 表。

## 4. 目标模型及不变量

### 4.1 明确三个概念

- **已提交归属**：Session 当前属于哪个 Workspace，由服务端确认。
- **工作区事实**：Workspace 的稳定身份、绝对目录、role/origin，以及 Git 当前 HEAD；branch 是 Git 观察结果，不是 Workspace 身份。
- **待执行计划**：用户准备下一步在哪执行，例如首次发送前要求创建新 worktree。计划不改变已提交归属。

建议的领域数据形状（示意）：

```ts
type AgentSession = {
  id: ThreadId;
  workspaceId: WorkspaceId;
  assignmentRevision: number;
  // transcript、model、lifecycle 等仍归原模块
};

type Workspace = {
  id: WorkspaceId;
  projectId: AwenProjectId;
  rootPath: string; // 服务端规范化；包括 main，也永不以 null 表示
  role: "main" | "worktree";
  origin?: "associated" | "awen-created";
};

type GitHead =
  | { kind: "branch"; name: string; commit: string }
  | { kind: "detached"; commit: string }
  | { kind: "unborn"; name: string }
  | { kind: "not-git" };

type ExecutionPlan =
  | { kind: "current-workspace" }
  | {
      kind: "create-worktree";
      sourceWorkspaceId: WorkspaceId;
      baseRef: string;
      startFromOrigin: boolean;
      operationId: string;
      branchName: string;
    };
```

Git 读取失败、加载中、缓存陈旧属于查询状态，不用空 branch 伪装。rootPath 只有 Workspace 目录 authority 可写；Thread 不再单独保存可修改的执行路径。Provider binding 可记录实际 cwd，作为运行证据供校验和恢复，不反向充当 Sidebar 的归属来源。

`ComposerDraft` 只保存输入、附件、模型等编辑内容；`ExecutionPlan` 单独按 Environment + Thread 身份保存。计划可有本地编辑态；服务端接受操作后，以持久化 operation 为准。零轮 Session 已有真实 Thread，不再引入第二种“未晋升 Session”身份。

### 4.2 必须持续成立

1. 一个 Agent Session 恰有一个已提交 Workspace；主目录与 linked worktree 的路径解析没有特殊 fallback。
2. Workspace role `main` 不等于名为 `main` 的 branch；main checkout 可以切到其他分支。
3. Sidebar、工具栏、发送、打开文件、Git 查询都通过同一 Session → Workspace 解析取得上下文。
4. 选择 baseRef 只改变 ExecutionPlan，不修改 Thread branch 或 Session 归属。
5. 已开始会话迁移保持 Thread、Pane、Tab、消息和草稿身份稳定；下一轮必须从目标目录执行。
6. 不允许 UI 通过 metadata update 修改 Session 归属或执行目录；只允许有完整校验的领域命令。
7. Terminal 保留 ADR-0027/0028 的独立语义：assignment 可为空，目录观察可改变归属但不重启 PTY。统一 Workspace 解析工具，不将其强塞入 Agent provider 迁移流程。
8. File/Git Workspace View 保持原目标；Session 自身迁移不把已经打开的独立 Workspace View 一起迁走。
9. 所有索引、缓存、operation 和锁必须带 Environment 范围，不能只按 branch/path/thread 字符串合并不同 Environment。

## 5. 模块设计与命令流程

### 5.1 深模块：SessionExecutionContext

在现有 `AwenSessionService` 上集中编排（可保留类名），使用一个小 Interface 隐藏 Workspace 解析、provider 迁移、归属提交、并发与恢复。内部复用 WorkspaceService、GitWorkflow、ProviderService；不用新增只透传参数的多层包装。

建议对外提供：

```ts
resolveSessionContext(sessionRef);
changeSessionContext({ sessionRef, intent, expectedRevision, operationId });
startTurn({ sessionRef, content, plan, expectedRevision, operationId });
```

`intent` 明确区分 `move-to-workspace` 与 `select-ref`。已登记的目标用 WorkspaceId；Git 发现的未登记 checkout 可用专门的关联目标，服务端验证同项目、注册后解析为 WorkspaceId。客户端不发送“目标 Workspace + 任意覆盖 cwd”的组合。

保留现有迁移 RPC 作为短期 adapter，并明确移除里程碑。`ws.ts` 最终只负责解码、鉴权、调用、返回；首发 setup 与迁移业务下沉到此模块。

### 5.2 选择 ref 的服务端算法

1. 在命令执行时重新读取 committed assignment、Workspace、Git refs/worktrees；不要信任前端菜单打开时的快照。
2. 若目标 ref 已在当前 Workspace，返回幂等成功并刷新 Git 事实。
3. 若目标 ref 在同 Project 的另一 checkout，复用/登记 Workspace，再执行 Session 迁移。
4. 若目标 ref 没有被其他 checkout 占用，在当前 Workspace 执行普通 checkout；远端 ref 的本地 tracking branch 创建沿用现有 Git 实现。
5. Git dirty/conflict、目录缺失、跨项目、provider 不支持 resume 等错误使用结构化结果呈现；失败不发布假归属。
6. checkout 会影响同 Workspace 的其他 Session。检查正在执行的工作并制定统一拒绝策略；不能只检查发起切换的 Session。外部 Git 进程不受应用锁控制，Git 命令结果始终是最终依据。
7. create-ref、PR checkout、Previous worktree、首次发送的 worktree 创建也接入该决策入口，防止主下拉统一后其他入口仍绕过它。

### 5.3 状态机与恢复

操作状态建议为：`preparing → relocating-provider → committing → succeeded`，并具有 `failed`、`cancelled`、`recovery-required` 终态/阻塞态。

- provider 未移动前失败：归属不变，保留可重试计划。
- provider 已移动但提交失败：持久化恢复记录，阻止下一轮发送，显示恢复状态；复用现有 `AwenSessionService` 机制。
- 不能把 Git、provider、数据库包装成一个虚假的 ACID 事务。崩溃窗口应靠 durable operation、可验证的 provider cwd 和幂等步骤恢复；provider 无法验证时保守阻止发送。
- 同 operationId 重试返回同一结果，重复点击相同目标不再视作致命错误；expectedRevision 拒绝基于旧归属的新操作。
- 锁内重新读取 source/target/assignment 并校验，避免排队前读取的 source 已过时。
- 初期保留现有全局 `SessionExecutionLock` 保证正确性。后续单独改为 Session 执行锁 + Workspace Git 锁 + Project 注册/目录预留锁；明确固定取锁顺序并禁止递归取锁。不要在本次修 UI 时顺带撤掉执行互斥。
- New worktree 保留当前 PR 的 timeout、取消、中断返回、注册后保留、注册前清理、固定名称重试复用语义。operationId 应成为复用依据，分支名本身不足以证明目录是本次操作创建。

### 5.4 一个客户端上下文入口

在 `packages/client-runtime/src/state/` 提供 `sessionContext` 派生数据和 commands，web 层只提供 hook adapter：

```ts
useSessionExecutionContext(sessionRef);
// committed Workspace、Git 查询状态、pending plan、operation、capabilities
```

BranchToolbar/Selector 只接收这个 ViewModel 和用户意图回调；禁止再次自行 useThreadShell + useComposerDraftStore + useProject 推导路径。ChatView 的发送、文件和终端新建入口同样消费该上下文。

明确显示“当前归属”和“正在切换/准备”的区别。可以即时显示 pending 目标，但不能把乐观目标写成 committed context。RPC 返回提交 revision，客户端等本地快照达到该 revision 后结束 pending；断线重连可按 operationId 恢复结果。

Git 查询按 Environment + Workspace 身份定位，内部从 Workspace root 构造请求；针对旧目标返回的请求只更新旧目标缓存，不能覆盖当前目标。统一失效规则覆盖 checkout、迁移、外部 Git 变化与重连。

## 6. 存储、投影与兼容收敛

### 6.1 逐步替换身份，而不是增设永久双写

目前目录级 `ProjectId` 实际承担 Workspace 执行目录身份。短期保留其数据库记录，通过唯一 adapter 映射 WorkspaceId；领域调用方不再知道 `workspaceIdForAwenProject` 的编码规则。不要为了改名立刻重生成所有 ID。

最终 Thread 契约显式持有 workspaceId，旧 projectId/worktreePath 只在历史事件/旧快照解码处转换。数据库可以先保留旧物理列名，前提是仅一个地方写入并完成语义映射；之后再做物理重命名。产品 Project 设置与 Workspace 设置须明确作用域及继承，避免改名过程中把目录配置误变成项目全局配置。

迁移必须盘点并校验旧 Thread projectId、非空 worktreePath、登记目录和 owner 的对应关系：

- 三者一致：直接映射，保持现有 Thread/Workspace 身份和深链接。
- 非空路径指向同项目另一登记 Workspace：核实既有运行上下文后显式修复 assignment，并记录修复结果。
- 路径未登记、跨项目、目录消失或证据冲突：保留数据并标记待恢复，不静默选择 main、不随意自动关联别的项目。
- 所有历史事件重放、快照加载、导入与 provider resume 必须经过相同转换规则；不能只迁移当前投影表。

### 6.2 一份客户端关系索引

推荐 `projectsById`、`workspacesById`、`sessionsById` 的规范化关系，Sidebar 的分组由 session.workspaceId 派生。Transcript 仍按 Thread 独立加载，不要把所有消息塞入全局 Sidebar store。

迁移提交事件携带 Session、新旧 Workspace、assignmentRevision 及必要的实体变化；同一个 reducer 原子更新归属和分组。当前 `AwenSessionService` 为源 Workspace 额外发送 `project.meta.update` 的通知补偿，在消费方切换完毕后删除。

若暂时保留嵌套 Workspace snapshots，必须在同一客户端状态更新中同时替换 Thread shell 和源/目标分组；不能让两条独立查询自行追赶。

利用现有事件 sequence/snapshotSequence 机制处理重复、乱序、缺口和重连；新增 assignmentRevision 用于该 Session 的并发前置条件，不再另造全局事件序列。

### 6.3 本地存储升级

为 composer persistence 增加版本迁移。保留 prompt、附件、用户编辑内容，删除已存在服务端 Session 的旧执行路径权威。把确有待创建意图的字段转成 ExecutionPlan；信息不足时让用户重新选 baseRef，不擅自创建目录。成功执行后消费对应 plan，避免刷新后再次创建。

Workbench 的 Session target 始终是 Environment + ThreadId，不能因 assignment 更新重新挂载 Pane。过渡期的 draft route/promotion 仅在兼容层存在，最终删除。

## 7. 实施切片、文件落点和退出条件

| 阶段                   | 工作与主要落点                                                                                                   | 完成条件                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| P0：回归闭环           | `BranchToolbar*`、composer store、客户端测试；按服务端对象整体选择路径，统一必要的过渡 selector                  | 两种出生 Workspace 均可 main/test 往返；旧 draft 仍存在也不污染；补 React 集成回归       |
| P1：统一读取           | `client-runtime/state/sessionContext`、ChatView、Toolbar、Sidebar、文件/终端新建入口                             | 所有 Session 上下文来自同一 selector；现有 null/draft 回退逐一删除                       |
| P2：统一操作           | `AwenSessionService`、`AwenWorkspaceService`、GitWorkflow、`ws.ts`、contracts                                    | migrate/select-ref/startTurn 跨同一 seam 测试；UI 不再 stopSession + updateMetadata 编排 |
| P3：收敛领域契约与投影 | Thread contracts、Normalizer、ProjectionPipeline、ProjectionThreads、shellReducer、workspaceEntities、migrations | workspaceId 成为唯一归属；旧数据可迁移/重放；Sidebar 和会话原子收敛                      |
| P4：拆出 ExecutionPlan | composer persistence、ChatView send、worktree setup tracker                                                      | envMode 不再同时代表“当前在 worktree”和“将创建 worktree”；重试/取消语义保留              |
| P5：删旧路径并验收     | metadata RPC、兼容 adapter、draft promotion、通知补偿、重复 cwd helpers、文档                                    | 不留双写入口；通过完整矩阵；更新 CONTEXT/ADR 与 PR 说明                                  |

顺序允许 P2 与 P4 的内部实现相互配合，但每个合并切片必须完整经过客户端和服务端。建议当前 PR 先补 P0 和对应测试，再以依赖明确的小 PR 实施后续切片，避免将超时/取消修复和大规模持久化迁移混在一个难以审查的补丁中。

P0 只是止血，不能作为“已完成统一重构”的结论。不得以清空整个 composer draft、强制重新挂载 ChatView、手动刷新 Sidebar 或再加一个 branch override 代替修复数据 authority。

## 8. 测试与验收矩阵

### 8.1 必需的前端集成测试

用真实 composer store、真实 session context/reducer、挂载后的 Selector 和 Sidebar，模拟 RPC/provider adapter 的外部响应。测试跨调用方 seam，不能只测纯路径 helper。

1. 分别从 main/test 创建 eager Session → 输入并发送一轮 → 迁移到另一 Workspace → 返回 → 再次迁移。
2. 每一步同时断言 Sidebar 唯一归属、工具栏分支、Git 请求目录、下一轮发送的 Workspace、Thread/Pane 身份和未发送草稿内容。
3. 故意保留创建时旧 draft，确认服务端 null 仍有效；刷新并恢复本地存储后重复。
4. 零轮会话在 main/test 中选择 Current checkout / New worktree / 再回 Current checkout，baseRef 不污染实际 HEAD 或归属。
5. 延迟旧 Git 请求、延迟 shell event、RPC 与事件逆序、重复事件、断线恢复；不得复活旧上下文。
6. 迁移失败、pending 期间连续点击和后台另一个窗口改 assignment；不得显示假成功，也不丢输入。

### 8.2 服务端及真实 Git 测试

- 两个真实 checkout + 一个未占用分支：move 与 checkout 命令区分正确；主目录当前分支不叫 main 时也正确。
- 多个 Session 共用 Workspace 时 checkout 的影响与执行中拒绝策略。
- provider 正常迁移、无 resume 支持、移动失败、移动后提交失败、崩溃恢复、重试幂等；下一轮实际 cwd 校验。
- New worktree 注册、checkpoint、timeout、cancel、注册前后故障、固定 operation 重试复用。
- 文件夹缺失、unborn/detached HEAD、外部 checkout、路径规范化、不同 Environment 同名路径。
- 旧数据库/事件/本地草稿迁移，升级后重启及重放，Thread 与 Pane ID 保持不变。
- Terminal 的 nullable assignment、目录观察、占用保护和不重启 PTY 继续通过现有测试。

### 8.3 最终退出标准

- 对同一个 Agent Session，Sidebar、工具栏、Git、文件打开、新建终端以及下一轮 provider 执行目录能追溯到同一个 committed Workspace。
- 工具栏不再知道 `worktreePath ?? projectRoot` 和 server/draft 优先级；它只显示上下文并发出意图。
- branch 与 baseRef 分开，当前归属与待创建计划分开，输入草稿不能决定已提交归属。
- 迁移和发送共享恢复规则，失败能解释且可重试；不通过丢会话、清消息、删用户目录恢复一致性。
- 旧入口与状态已删除或仅存在于有明确移除条件的历史解码 adapter；所有新增契约有集成测试保护。

## 9. 本次与后续的范围

本次完成代码追踪、计算路径复现与方案设计。没有执行修复、数据库迁移、全量测试或真实桌面验收。

实施时应更新根 `CONTEXT.md` 和一份记录 authority/ExecutionPlan 决策的 ADR，遵守 single-context 约定。先确认 API/事件兼容与数据迁移要求，再切换持久化协议；不要把清空 alpha 数据库当作默认迁移方案。
