# 第二 Windows 用户验收结果

核对日期：2026-10-15。结论：**ForgeDesk 0.2.1 在第二 Windows 用户下的真实模型 + 固定模板 B 级快照软件闭环、单向 ACL canary、五项 Controls 及子进程 PATH 缺工具诊断均通过；完整第二用户验收矩阵仍有未测项。**

## 本次证据

- 账户：`ForgeDeskTest`，SID `S-1-5-21-1196670755-766692816-2897134863-1006`，独立桌面 Session 2，非提升权限。升级 Preflight 记录标准 Users、非 Administrators。
- 运行：`snapshot-1791984171287`，完成时间 2026-10-14 21:25:34（北京时间）。`realModel=true`、`secondUser=true`、`result=passed`。
- 证据：`output/second-user/S-1-5-21-1196670755-766692816-2897134863-1006/evidence/snapshot/snapshot-1791984171287/evidence.json`。
- 证据 SHA-256：`ffc464d08c9a928ee0f520f0f56c906749524858c7bc01500586454e5851587b`。
- 安装包 SHA-256：`9375c0d22d57b9cfabf5be0df8e85a3fec66a17039f511ae97bcc0a6cf4ebbb9`。
- 安装版 app.asar SHA-256：`ed70cea2a18dc4da6665635e8558a4490aee42e30a1dee22ca4b0b056a2eca24`。
- 使用外部 Node 24.21.0、Git 2.55.0.windows.5。模型为 `gpt-6.1-sol`，公开登录状态为 true，引擎 ready，硬件未启用。
- 升级前后的 SID、安装路径和数据路径一致；Install 记录的全部 10 项资源匹配冻结版本。关联 Launch 的 ACL 报告 `second-S-1-5-21-1196670755-766692816-2897134863-1006-20261014T131624Z-result.json` 在 21:17:06 验证 564/564 项，373 项修改、191 项已正确，备份哈希匹配；这只证明该时点的权限元数据检查，不等同于之后全部文件的复查或实际跨账户访问拒绝。

## 通过范围

| 检查 | 已观察结果 |
| --- | --- |
| 原位升级 | 同 SID、同工程内安装和数据路径；安装资源与 0.2.1 绑定 |
| 真实模型修复 | 原代码在算术 verifier 阶段 exit 1；模型只修改 numbers.mjs，其余 5 文件不变，没有新增或删除输入文件 |
| 构建确认 | 两次实际 GUI allow-once 决策，两个不同 requestKey；修复后模型发起的 B 构建成功 |
| 三项验证 | empty、nonempty、signed 全部通过，产物哈希与回执一致 |
| 长路径与隔离探针 | SQLite 输出可写、输入不可写，普通文件保护、Node 权限及主进程残留检查通过 |
| 快照与导出 | 6 个输入文件以及忽略文件、二进制和空目录等快照检查通过；B 导出不含原始输入，两个操作日志已进行哈希检查 |
| 重启与去重 | 整个应用关闭后重新启动，原任务及通过结果恢复；同 requestKey 不重新探测或执行 |
| 证据有效性 | 修改源输入或输出产物后，当前验收变为 stale；最后重新构建得到 fresh pass |
| 界面与退出 | 1380×900 和 800×600 截图检查通过；零页面错误，正常关闭，无强制清理 |

任务 ID：`4a392c51-d962-4677-8925-457692c06a09`。原始模型构建 `e866c136-fcac-481a-a041-7699174a5004` 的失败原因是 `Snapshot verifying failed: exit 1`，不是基础设施失败；修复构建 `ba9b5468-e3d9-4fd3-a283-fc2f2a5936c1` 成功。

## 单向访问拒绝

2026-10-14 22:24:47（北京时间），实际 ForgeDeskTest SID1006、Session 2、标准 Users、非管理员且未提升的桌面执行 `AclCanary`，返回 `CANARY_READ_DENIED`。证据为 `output/second-user/S-1-5-21-1196670755-766692816-2897134863-1006/evidence/remaining/acl-canary-20261014T142448446Z-6ef3de7c54a949a8b6f795c3ab4c9c9f.json`，SHA-256 为 `b8996e51ef673c0a5f9f0e51cdfca32e5495269d8393e5a4c53cba7dee16c790`。

主控独立复核清单 SHA-256 `b0105d8271547966b3f0febe17fe3240a8d66f2f14176db64b4728c19a70e160` 与记录一致；指定公开标记仍存在、归主账户所有，内容 SHA-256 `b1d53ecef265aa06494acb9c02c82f815bb72e9cd1b5d57d2b453aaaadb27962` 与创建清单一致。仅这一方向和指定非秘密文件的读取拒绝通过；未读取任何认证内容，不扩展为反向拒绝、整个目录审计或共享程序防篡改结论。

## Controls 实测通过

`snapshot-1791998032747` 于北京时间 2026-10-15 01:14:14 至 01:16:16，在 ForgeDeskTest SID1006、Session 2、非提升桌面执行。安装版 0.2.1、真实 `gpt-6.1-sol`、独立登录状态均通过门禁；本轮启动前核对十项安装资源。两次连接均首次成功，没有触发路由超时恢复，不据此认定此前外部超时的根因已消除。

公开证据：`output/second-user/S-1-5-21-1196670755-766692816-2897134863-1006/evidence/snapshot/snapshot-1791998032747/controls/evidence.json`，SHA-256 `bc777c05318b7be3cf2ceaa2cfda556c5309d6933dcc2718cd68d3dc5830b806`。测试入口、命令门禁 helper 和 Stop 观察器的三个哈希均与已验证源码检查点 `ed852b2bd72c2991a14240d9016ec757cf734d35` 一致。

| 检查 | 实际证据 |
| --- | --- |
| Stop | 等待进程创建于 01:14:54.432，01:15:19.284 点击真实停止按钮，01:15:25.001 确认被采样的等待进程及子进程身份消失；在创建后 40 秒期限内，早于 45 秒自然完成。唯一原始 IPC 调用 fulfilled，未手工强杀 |
| MCP 拒绝 | 唯一 engineering.test 工具项与 task/verifier/requestKey 一致；真实 decline 后返回 user rejected MCP tool call，runner 操作数 0、源文件未改 |
| 等待审批时刷新 | 同一 generation/id 的待审批状态保留，真实审批卡出现后通过拒绝按钮完成 |
| 诊断导出 | 真实导出与取消通过，合成日志值脱敏；诊断文件 SHA-256 `c9a0ac17c2cd0a60d615b926d811dbb6788afd4336c03ed2bd0d953f9036e35c` 已独立核对 |
| 应用重启 | 主进程 26044 正常退出后新主进程 26872 启动，两个会话状态及消息 ID 保留，无 runner 重放、无待审批或测试等待进程 |

ProcessProbe 同时观察到应用、Codex 和 process-host，绑定第二 SID 与正确的 Electron 主进程；这是当时的身份采样，不是持续隔离证明。两次正常关闭、无强杀、零页面错误。关闭后的 native absence 覆盖安装路径下的 ForgeDesk.exe 和原主进程身份，不独立证明所有 Codex/host 后代均已退出。主控复核 800x600 完成态及刷新后审批截图，未见阻断操作的重叠。

## 缺工具诊断实测通过

`snapshot-1791999969373159938` 于北京时间 2026-10-15 01:46:09 至 01:47:10，在 ForgeDeskTest SID1006、Session 2、标准非提升桌面运行安装版 0.2.1。公开证据：`output/second-user/S-1-5-21-1196670755-766692816-2897134863-1006/evidence/missing-tools/snapshot-1791999969373159938/evidence.json`，SHA-256 `fcb22c870509e0e619b1465dac4a3187cad1b6eabc00b031e2a262df943d8c1a`；入口 SHA-256 `c97087a5a2061e25f863464030137e293dba9705db53a32c0397f98fe217e478` 与当前已验证脚本一致。

- 仅测试应用子进程获得空 PATH，实际主进程观察值精确匹配；父进程 PATH 不变，未修改系统配置。
- 实际 Git diff API 因 `spawn git ENOENT` 拒绝，实际 Node 验收配置 API 因 `Executable not found: node` 在命令解析阶段拒绝。
- 验收配置、profile revision、操作和证据未变；源文件及验证器未改，验证器未执行，没有模型 thread/turn。
- 真实 Electron 主进程 PID 25096 与启动器 33336 分别记录；启动器退出 0、signal=null，安装路径 ForgeDesk.exe 集合消失，正常关闭且未强杀。该关闭检查不独立覆盖所有 Codex/host 后代。
- 零失败、零页面错误，硬件关闭，测试未读取认证文件。它只证明 PATH 故障注入场景，不证明机器实际卸载 Node/Git、完全无开发环境、绝对路径 Node 命令或 B profile 的缺工具行为。

## 历史失败记录

Controls 首次实际运行 `snapshot-1791988175683` 在停止操作前失败：安装版 0.2.1、SID1006/Session 2、公开登录及 gpt-6.1-sol 连接正常，实际等待进程命令包含 UTF-8 输出编码初始化前缀，而测试只允许未带前缀的精确命令。证据为该 run 的 `controls/evidence.json`；全部控制项仍为 pending，零页面错误，收尾报告正常关闭且未强杀。其 exit 0 属于 Playwright 启动包装进程，不能据此单独声称实际 Electron 主进程退出已验证。失败记录保留，不能把失败收尾中的中断当作“停止按钮验收通过”。

第二次运行 `snapshot-1791990626067` 通过固定 UTF-8 前缀检查，但仍在点击停止前失败：ProcessProbe 已观察到同一 SID 下三类安装进程，测试却用 Playwright 的 CMD 包装进程 PID 与 Electron 进程列表比较。独立隐藏 Electron fixture 及本地 Playwright 源码确认了这一 PID 差异。原证据及当次公共 ProcessProbe 副本保留在该 run 的 `controls` 目录，全部控制项仍为 pending，未改记为通过。修复后改用 Electron 主进程返回的 PID、类型和可执行路径做关联，并补充实际主进程消失检查；仍需真正的 SID1006 重跑。

第三次运行 `snapshot-1791995219975`（北京时间 2026-10-15 00:27）已验证实际 Electron 主进程 36860、SID1006/Session 2、精确安装路径，以及正常关闭后的 nativeMainAfter=null、nativeInstalledProcessesAbsent=true；启动器为 38076，正常退出码为 0。此前 PID 和 PowerShell 空值修复在这一实际第二账户运行中得到验证，但不是 Controls 功能通过。本次在启动连接 `account/read` 时收到 `workspace routing discovery timed out`，尚未创建本轮测试会话或发起模型回合，五项 Controls 仍为 pending。公开证据 SHA-256：`0c8ed1384a2769848acea5d37e2f8ac2b490766c0f9233bad28858e9c1117d5a`。该记录不能判定登录失效，也不能区分网络、代理或服务端根因；没有读取认证内容或修改安装版。

## 尚未覆盖

剩余项目的执行入口和顺序见 `SECOND_USER_REMAINING.md`。补充工具的开发和门禁测试不代表第二账户实测通过。已通过的 B workflow、ACL canary、Controls 和 Missing-tools 均无须重复运行。

- shell 允许/取消的独立确认，以及超出本轮 Stop 等待进程采样范围的完整子进程清理矩阵；MCP 拒绝、等待审批时重载及真实 Stop 已通过。
- 反向跨账户读取拒绝、默认 AppData 路径隔离，以及共享可修改程序目录下的恶意用户防护；SID1006 读取主账户指定公开标记被拒绝已单独通过，见上。
- 完全无开发环境的独立机器及绝对路径工具缺失场景；子进程 PATH 缺失 Node/Git 的诊断已通过，实际机器仍安装着 Node/Git。
- 本轮固定合成标记之外的其他诊断脱敏场景；独立诊断导出与取消入口已通过。
- 卸载及数据保留行为、Windows 重启恢复。应用重启不等同于系统重启。

独立的 Verify、RestartVerify 阶段 JSON 不作为本次已完成记录；资源、三角色 ProcessProbe 和应用重启方面已有 smoke 证据，不能推断其他未测矩阵项。无须为已通过流程再次创建账户、重装或重复登录。

## 证据边界

主控和子 Agent 只复核公开验收记录、安装资源及导出材料，没有跨账户读取认证或 engine 文件内容。第二用户运行不查询原用户所有的 Git 仓库 HEAD，源码元数据明确未观测；运行记录中的测试脚本 SHA-256 与当前脚本一致。

QA 子 Agent 独立复核了导出清单和两份日志的哈希、实际原始验证错误及截图；第二用户子 Agent 独立核对了升级身份、资源绑定、关联 ACL 报告和旧记录保留。两项复核均未启动应用或重跑模型。

此前 `snapshot-1791980373836`（Git 所有权检查）和 `snapshot-1791981176577`（SQLite 长路径）失败记录继续保留。当前通过不覆盖任意恶意同用户代码、任意项目或硬件。硬件仍按用户要求暂不开展。
