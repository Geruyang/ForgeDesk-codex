# 第二用户剩余验收

已有事实：ForgeDeskTest 的真实 SID1006 已完成 0.2.1 同目录升级、独立官方授权及固定模板真实模型 B 工作流。下面补查剩余项目；硬件不做，不创建账户，不复制认证，不修改 ACL。

最新进展：单向 AclCanary、`snapshot-1791998032747` 的五项 Controls，以及 `snapshot-1791999969373159938` 的 Missing-tools 均已通过并复核，无需重复。当前无需用户继续操作；卸载、系统重启、反向 ACL 和独立无开发环境验收需另行安排，硬件仍不做。

2026-10-15 用户休息并明确暂缓第二账户验证。后续开发侧补查已完成 182/182 完整回归、类型检查、118 项 remaining 门禁（含 62 项卸载内存测试）及 8 项离线 GUI 检查。关闭观察和卸载准备门禁更严格，但没有在第二账户执行它们；详见 `SOFTWARE_ACCEPTANCE_CONTINUATION.md`。下方卸载参考命令继续保留为待安排步骤，不是当前操作请求。

## Missing-tools 历史命令（已通过，无需执行）

以下是已通过项目的原命令，仅用于追溯，当前不要重复执行：

```powershell
Set-Location 'E:\AiProject\agent-design\ForgeDesk-codex'
node --import tsx tests/second-user-missing-tools-smoke.ts
```

这只给测试应用子进程注入空 PATH，不卸载 Node/Git、不修改机器或用户 PATH、不运行模型回合，也不涉及硬件。测试期间不操作窗口；结束后回报结果与证据路径。无需安装、登录或重跑 Controls。若提示 needsHumanClose，正常关闭应用并回报，不强杀或提升权限。

开发侧已完成 163/163 回归及类型检查；针对本入口的只读补查未发现确定性阻断。它不证明机器物理缺少工具，也不覆盖绝对路径 Node 配置。正常关闭后的 native absence 检查仅覆盖 ForgeDesk.exe，不能声称独立验证所有引擎后代退出。

## Controls 历史重跑说明（已通过，无需执行）

三次 Controls 失败均发生在停止按钮操作之前：第一次是固定 UTF-8 前缀兼容，第二次是把 Windows CMD 启动器 PID 当作 Electron 主进程 PID，第三次 `snapshot-1791995219975` 是 `account/read` 的账户路由发现超时。前两项已修正；第三项新增精确错误的空闲状态检查及最多一次顺序恢复，不将未知外部根因解释为登录失效。既有失败记录保留，不能视为通过。无需重新安装、登录或重复 AclCanary。

交付重跑前已完成整链前置检查：修正 Stop 自然结束误判、Stop 调用尚未返回便启动下一任务、审批刷新等待不足及额外工具调用漏检。163/163 完整回归、类型检查、独立工作区真实 Electron 离线整链均通过。证据及边界见 `docs/CONTROLS_PRECHECK.md`；离线模拟服务不代替第二账户真实模型验收。

以下为已通过 Controls 的原命令，保留用于追溯，当前不要重复执行：

```powershell
Set-Location 'E:\AiProject\agent-design\ForgeDesk-codex'
node --import tsx tests/second-user-controls-smoke.ts
```

运行期间不操作测试窗口，结束后回报结果和证据路径。等待主控复核后再安排 Missing-tools；不要执行卸载。

## 首轮命令参考

以下保留三个入口的完整命令，仅作后续阶段参考，当前不要整段执行。每项须按最新阶段安排执行，不并行开两个应用：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned -Force
Set-Location 'E:\AiProject\agent-design\ForgeDesk-codex'
./scripts/second-user-remaining.ps1 -Stage AclCanary -CanaryManifest 'E:\AiProject\agent-design\ForgeDesk-codex\output\second-user-acl\canaries\primary-2ffe87fd0ba9432ea6fc31c1dfd7449d.json'
node --import tsx tests/second-user-controls-smoke.ts
node --import tsx tests/second-user-missing-tools-smoke.ts
```

RemoteSigned 仅对当前进程生效。需使用已有 Node.js 24.12 至 24.x 和项目现有 tsx/Playwright 依赖，不设置 FORGEDESK_SNAPSHOT_*、FORGEDESK_DATA_DIR、CODEX_HOME 或 ELECTRON_RUN_AS_NODE。出现 BLOCKED 或失败时，先回报终端结果与证据路径；不要改权限或以管理员重跑。脚本按实际 GUI/MCP 决定记录，不把未出现的 shell 审批或取消记为通过。

相对清单路径现按 PowerShell 当前 FileSystem 位置解析，不依赖可能不同的 .NET 进程当前目录。用户首条相对路径命令触发 `Canary input must be the exact public canaries directory and primary-ID.json filename.`；开发侧已复现并修复对应的解析问题。该错误发生于清单读取之前，不是实际跨账户访问被允许或拒绝的结果。

测试运行期间不要操作测试窗口。成功标记分别是 `CANARY_READ_DENIED`、Controls 的 `result: passed`、Missing-tools 的 `result: passed`。若输出 `needsHumanClose` 或要求手工关闭，请正常关闭 ForgeDesk 后回报失败；不要使用任务管理器强杀，也不要继续下一项。无需重复安装或登录。

开发侧最新检查：完整回归 163/163、统一类型检查通过；独立数据与 Git 工作区的真实 Electron 离线 GUI 覆盖连接恢复、Stop、MCP 拒绝、审批刷新、诊断和重启，两次正常关闭且具体主进程/测试引擎/process-host 身份消失。此前 PowerShell 纯门禁 55/55 及主 SID1002 三项入口负门禁记录保留；它们不是 SID1006 实测通过。记录索引为 `output/second-user-selftest/remaining-preparation/readiness.json`。

- AclCanary 只尝试打开主控新建的一个公开、无秘密 marker，不枚举主数据根或读取认证。只有真实 Read/AccessDenied 算该方向通过；文件不存在、其他错误或读成功均不算。当前仅验证 SID1006 读主SID1002 canary 被拒绝，反方向仍未测。
- Controls 检查实际 MCP 拒绝、刷新、停止、公开诊断导出及重启，不代表 shell 取消；三角色 ProcessProbe 由它在应用、引擎及 process-host 存活时采样，用户不需抢时间另跑命令。独立采样也可使用 `./scripts/second-user-remaining.ps1 -Stage ProcessProbe`，缺角色会 BLOCKED，不能代替真实活动窗口采样。
- Missing-tools 仅对安装版子进程的 PATH 做故障注入，不修改机器或用户 PATH，也不卸载系统工具。它不证明机器物理没有 Node/Git，更不证明完全没有项目开发环境；B 模板的绝对 Node 配置不由此覆盖。结束后应用应正常关闭；如需正常启动，用原 kit 的 Launch 阶段恢复正常进程环境。

结果在 `output/second-user/<实际 SID>/evidence/`：ACL/独立进程采样为 `remaining/*.json`，Controls 在 `snapshot/<runId>/controls/evidence.json`；Missing-tools 的最终路径以其终端输出为准。每次观察使用唯一文件；既有阶段和失败记录保留。Remaining 的公共 baseline 校验核对已完成的 0.2.1 阶段记录，不声称当前安装资源重新做了十项实文件哈希核验。

## 最后才卸载

首轮结束后先回报证据，由主控复核。下面是最后独立卸载步骤，**现在不要执行**；等主控另发明确指令，并再次正常关闭 ForgeDesk：

```powershell
./scripts/second-user-remaining.ps1 -Stage Uninstall -ConfirmUninstall
./scripts/second-user-remaining.ps1 -Stage VerifyUninstall
```

卸载只启动 SID1006 精确安装目录中的 `Uninstall ForgeDesk.exe`，保留可见交互，不使用静默、清除数据或提升参数。复验只确认该目录的 ForgeDesk.exe 已移除、本 SID 数据目录仍存在、证据目录及三个公开阶段记录的哈希保留；不打开数据或认证内容。保留目录不等于检查其中全部内容。

恢复安装不是自动动作。若卸载复核后用户明确要求恢复，主控再给同 SID 的已冻结 Install、Launch 指令；需要沿用仍匹配的公共 Preflight，不把现有数据当作新账户清空。认证只通过该账户自己的官方流程处理。

## 仍需独立观察

Windows 系统重启恢复仍是人工待测，本轮不自动重启。完全无开发环境的独立机器/环境启动仍未测，不能用本仓库的 Node/tsx/Playwright harness 成功替代。双向跨账户拒绝若需补测，应另建第二用户自己的无秘密唯一 canary，先确认反向探针的普通非提升身份；保留 Administrators 访问例外，不把管理员读取当作标准用户拒绝失败。

已有 B workflow 通过及本轮各项结果都按实际覆盖范围记入验收，不能自动把未执行的停止、卸载、系统重启、缺开发环境或反向 ACL 项目记为通过。
