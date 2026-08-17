## 摘要

为 Pi Vision Bridge 增加五组能力：**弹性重试与 Fallback 模型**、**审计日志**、**local-only 本地模式**、**图片路径的标点与 Windows 兼容修复**，以及**视觉上传编码与延迟归因**。测试从 14 个扩展到 38 个，全部通过。

## 变更内容

### 1. 弹性重试 + Fallback 模型（`src/resilience.ts` 新增，`src/provider.ts` 重构）

- 原 `maxRetries: 1` 硬编码替换为可配置的 `maxRetries`（0–6，默认 2），对可重试错误（HTTP `408`/`425`/`429`/`5xx`、网络失败、超时、socket 错误）按**指数退避 + 抖动**重试。
- 错误分类：`abort`（立即停止，不重试不 Fallback）、`retryable`、`fatal`（跳过重试，但仍尝试 Fallback 一次）。
- 新增 `Fallback model` 配置：主模型失败后自动切换备用视觉模型。
  - 仅配 `Fallback model` → 同端点换模型；
  - 同时配 `Fallback base URL` + `Fallback API Key` → 注册第二个独立 Provider（`pi-vision-bridge-fallback`），切到完全独立的服务商。
- Fallback 成功的结果**不写入主模型缓存键**，并在工具结果与审计日志中标记 `usedFallback`。

### 2. 审计日志（`src/audit.ts` 新增）

- 每次视觉委托（success / cache / fallback / failure）以 append-only JSONL 追加到 `~/.pi/agent/vision-bridge/audit.log`。
- 记录：时间戳、结果类型、实际模型、分析模式、图片数、Artifact ID、耗时、失败时的截断错误。
- **不包含**图片字节、完整提示词或任何密钥。
- 新命令 `/vision-audit`（默认显示最近 8 条；`on` / `off` / `clear` / `count` 子命令）。

### 3. local-only 本地模式

- 配置开关 `Local-only`：开启后缓存未命中时**直接拒绝远程上传**并给出明确报错，保证图片字节绝不出机器；缓存命中仍正常返回。

### 4. 图片路径兼容修复（`src/image-paths.ts`）

- **修复 bug**：原 `(?!\S)` 负向前瞻导致路径后跟任何非空白字符（中文逗号 `，`、句号 `。`、英文逗号等）时匹配失败，`看图：C:\x\shot.png，请分析` 这类最常见的写法会静默丢失附件。现改为允许路径后跟 CJK/ASCII 标点或行尾。
- 补充 Windows 盘符路径（`C:\...` 正/反斜杠）的显式测试覆盖，并新增“路径后跟字母不误匹配”（如 `shot.pngbackup` 仍被拒绝）的反例测试。

### 5. 视觉上传编码与延迟归因（`src/image-encode.ts` 新增，`src/provider.ts` 接入）

- **修复高延迟主因**：原实现把原图字节（上限 20 MiB / 2000 万像素）原样 base64 上传。现上传副本先按 Lanczos 缩到长边 ≤ `Upload max edge`（默认 2048 px，可配 512–8192），仍超 `Upload max size`（默认 1 MiB，可配）则重编码 JPEG q90（白色合成背景）。本地基准：4032×3024 照片 11.8 MB → 1.73 MB（噪声最坏情况）、3840×2160 噪声 PNG 23.8 MB → 1.4 MB，编码耗时约 200 ms。
- 本地 Artifact 保留原图，裁剪（`vision_query` bbox）与 `/vision-last` 预览不受影响；GIF 原样上传保动画帧；编码失败自动回退原始字节，绝不中断视觉调用。
- **单轮上下文隔离回归测试**：断言视觉请求 `messages.length === 1` 且小图原样上传——从测试层面证明主会话上下文（无论多少 k）不会被转发给视觉模型；视觉调用耗时与会话长度无关。
- `/vision-test` 结果现在附带端到端耗时（`elapsedMs`），配合 `/vision-audit` 可把长会话中的耗时拆分为视觉调用 vs 主模型往返。

### 6. 设置界面与文档

- `/vision-settings` 新增 `Retries` / `Fallback model` / `Fallback API Key` / `Fallback base URL` / `Audit log` / `Local-only` / `Upload max edge` / `Upload max size` 行。
- `/vision-status` 展示重试、Fallback、local-only 与审计统计。
- README 补充设置表、命令表、弹性重试/Fallback、审计日志、本地模式、“上传编码与视觉延迟”小节、延迟归因 FAQ 及默认文件位置。

## 验证

```text
npx tsc --noEmit        → No errors found
npm test                → 38 pass / 0 fail（原 14 → 38）
npm run pack:check      → OK
```

新增测试覆盖：错误分类与退避重试（含 abort）、审计日志读写/清理/损坏行容错、Fallback 集成（可重试失败与致命错误两条路径）、标点/Windows 路径识别、新配置字段解析与凭据隔离、上传编码（长边缩放、超限 JPEG 重编码、小图字节级原样、GIF 直通、损坏输入回退）。
