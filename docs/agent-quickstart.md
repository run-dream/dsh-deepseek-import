# 一句话迁移 · Agent 调用说明

这份文档给**别的 agent / 集成方**看：怎么用最少的话把「DeepSeek 全账号对话搬到 dsh」跑起来。

## 1. 用户只需要说一句话

任选其一（触发词都在插件的 skill 描述里覆盖了）：

- **把我 DeepSeek 里的对话都迁到 dsh**
- 把以前在 DeepSeek 的聊天搬到 dsh
- DeepSeek 那边限额了，帮我整体迁到 dsh
- import my DeepSeek history into DSH

## 2. 第一步是「检测浏览器」，不是「弹窗登录」

`status` 会先扫描本机：装了哪些 Chromium 内核浏览器、哪些 profile 已有登录态、有没有活着的调试端口，
然后给出建议动作 `use-profile / attach-cdp / launch / none`。只有 `launch` 时才需要拉起浏览器让用户扫码。

## 3. Agent 内部就三步

```js
// ① 看状态（只读，无副作用）
deepseek_migrate({ action: "status" })

// ② 没登录态时触发登录：会自动拉起一个 Chromium 内核浏览器，
//    用户在窗口里扫码/手机号登录一次，检测到 token 后自动继续
deepseek_migrate({ action: "login" })

// ③ 预览 + 执行（run 内含拉取、转换、导入）
deepseek_migrate({ action: "preview" })
deepseek_migrate({ action: "run" })
```

可选参数：`minTurns`（跳过太短的会话）、`since`（日期，或 `"last"` 表示接着上次跑）、
`limit`（分批）、`force`（重做已迁移的）、`downloadFiles: false`（不要图片）、
`background: true`（独立进程跑，立刻返回）。

增量与后台：

```js
deepseek_migrate({ action: "run" })                        // 第一次：只迁 1 条做验证
deepseek_migrate({ action: "run", all: true })             // 确认后：全量
deepseek_migrate({ action: "run", since: "last" })        // 只迁上次之后的新会话
deepseek_migrate({ action: "run", background: true })      // 后台跑，不占对话
deepseek_migrate({ action: "progress" })                   // 看后台进度
```

## 大对话单独导入

默认单条 >32MB 会跳过。要单独迁某一条：先 `action:"skipped"` 拿到 id，
再 `action:"run"` 带 `sessionIds:[id]`、`maxMb:600`、`force:true`、`downloadFiles:false`。

## 4. 可以直接粘进系统提示的片段

```
用户要把 DeepSeek 账号里的历史对话整体迁移到 DSH 时，调用 deepseek_migrate 工具：
先 action:"status"（会检测浏览器并给出建议：已登录就别弹窗），需要时才 action:"login"（会弹出浏览器让用户扫码，这是唯一需要人工的一步），
然后用 action:"run" 执行；超过 300 条时用 limit 分批。
不要自己写脚本抓 DeepSeek 接口，也不要索取用户的 token 或 cookie。
```

## 5. CLI 等价写法

```bash
ds-migrate status     # 或 whoami
ds-migrate login      # 自动拉起浏览器 + CDP，失败退回 Playwright
ds-migrate preview
ds-migrate run --limit 100
ds-migrate browsers   # 看看自动发现了哪些浏览器 profile
ds-migrate token --cdp 9222   # 浏览器已带调试端口启动时直接取
ds-migrate token --file ./tok # 手动提供 token
```

## 6. 边界（别对外承诺过头）

- 首次登录**必须**有人扫一次码，物理上无法省。
- 手机（dsh-go）可以用，走「遥控电脑」模式；**手机本机模式不能迁移**（跑不了浏览器）。
- 图片是**原图 base64**，不是缩略图；单文件 >20MB 或单次总量 >200MB 会降级成文本占位。
- 数据只在本机处理，不经过任何服务器；但调用的是 DeepSeek 未公开接口，属灰色地带。
