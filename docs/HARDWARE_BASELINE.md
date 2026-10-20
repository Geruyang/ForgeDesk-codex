# STM32 实机基线验证

日期：2026-10-15。所有成果位于 `E:/AiProject/agent-design/ForgeDesk-codex`。

## 结论

**板卡与工程基线通过，ForgeDesk 安装版 T2 尚未通过。** 用户已确认野火 STM32F429IGT6 挑战者 V1、fireDAP SWD，并授权本轮测试。第二 Windows 账户验证继续暂停。本轮无需管理员权限，也未改动安装版 0.2.1。

主控独占硬件；并行子 Agent 分别负责固件构建审查（gpt-6.1-sol/high）、目标校验（gpt-6-sol/high）、CDC 协议与纯测试（gpt-6.1-sol/high）、独立产品门禁验证（gpt-6.1-sol/xhigh）。

## 已验证

| 项目 | 实际结果 |
| --- | --- |
| 工程 | GestureScreen，提交 `c8ae2c906b3d8845b5d5b757099a43332bd6b985`；仅演示视频 LFS 下载失败，不属于构建依赖 |
| 本地构建 | Keil / ARM Compiler 6.24，0 errors / 0 warnings；121 个源文件依赖齐全 |
| 固件一致性 | 交付与本机构建 HEX 相同：`2a654ebc9243906abf8466266a79af1c5233e05d978654d0dcfa2ae3cbb9327f` |
| 探针 | fireDAP CMSIS-DAP，`1FC9:5601`，序列号 `594AC1D7613FED24` |
| 芯片 | DBGMCU ID `0x20036419`，型号族 ID `0x419`，内部 Flash 1024 KiB |
| 实测 UID | `0037001b3133510432383236`；SWD 与 USB 帧一致 |
| 备份 | 1,048,576 字节；每次两遍全读一致，采集前后两次备份仍相同 |
| 备份 SHA256 | `d89a6f8b49c55d2e504406d5153fbf526c1aa6c872a5c0578a3eda128a0ec07a` |
| 运行镜像 | HEX 定义的 583,464 字节与板内 Flash 逐字节一致，差异 0 |
| USB CDC | 独立板卡口 `0483:5740` / `326F32513133`，当前 COM4；不是 fireDAP COM3 |
| USB 数据 | 10 秒内 35 帧，UID、随机 epoch、153600 字节载荷 CRC、递增帧号与时间均通过 |
| 运行诊断 | 从匹配 AXF 的 DWARF 提取 54 个字段；6 次采样、22 项检查通过 |
| 相机/错误 | 诊断窗口相机增加 36 帧，相机错误/超时和显示错误均保持 0 |
| 健康状态 | SDRAM ready、W25Q128 JEDEC `0xEF4018`、无已记录 fault；软件时钟快照为 168/168/42/84/48 MHz |
| 清理 | 串口关闭、探针会话退出；后续 RAM 采样观察到 USB capture_enabled=0，CPU 持续 RUNNING |

没有烧写、擦除、复位、暂停 CPU、修改选项字节或写入外部存储。因为板内现有程序已经与重建 HEX 完全一致，本轮没有为测试而重复擦写。调试连接会配置 CoreSight 访问，不能称为完全被动观测。相机图像未落盘，仅保存帧元数据和首帧哈希。

## 软件验证

- 全量 Node 回归：196/196，0 失败、跳过或取消。
- 新增固定目标校验：芯片/探针/UID、HEX 校验和/地址/重叠/EOF、栈与 Thumb 向量、SHA、精确扇区候选和全 Flash 读回比较；不接入生产设备入口。
- 新增 7 项产品门禁测试：执行真实 main 源码的离线 VM、真实 MCP/runner/profile 拒绝代码，确认 device.* 仍不可用；不是运行安装版，也不是 OS 设备隔离证明。
- CDC 纯测试：13/13，无硬件调用。固件项目已有 USB 18 项、trace 11 项离线测试通过。
- 最终 TypeScript 检查通过。首次新测试的 getter 推断为 void，已显式修为 never；保留失败及最终通过日志。
- 固件原验证脚本有 map 路径不匹配、旧 manifest 8 个过期条目、历史附件缺失；MSVC host C 测试未执行。详见 HARDWARE_FIRMWARE_REVIEW.md，未据此声称全部固件测试通过。

## 证据入口

- `output/hardware/2026-10-15/baseline.json`：汇总、范围与文件哈希。
- `output/hardware/2026-10-15/inspection-01/evidence.json`：首次身份与双读备份。
- `output/hardware/2026-10-15/health-01/evidence.json`：再次备份、AXF/HEX 绑定和完整诊断。
- `output/hardware/2026-10-15/cdc-sample-01/evidence.json`：35 帧 USB 证明及关闭记录。
- `output/hardware/2026-10-15/diagnostic-layout.json`：DWARF 字段布局、断言和解释限制。
- `docs/HARDWARE_FIRMWARE_REVIEW.md`、`HARDWARE_INTEGRATION_REVIEW.md`、`HARDWARE_GATE_REVIEW.md`：并行审查报告。

## T2 剩余边界

当前真实检查由本会话工具执行，不是 ForgeDesk 安装版内的完整任务。后续仍需可信嵌入式构建 profile、设备绑定及独立授权 UI、runner 真实适配器与进程/独占/unknown 状态管理，再完成安装版闭环和负向验收。用户允许本会话测试，不应被伪装为已在 ForgeDesk UI 完成授权。

现有 CDC 仅回传 32 位 epoch 和 UID，没有 build ID、128 位 nonce 或停止 ACK；它不能替代计划要求的固件身份/新鲜响应验证。RAM 短窗、完整帧 CRC 不能证明 LCD 视觉效果、手势准确率或全部外设。烧录中断、错设备实际拒绝、拔线恢复、争用、未知状态重启均未进行实机验收。

在完成这些产品接入前保持安装版 device.* 关闭。通用已审批 shell/A 级外部命令并不等于专属设备授权与 OS 层硬件隔离。
