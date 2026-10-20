# 软件验收继续推进记录

日期：2026-10-15（Asia/Shanghai）。用户已休息，第二账户验证暂缓；主会话继续统一协调并行开发侧验收，不要求用户夜间操作。

## 范围与分工

| 工作包 | 所有权 | 本轮验证目标 |
| --- | --- | --- |
| 离线审批与取消 | Runner：四个 controls-offline 入口/fixture 文件 | 真实生产 GUI/IPC/adapter 下的合成 shell 审批、取消与重载；无真实模型或第二账户声明 |
| 正常关闭观察 | Desktop：missing-tools 入口及新增 helper/测试 | 关闭请求等待有界、错误保留、不能强杀或把超时当成功 |
| 卸载准备门禁 | QA：remaining-memory-test 及独立纯测试 | 身份、明确确认、精确目录、关闭应用、保留记录的纯门禁检查；绝不实际卸载 |
| 统一集成 | Main：验收台账、状态与总体验证 | 更新过期状态，复核变更，串行执行完整回归/类型检查并绑定证据 |

沿用已有分工：Runner 和 QA 为 gpt-6.1-sol / xhigh，负责跨进程与安全门禁验证；Desktop 为 gpt-6.1-sol / high，负责窄范围关闭契约；主会话负责集成与最终签收。各 Agent 不回退他人更改，共享文件先协调。

## 执行约束

- 所有文件、日志、测试工作区在 ForgeDesk-codex 内；不写父目录参考文档。
- 不读取真实认证或引擎私有数据，不复制凭证，不发起真实模型回合。
- 不操作第二账户、不实际卸载、不重启 Windows、不改 ACL/账户或系统 PATH；fixture 应用自身的正常关闭与重开允许。
- 硬件保持未验收和关闭，不访问探针、串口或板卡。
- 真实 GUI 的本地进程计时测试与完整回归错峰执行，避免自身竞争造成时间窗口失真。
- 安装版 0.2.1 的既有通过证据保持原样；新测试脚本不追溯替换历史哈希。

## 已有真实通过项

第二 SID1006 的 B 快照闭环、单向 ACL canary、五项 Controls 和子进程 PATH 缺 Git/Node 诊断均已复核。详见 `SECOND_USER_RESULT.md`。这些不是完整第二用户矩阵或无开发环境机器的验收。

## 本轮结果

本轮开发侧检查已完成；不得把下面的纯门禁或离线合成协议结果计入第二账户真实验收。

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| 主控完整回归 | 182/182 通过，失败/跳过/取消均为 0，109625.6364 ms | `output/software-acceptance/2026-10-15/full-suite.log` |
| 主控类型检查 | `npm run typecheck` 退出 0 | 同目录 `typecheck.log` |
| 主控 remaining 门禁 | 118 项通过，其中包含 62 项卸载门禁，不能累加成 180 个独立用例 | 同目录 `remaining-memory.json` |
| 主控独立卸载门禁 | 62 项通过；真实动作分支的文件/进程/写记录调用全部内存模拟 | 同目录 `uninstall-memory.json` |
| Runner 离线生产 GUI | 8 项通过，0 页面错误，2 次正常关闭且无强杀 | `output/second-user-selftest/controls-offline-1792001365810-fyQBWe/evidence.json` |
| Desktop 关闭定向检查 | 16 项纯 Promise/实际函数 AST VM 测试通过，也纳入完整 182 项 | `tests/normal-close-observation.test.ts` |
| 发行配置约束 | 3 项通过，也纳入完整 182 项；不代表实际 NSIS 卸载 | `tests/release-packaging-contract.test.ts` |

离线 GUI 证据 SHA-256：`eab6ccd0aec6913ac90f985a1d683a59c4f95d4b3ca50c45a8e65a7e9aa2b961`。新增 shell accept/cancel 经真实 GUI 重载、生产 IPC/adapter 决策后，合成服务分别收到精确回执。允许后只执行一次固定 `Write-Output`，取消不启动命令；数字/字符串审批 ID、过期 generation、非法 decision、重复提交均被拒绝，源文件未改、runner 操作数为 0。旧 Stop/MCP/诊断/重启回归继续通过。

离线关闭已同时观察窗口请求与 Playwright 收尾，均在新 helper 的有限等待内 acknowledged；具体 main、测试引擎和 process-host 身份消失。主控复核审批重载及取消完成态截图。唯一低优先级界面发现是取消工具状态显示英文 `declined`，已记入 KNOWN_ISSUES，不改动冻结运行时。

## 修复与溯源

- 两份真实验收 harness 的关闭等待改为独立 5 秒观察，原生退出仍另有 30 秒等待；超时明确失败，不提前调用可能强制结束进程的 Playwright 收尾。原始拒绝即使随后等待原生退出超时也会保留。两份入口新增 helper SHA-256 字段。只验证开发侧/纯函数，未重跑已暂停的第二账户。
- 卸载准备脚本不再接受“只剩卸载器、应用已不存在”的前置状态；精确安装/应用/数据路径须存在且无重解析点。复验要求明确确认、卸载前应用和数据存在、版本及卸载器匹配、数字型零退出码，以及标准账户身份；缺字段和矛盾记录拒绝。
- 卸载缺口的实际分支内存红测及修复后绿测保留在 `output/second-user-selftest/uninstall-memory/red.log`、`green.log`、`integrated-green.log`。没有实际运行任何卸载器。
- 安装包和生产应用源代码未变；0.2.1 安装包 SHA-256 仍为 `9375c0d22d57b9cfabf5be0df8e85a3fec66a17039f511ae97bcc0a6cf4ebbb9`。旧第二用户通过记录及失败记录保持原文件和哈希，不拿新 harness 哈希覆盖旧证据。
- 统一证据索引：`output/software-acceptance/2026-10-15/review.json`。源码包与发行 manifest 在本轮本地提交后更新；实际 runtime source 仍为 `c22b5a5b5660393775b5015714c5b48bd584d810`。

## 保留人工项

第二账户新的 shell 取消与完整退出矩阵、实际卸载及数据保留、Windows 重启恢复、反向 ACL/default-AppData 检查，以及独立无开发环境机器验证均保持未执行。等用户恢复后再按需安排，不预先给出夜间操作指令。
