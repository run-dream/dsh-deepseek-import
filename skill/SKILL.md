---
name: deepseek-to-dsh
description: 把用户 DeepSeek 账号里的全部对话（含思维链、图片、附件）整批迁移进 DeepSeek Harness（dsh），迁移后每条会话都能在 dsh 里接着聊。当用户说“把 DeepSeek 的对话迁到 dsh”“搬到 dsh”“导入 dsh”“deepseek 迁移”“把以前的聊天搬过来”“换到 dsh 接着聊”时使用。需要本机已安装 dsh 与 dsh-deepseek-import 插件。
---

# DeepSeek → dsh 一句话迁移

用户只需要说一句“**把我 DeepSeek 里的对话都迁过来**”。
（集成方视角的最简调用说明见 `docs/agent-quickstart.md`。）你的任务是把它跑完，而不是解释原理。

## 前置检查（先做，别跳）

1. 调 `deepseek_migrate({ action: "status" })`。
2. 如果返回“没有工具 `deepseek_migrate`”，说明插件没装，让用户执行（原样给出，别改）：
   ```
   dsh plugin --profile web add /path/to/dsh-deepseek-import
   ```
   装完提示用户重启 dsh（或等 profile 热重载），再从第 1 步重来。
3. 如果返回 `登录态：无`，说明是第一次：执行 `deepseek_migrate({ action: "login" })`，**告诉用户会弹出一个浏览器窗口**，让他在里面登录 DeepSeek（手机号或微信扫码都行），登录完成后自动继续。

## 第一步永远是「检测浏览器」

不要一上来就弹窗。先跑 `deepseek_migrate({ action: "status" })`，它会告诉你：
装了哪些浏览器、哪些 profile 已登录、有没有活着的调试端口，以及**建议动作**：

- `use-profile` → 直接读已登录的浏览器，零弹窗，直接 `run`
- `attach-cdp` → 连已有调试端口，零弹窗（注意：profile 可能因为 Snappy 压缩读不到 token，但 CDP 能读到）
- `launch` → 需要拉起一个浏览器让用户登录一次（唯一需要人工的环节）
- `none` → 只能让用户手动给 token

CLI 等价：`ds-migrate browsers`。

## 登录态拿不到时

按顺序试，别让用户去翻源码：

1. `ds-migrate browsers` —— 看能不能自动认出他的浏览器 profile，以及里面有没有登录态
2. 如果认得出来但读不到 token（`.ldb` 被 Snappy 压缩），让他用 CDP：
   用 **极速模式** 启动浏览器并带 `--remote-debugging-port=9222`，登录 `chat.deepseek.com`，
   然后 `ds-migrate token --cdp 9222`
3. 都不行就最后一招：让他在浏览器控制台执行 `copy(JSON.parse(localStorage.userToken).value)`，
   存成文件后 `ds-migrate token --file <路径>`

**国产浏览器（360/QQ/搜狗/夸克/UC）**：Chromium 内核，同样走上面第 2 条；但必须极速模式，且调试参数要手动加。

## 执行（第一次只迁 1 条）

1. 第一次运行不带 `all`：工具会自动只迁 **1 条**做验证。用户确认侧栏里那条会话正常后，再调
   `deepseek_migrate({ action: "run", all: true, background: true })` 迁剩下的。
2. `deepseek_migrate({ action: "preview" })` —— 把“账号里共 N 条、本次处理 M 条”复述给用户，等他一句“确认”再往下。这是唯一需要用户二次确认的地方。
2. `deepseek_migrate({ action: "run" })` —— 拉取 → 转 interchange v1 → 调用 chatImport 导入。
   这一步可能跑十几分钟。**不要因为慢就中途改参数重来**；进度由插件自己记录，超时或断线后重新执行同一个 `run` 会从断点续上（已完成的会话会跳过）。
3. 报告结果，格式固定：
   ```
   迁移完成：312 条会话 / 8,431 轮 / 图片 96（降级 0）
   跳过 0，失败 0
   ```
   有失败就逐条列出失败的标题，并说明重跑会只补失败的那些。

## 增量与后台

- **增量**：`deepseek_migrate({ action: "run", since: "last" })` —— 从上次跑到的位置继续（自带 5 分钟重叠，
  边界会话不会漏）。第一次没有游标时等价全量。
- **后台**：`deepseek_migrate({ action: "run", background: true })` —— 立刻返回，迁移在独立进程里跑，
  不占用对话；用 `deepseek_migrate({ action: "progress" })` 看进度，加 `json: true` 拿
  `{running,done,total,percent,lastLine}`，可以直接渲染成进度条。几百条以上一律用后台。

## 常见情况

- **数量太大**：超过 300 条时建议分批，用 `limit: 100` 跑三次，而不是一次拉到底。
- **只要最近的**：用户说“最近半年的”，用 `since: "2026-01-01"`。
- **只要长会话**：用 `minTurns: 3`，先跑 `preview` 让用户看会跳掉多少。
- **重复迁移**：默认幂等，已迁移的会话会跳过；用户明确要重做才加 `force: true`。
- **不要图片**：`downloadFiles: false`，图片会变成 `[图片] 文件名` 占位。
- **登录过期**：401 报错时重新 `login`，不要复用旧凭证。

## 不要做的事

- 不要自己写脚本抓 DeepSeek 接口，一律走 `deepseek_migrate`。
- 不要把 token、cookie、会话正文贴进对话里。
- 不要承诺手机本机能迁移：dsh-go 的 App 只是入口，抓取必须跑在有桌面环境的引擎上。手机用户走「连到自己的电脑」再迁移，这条要在第一次就讲清楚。
- 不要碰内容审查：这是用户自己的数据搬家，不判断内容。

## 超大单会话

单条超过 32MB 会被跳过（不计失败）。用户想单独要那一条时：

```
deepseek_migrate({ action: "skipped" })                      // 列出被跳过的，带体积
deepseek_migrate({ action: "run", sessionIds: ["<id>"],
                   maxMb: 600, force: true, downloadFiles: false })
```

先 `downloadFiles: false` 只迁文本，确认没问题再放开图片——体积大多来自图片。

## 后悔药

用户想撤销时：`deepseek_migrate({ action: "undo" })` 先给预览，再带 `confirm: true` 才真的删。
**只删本工具导入的会话副本，DeepSeek 上的原始对话不受影响**——这句话一定要跟用户说清。

## 迁移之后

会话落在专用工作区（`$DSH_HOME/dsh-chat-import-workspace`）里，侧栏会多一个分组。需要核对时执行 `deepseek_migrate({ action: "status" })`，或让用户在 dsh 里跑 `doctor()`（dsh-chat-import 自带体检）。
