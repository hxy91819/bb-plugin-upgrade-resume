# BB Upgrade Resume

在 BB 升级前记录运行中的线程；服务重新启动后，为被重启或停服时 Provider 退出打断的原线程发送一次继续消息。独立插件，使用公开 Plugin SDK，无需修改 BB 核心。

这是**中断后自动续跑**：当前模型请求或工具调用仍可能被升级打断，页面和 API 仍会短暂离线。

## 安装

需要 BB 0.46.0 或以上、Plugin SDK 0.6.37 至 0.6.x。仓库目前为私有仓库，建议先在 BB 所在机器克隆，再按本地路径安装：

```bash
gh repo clone hxy91819/bb-plugin-upgrade-resume
cd bb-plugin-upgrade-resume
npm ci
npm run build
bb plugin install .
```

插件没有前端页面，安装后通过 `bb upgrade-resume --help` 查看命令。目录需要保留，供 BB 加载插件。

## 升级流程

在外部部署脚本停止 BB **之前**执行：

```bash
bb upgrade-resume prepare
```

成功后按现有流程升级 BB。插件不会停止线程、升级 BB 或操作服务管理器。Server 启动、插件加载后，后台服务每五秒检查一次恢复条件。

```bash
bb upgrade-resume status
bb upgrade-resume status --json
```

只记录指定项目：

```bash
bb upgrade-resume prepare --project <project-id>
```

取消尚未派发的恢复，或立即检查等待中的任务：

```bash
bb upgrade-resume cancel
bb upgrade-resume resume
```

`resume` 仍要求 Server 进程已经重启。普通插件重载不会触发恢复。命令默认输出可读状态，均支持 `--json`。

## 恢复规则

- `prepare` 记录当时已进入 `active` 状态、没有待处理审批或问题的线程，包含隐藏线程。未纳入清单的线程（包括当时处于 `starting` 的线程）不在本批次内。
- 清单保存在插件的 SQLite 中，记录原线程、机器、派发请求和事件位置，不复制提示词或工具结果。只保留最近一个批次；已有未结束批次时，先查看或取消它。
- 只在 Server 进程发生变化、原机器已连接且线程已进入 `idle` 或 `error` 时续跑。如果快照中的请求仍是最新派发，清单之后必须有 `host-daemon-restarted` 中断记录，或发生于恢复 Server 启动前的 `system/error`（`code: provider_process_exited`）。
- 对已纳入清单的线程，停服窗口内的新派发（包括已消费的队列消息）也可恢复：必须通过 `turn/input/accepted` 证实它在恢复 Server 启动前已进入 turn，且该 turn 有对应的升级中断证据。重启后发出或接收的新请求视为已接管。
- 整体停服时，Provider 可能先退出并被记录为失败，Daemon 重启便不会再补写线程中断事件。进程退出码 `0` 不表示任务已经完成；上述结构化退出记录也可用于恢复。普通失败、当前 Server 启动后的 Provider 退出及没有准备批次的崩溃不会触发此路径。
- 已完成、被手动停止、已归档或删除、已有接管派发或仍有排队工作、到达审批或问题的任务会跳过。缺少中断证据、机器未连接和暂时无法读取状态时保留等待原因。
- 续跑使用原线程及默认执行配置，发送可见的升级继续消息，附带批次标识。Agent 会被要求先检查已有进度及工具结果，再继续原任务。
- 每次发送之前先持久化 `sending`。发送成功变为 `resumed`；发送报错或 Server 恰好在发送时退出，变为 `uncertain`，不会自动重发。当前公开发送 API 没有客户端幂等键，插件不承诺跨进程的 exactly-once 派发。

查看 `uncertain` 对应线程的消息和运行状态。确认没有继续消息后，可在该线程手动发送继续；下一批升级前重新 `prepare`。`cancel` 不会撤回已经发送或被 BB 接受的消息。

派发前会重新读取线程和相关事件；最后一次检查与发送之间仍存在公开 API 无法消除的并发窗口。升级期间尽量暂停人工和自动化的新派发；插件的快照不冻结全局任务队列。该版本仅处理显式准备的升级，无法把普通网络断线、崩溃或所有升级入口自动归入同一批次。

## 开发与验证

构建使用当前安装的 `bb` CLI；CI 单独安装固定版本的 BB CLI。插件锁文件只管理插件自身及测试依赖。

```bash
npm ci
npm run check
```

测试加载真实插件入口，使用官方 Plugin SDK harness 和真实 SQLite，覆盖准备清单、插件重载、恢复条件、取消、并发恢复和发送结果不确定。测试中的 SDK 外部响应由 harness 提供；它们不代替真实 Provider 和实际服务升级验证。

手动验收应使用隔离的 BB 实例：运行长任务，执行 `prepare`，重启该实例，检查原线程收到一次继续消息；另测任务提前完成、人工停止、机器延迟上线和待审批。不要为验证本插件重启承载当前工作的 BB 实例。

兼容性依据公开 SDK 声明和 BB 的结构化线程事件。升级 BB 后，如事件语义变化，先在隔离实例复验。后续可通过核心升级前钩子覆盖内置更新入口，插件继续持有恢复策略。
