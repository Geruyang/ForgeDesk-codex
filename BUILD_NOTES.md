# 源码构建与验证边界

Windows 首次 clone 请显式禁用工作区换行转换：`git -c core.autocrlf=false clone https://github.com/Geruyang/ForgeDesk-codex.git`。固定源码和 resource hash 按原始字节绑定；不得自动重写换行，也不得重 pin 绕过门禁。此指令不修改全局 Git 配置，原 .gitattributes 保持不变。

原 package scripts、生产构建逻辑和安全 pin 不变。npm ci 仅安装声明的 npm 依赖，不提供官方 engine 可执行文件、硬件工具/模型资源、Windows helper 与固定编译器配对、板端部署包。未声称干净 checkout 可直接完成打包或全部硬件功能；不得用空 manifest、重 pin 或虚构资格绕过门禁。

建议先 npm run typecheck，再按发布方最终验证记录运行软件/mock 测试。npm test 使用 scripts/run-tests.mjs 的源码测试发现规则；测试同时使用自行生成的临时输出和部分预先存在的历史证据输入，两者不可互换。Windows 默认测试还含 snapshot.test.ts、restricted-*、sandbox-long-path、snapshot-native-boundaries、snapshot-policy-native-config、snapshot-runner-integration 等真实本机 sandbox 测试，需匹配版本的 vendor/codex/codex.exe、vendor/process-host/process-host.exe 及指定 Windows 工具；ssh-environment.test.ts 还需本机 OpenSSH。没有这些单独配置的前置，不能承诺干净 checkout 的默认 npm test 全过。部分 process-host 测试在缺 binary 时跳过，不等于验证通过。npm run build 和 npm run package 保持原有资源和编译器要求。不得因验收脚本源码存在就执行真实模型、已安装账户、设备、时钟、部署或恢复操作。

默认 npm test 还自动纳入 reconciliation.test.ts、fz3b-host-finalization-observation.test.ts、release-1-software.test.ts 和 release-package-audit.test.mjs 中的历史证据或授权回归。这些测试需要原本机保存的 inspect、host-finalization、reviewed reconciliation 与资产授权记录；相应 output/、.runtime/ 输入不随源码发布，不得复制私人运行证据或伪造记录补齐门禁。本源码快照在干净 CI 环境已验证的范围是类型检查与显式列出的 63 项检查，不是默认 123 个测试文件的完整 npm test。

vendor/codex/manifest.json 原本含本机二进制来源信息，明确不分发；vendor/codex/LICENSE 保留。需在另行准备并核验匹配版本的官方 engine 二进制后，按原 scripts/vendor-codex.ps1 在本机生成 manifest；本发布工具不下载、不执行二进制。其余公共固定资源 manifest 与 server-key known_hosts pin 按原字节保留，public server key 不是账户私钥。

当前 package hooks 还强制读取 output/release-1.0/ASSET_DISTRIBUTION_APPROVAL.json（固定 SHA256 ffaa3b419074f7960f37b0c465586fd353bf2a66904f52e8804b25e89fae5b47）。该真实审批记录不随源码 Git 分发，不能从预期 schema 拼造 true 标志。vendor/codex/manifest.json 的 source pin 固定为 872d592fc313c2c15781d4c910a73cbcbc2f13793b1855351e14b1d6bb7b3dc7；本机生成只是准备步骤，跨机器重生成未必同字节，不保证门禁通过，packaged 脱敏 metadata 也不能替代原 source pin。output/release-1.0/package-audit 是 create-new 审计输出，不应复制旧 PREPACK 或 raw logs 补齐。源码中的六份 notice/对应 source archive 只闭合其精确路径，未提供全部 vendor binary、Windows toolchain、模型或使用授权；类型检查/显式纯 CI 可单独验证，不能推导源码包已自足可打包。这些是 source build 前置，不允许安装包运行时缺少其声明的内置资源；实际客户端资源闭包和签名状态仍由独立 clean audit/最终发布结果证明。

若单独运行 tests/test_ps_v2_reinstall_runner.mjs、tests/test_active_recovery_trial_runner.mjs、tests/test_active_recovery_trial.py 或 scripts/hardware-inspect.py，它们涉及未分发的历史部署/运行证据；这些不是 npm test 的 *.test.ts/tsx/mjs 自动发现项，不能以复制真实证据补齐。live/installed/hardware 验收还需各脚本声明的受控本机输入。

生成的 API TypeScript 保留原字节，需与指定官方 engine protocol 版本匹配。原 schema provenance 的本机账户路径不分发，替代说明不构成二进制来源或运行资格证明。公开第三方 notices 保留原许可，未新增宽松开源授权。

验证会生成缓存和测试数据；不要将验证后的工作目录直接当成干净发布树。发布方应仅使用逐文件 hash 清单核验的快照，不追加 .git 旧历史或测试运行产物。
