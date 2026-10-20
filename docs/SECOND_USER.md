# T3: Second Windows User Installation Acceptance

## 当前结果

2026-10-14 已核对：真实第二 SID 1006 的 0.2.1 升级及真实模型 B 级快照软件闭环通过，运行 `snapshot-1791984171287`，零页面错误、正常关闭。完整矩阵仍有未测项，详见 `docs/SECOND_USER_RESULT.md`。已完成本次测试的账户不需要重复升级或登录；下方命令保留为操作参考，表格为原始验收模板，不代表当前已测范围。

## 0.2.1 升级

0.2.1 kit 已绑定最终安装包与全部资源哈希。主账户的 0.2.1 安装版无模型 fixture 已通过，但不代表真实模型或第二 SID 验收通过；0.2.0 的主账户真实模型 B 级通过也仅是历史结果。ForgeDeskTest（真实 SID 尾号 1006）已完成首次普通桌面登录、0.2.0 安装和独立官方授权；本次沿用该账户、同一安装目录与数据目录，不创建新账户或复制认证数据。

待主会话确认新 kit 就绪后，在 ForgeDeskTest 的普通桌面先正常关闭 ForgeDesk，再在普通 PowerShell 中执行下面三个阶段：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned -Force
Set-Location 'E:\AiProject\agent-design\ForgeDesk-codex\output\second-user-kit'
$primarySid = 'S-1-5-21-1196670755-766692816-2897134863-1002'
./second-user-acceptance.ps1 -Stage Preflight -PrimarySid $primarySid -Upgrade
./second-user-acceptance.ps1 -Stage Install -PrimarySid $primarySid
./second-user-acceptance.ps1 -Stage Launch -PrimarySid $primarySid
```

第一条命令只为当前 PowerShell 进程设置 RemoteSigned，关闭窗口后失效，不修改 CurrentUser 或 LocalMachine 策略。不要以管理员身份运行测试 PowerShell。`-Upgrade` 仅用于 Preflight：核对本 SID 已有的成功 Install/Launch 记录、精确路径及应用已关闭，允许沿用现有数据目录。普通首次安装仍要求数据目录不存在。Install 会打开可见安装界面，预选同一 SID 安装目录并核验新版本全部 10 项资源；无需输入长路径。保留预选目录；若安装结束时有“运行 ForgeDesk”选项，请取消它，再运行上面的 Launch。

Launch 沿用该 SID 的原数据目录与已有授权。只有应用明确要求重新登录时，才由该账户通过官方浏览器流程独立完成授权。不要复制第一个用户的登录状态、认证文件或凭据。升级不删除数据或证据，原阶段 JSON 会保留历史副本。安装完成、确认应用正常后，再正常关闭 ForgeDesk，运行下方一条 smoke 命令。不要把登录账号、密码、令牌或认证浏览器截图写入证据。

## 登录后真实模型流程

最短顺序为：正常关应用 → Preflight（`-Upgrade`）→ Install → Launch → 正常关应用 → smoke。留在 ForgeDeskTest 的普通桌面 PowerShell 中运行：

```powershell
Set-Location 'E:\AiProject\agent-design\ForgeDesk-codex'
npx.cmd --no-install tsx tests/second-user-snapshot-smoke.ts
```

此入口不接收身份或路径参数，从真实 Windows SID 和同桌面 Explorer 判断当前账户；它会核对本 SID 的 kit 阶段记录、10 项安装资源及公开登录状态，再启动同一 SID 数据目录中的安装版。使用干净的进程环境，不设置 `FORGEDESK_SNAPSHOT_*`、`FORGEDESK_DATA_DIR`、`CODEX_HOME` 或 `ELECTRON_RUN_AS_NODE`。环境覆盖存在时会 BLOCKED，不会代办登录。

流程需要可用的 Node.js（`24.12 <= version < 25`）、Git 和项目现有 tsx、Playwright 依赖；`npx.cmd --no-install` 不临时联网安装依赖，且避开 Windows 的 npx.ps1 执行策略入口。它不是“没有开发工具也能运行”的验收。工作区位于 `.runtime/second-user/<真实 SID>/snapshot/<runId>/workspace`，证据位于 `output/second-user/<真实 SID>/evidence/snapshot/<runId>/evidence.json`。

0.2.1 运行 `snapshot-1791984171287` 已通过该 SID 下的固定模板真实模型失败、修复、GUI 确认、导出、重启、去重及过期证据检查；它不能替代下方全部人工矩阵、停止或拒绝操作、缺失工具及卸载验收。此前 0.2.0 长路径探针失败 `snapshot-1791981176577` 的证据保留，不改记为通过。

Status: **0.2.1 second-SID fixed-template real-model B workflow passed; full second-user matrix not yet accepted**. The actual SID1006 run is `snapshot-1791984171287`, not an inference from historical primary-user or earlier failed results. Platform sandbox accounts remain excluded.

## Kit Versions

The entire frozen 0.2.0 kit is retained at `output/second-user-selftest/kit-0.2.0-before-0.2.1`, including its original installer, two scripts, guide, and checksum list. Its installer SHA-256 is `0D3CEE3EE7597E45894465CE9FB7DA7FCF052E9C0EAB3CC628AC4FB1E28CB20E`; its app.asar is `F6F1AE893FBDCD94AD1B80E37CF1339A37D8EDA3D1DB5C5609051FC6F26AB9FD`. Historical primary-user 0.2.0 real-model B acceptance passed for the fixed trusted Node arithmetic template; evidence is `output/playwright/snapshot/installed/snapshot-1791970592002/evidence.json`. This is neither a 0.2.1 pass nor a complete second-SID pass.

The frozen 0.2.1 kit is at `output/second-user-kit/`, with exactly five files: its x64 NSIS installer, two PowerShell scripts, this guide, and `SHA256SUMS.txt`. Installer SHA-256 is `9375C0D22D57B9CFABF5BE0DF8E85A3FEC66A17039F511AE97BCC0A6CF4EBBB9`; app.asar is `ED70CEA2A18DC4DA6665635E8558A4490AEE42E30A1DEE22CA4B0B056A2ECA24`; sandbox-probe.mjs is `5506ABEE15A8B7C58ABF65905F8A1479AF13C0ABA16165AA32BBEF8A0CA69E6F`. All ten installed resources are pinned. Install records the version, installer hash and ten resource observations; Launch requires that this exact release was verified. Old stage records are archived, and no product data or authentication contents are read or deleted by upgrade preparation.

Primary installed 0.2.1 fixture evidence is `output/playwright/snapshot/installed/snapshot-1791982555423/evidence.json`: passed, realModel=false, zero errors and normal closure. Separately, actual second-SID real-model evidence is `output/second-user/S-1-5-21-1196670755-766692816-2897134863-1006/evidence/snapshot/snapshot-1791984171287/evidence.json`: passed, realModel=true, zero errors and normal closure. The remaining manual matrix is pending.

The scripts use Windows PowerShell 5.1, CIM, and built-in Windows security APIs, with no source tree, npm, Node.js, Git, or global Codex CLI dependency. They record identity, public environment flags, package hashes, paths, process identity, stage results, and security descriptor metadata only. They never read authentication or engine file contents. The kit contains no `.runtime`, app data, exported account files, or another user's profile.

The separately authorized account provisioning completed for `ForgeDeskTest`, SID `S-1-5-21-1196670755-766692816-2897134863-1006`: enabled, Users member, not an Administrators member. Evidence: `output/second-user-bootstrap/create-20261014T104149769Z-5cd45fd2350a44dca9503b1faf214d60.json`. Subsequent SID1006 public stage records establish 0.2.0 identity, exact installation, and Launch; the user separately confirmed independent official authorization. Those observations do not establish 0.2.1 acceptance. Passwords are never placed in kit files, command-line arguments, chat, or evidence.

First-use reference for a fresh account only: sign in normally using a standard Users account outside Administrators, then run the frozen kit **in this workspace** (`E:\AiProject\agent-design\ForgeDesk-codex\output\second-user-kit`). It does not create an account or handle its password. They need write access to the project's `output/second-user` and `.runtime/second-user` folders. Do not move the kit outside this project, use Run as another user from the primary desktop, elevate the test PowerShell, or use a platform sandbox service account. The already installed SID1006 must use the Upgrade instructions above; the ordinary first-use Preflight below deliberately rejects an existing data directory:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned -Force
$primarySid = 'S-1-5-21-1196670755-766692816-2897134863-1002'
./second-user-acceptance.ps1 -Stage Preflight -PrimarySid $primarySid
./second-user-acceptance.ps1 -Stage Install -PrimarySid $primarySid
./second-user-acceptance.ps1 -Stage Launch -PrimarySid $primarySid
```

These are the three initial stages: Preflight, Install, then Launch. The interactive installer receives the script-derived project directory through its final NSIS `/D=` argument, including any spaces, and the script checks that directory before installation and verifies the executable there afterward. Keep the preselected location; no long SID path needs typing. If the installer offers to run ForgeDesk at completion, leave that option unchecked and use the Launch stage above. Then complete this account's own official browser login inside ForgeDesk. Later process, resource, restart, and workflow checks will be guided separately; the remaining sections are the acceptance reference.

The user must not elevate, import another user's profile, configure a product/engine data override, or copy authentication files. The script refuses a matching primary SID, a sandbox service account, an Administrators member or elevated process, a nonmatching desktop Explorer owner, an ambient data override, and a changed installer hash. Preflight records Users/Administrators membership and effective/process execution policy as public environment metadata. `CHECKS_OK_NOT_ACCEPTED` only means the automated checks passed; it is never a T3 pass statement.

Launch **only through the script** so ForgeDesk inherits the SID-derived data directory `E:\AiProject\agent-design\ForgeDesk-codex\.runtime\second-user\<actual SID>\data`. This is an explicit test configuration to keep all generated product data in this project. A normal shortcut with default AppData is a separate, untested route. The Windows installer and official login can still produce ordinary system profile/registry/browser state outside the project; that is normal OS behavior and is not packaged as a project artifact.

The primary `.runtime/app` tree now has protected DACLs retaining only its owner SID, SYSTEM, and Administrators with FullControl. Existing ACEs for the specific Chromium capability SID `S-1-15-3-1024-395641907-2340533657-1796656376-1949871151-3167452726-3934347287-2361051074-3061173417` were preserved, with their original masks and propagation scope, only at paths where they already existed in the Cache, Network, and Shared Dictionary trees. The app root and engine tree retain strictly the three principals. The completed primary metadata result is `output/second-user-acl/primary-S-1-5-21-1196670755-766692816-2897134863-1002-20261014T084144Z-result.json`: all 688 paths verified, 681 changed in the final run and 7 already correct. The original pre-change descriptor backup ending `20261014T083243Z-original-dacl.json` and both earlier failed run reports remain in the same directory.

Each `Launch` prepares and verifies protected DACLs on the exact second SID's data directory before starting the app. Only that SID, SYSTEM, and Administrators receive FullControl. As with Primary scope, the script preserves existing ACEs for the same specific Chromium capability SID only where already present under this SID's own Cache, Network, and Shared Dictionary trees, retaining each original ACE byte-for-byte. It never adds a capability ACE where absent, and rejects it at the data root, engine, another SID, or a similarly prefixed directory. This accommodates the app's existing cache ACLs on a subsequent Launch. The ACL script rejects foreign owners, hard-linked files, reparse points, and targets outside the approved project data path; it changes DACLs only, with no elevation or owner/group/SACL change request. It can enumerate engine file paths and inspect their DACL metadata during verification but never reads their contents. Reports stay in `output/second-user-acl`.

The workspace root, output, source, and installation files still inherit shared workspace permissions. These data DACLs do not establish a complete security boundary against a malicious local user who can change the shared installed program or an ancestor directory. Administrator access also remains. Actual second-account access denial has not yet been exercised, and default AppData isolation is untested. The separately authorized main session may provision the standard test account; this acceptance script never creates or switches Windows accounts or changes group membership.

During the later guided checks, copy only the engine home path displayed in Settings. It must equal the SID-derived data directory plus `\engine`. Do not place passwords, tokens, account emails, or screenshots of the auth browser in evidence.

While the app is connected and a real turn is running, capture the installed process owners:

```powershell
./second-user-acceptance.ps1 -Stage ProcessProbe -PrimarySid $primarySid
```

`process-probe.json` requires the installed app, bundled `codex.exe`, and bundled `process-host.exe` to be present in the same desktop session under the second SID. Repeat during a turn if a helper was not yet running; preserve the blocked earlier observation.

After starting the installed app, run:

```powershell
./second-user-acceptance.ps1 -Stage Verify -PrimarySid $primarySid -ObservedEngineHome '<path displayed by installed ForgeDesk>'
```

For the restart check, close the app normally, repeat `-Stage Launch`, confirm the same task and evidence in the UI, then run:

```powershell
./second-user-acceptance.ps1 -Stage Launch -PrimarySid $primarySid
./second-user-acceptance.ps1 -Stage RestartVerify -PrimarySid $primarySid
```

The JSON files are written under `output/second-user/<actual SID>/evidence/`. A failed stage exits nonzero and writes `BLOCKED` where possible. Keep failures and reruns; do not rewrite a blocked result into a pass. The script's process change verifies only an application restart, not restored task contents. Do not claim Windows reboot recovery unless a separate reboot is actually performed and recorded.

## Manual Acceptance Record

Save a copy of the following table beside the JSON stage files. Every `Observed result` cell must contain `pass`, `fail`, `blocked`, or `not tested` and an evidence filename or a concise observation. Screenshots must omit account details and secret material. A reviewer should verify the evidence on the second account before marking T3 accepted.

| Check | Expected observation | Observed result / evidence |
| --- | --- | --- |
| Identity | `preflight.json` has a different SID, matching interactive desktop, and correct frozen installer SHA-256 | not tested |
| Clean startup | Installed app starts without npm or global Codex. Record the actual `preflight.json` Node/Git flags; if a tool is present, do not claim its absence was tested. The kit resides in the workspace only to obey the output-location constraint | not tested |
| Packaged resources | `verify.json` finds the pinned app.asar, four Codex binaries, process host, and all four external template scripts; `process-probe.json` observes all three runtime roles under the second SID | not tested |
| Data separation | Settings shows the script-derived SID path; no first-user task/history appears; Launch ACL result verifies that SID's protected data directory. Record path only, never copy or read engine files. Actual cross-account denial, default AppData isolation, and protection against a malicious user who can modify shared program files are not established by path checks | not tested |
| Official account | The second user completes their own ForgeDesk login; Settings shows public logged-in state and a model list | not tested |
| Real model | A real prompt reaches a terminal completion using the installed app and the second user's authorization. Record model ID, task ID, terminal status and redacted UI evidence | not tested |
| Missing tools | If Git/Node/compiler are actually absent, try the related command or diff and record the specific diagnostic; app stays usable. These are separate project runtime prerequisites | not tested |
| Software workflow | Import a disposable project, register a trusted verifier outside the model-editable source, observe an initial failing check, then a real model repair and passing check with a nonempty diff | not tested |
| Evidence freshness | Change an input after a pass; prior A-level evidence becomes stale and does not remain accepted | not tested |
| Controls | Observe a real approval and one refusal/cancel, pending approval after UI reload, and a stopped real turn with no ongoing child process; distinguish actual decisions | not tested |
| Restart | Whole app process changes as in `restart-verify.json`; the same task, operation log, result and evidence reappear without replaying an operation | not tested |
| Exports | Export public task and diagnostics through the app; inspect only the export's allowed fields and record its hash. Do not attach auth or engine files | not tested |
| Uninstall | From this second account, uninstall and confirm executable removal and documented data retention behavior; retain acceptance evidence separately | not tested |

No device or board test belongs to this matrix while T2 hardware is user-deferred. The frozen snapshot build is a separate T3 item and needs its own evidence.

## Review Decision

Record: account SID, OS build, installer SHA-256, installed app.asar SHA-256, the actual per-user install directory, whether Node/Git/compiler were present, whether official login and real inference worked, any failed or untested rows, and evidence file names. `preflight.json`, `install.json`, `process-probe.json`, `verify.json`, and `restart-verify.json` are machine observations only. T3 can be accepted only after a human reviews all required manual rows from a genuinely different Windows user session. Until then, retain **T3 second-user: not accepted**.
