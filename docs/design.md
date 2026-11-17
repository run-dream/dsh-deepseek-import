# 设计说明：为什么不"用无头浏览器硬爬"

这份文档记录几个当初纠结过的选择，以及用真实账号验证后推翻/确认它们的证据。

## 1. 抓取：走接口，不走 DOM

一开始最自然的想法是 Playwright 打开 DeepSeek，逐条点开会话、滚动、抓 DOM。放弃它有三个硬理由：

1. **DOM 是最容易碎的东西**。DeepSeek 前端每次改版，选择器就废；接口签名几个月没变过。
2. **长会话是懒加载的**。几百条会话 × 几千轮 = 几千次滚动 + 等待渲染，慢到不可用，而且任何一次超时都会让"迁移完成"变成谎言。
3. **无头浏览器根本渲染不出全部内容**。实测：打开一条带附件的会话，页面上连那张图都没有 `<img>` 节点——它只在特定交互下才画出来。想靠"截图/取 DOM"拿到附件，从一开始就走错了路。

所以：**浏览器只负责一件事——把登录态搬运出来**；拿到 token 之后全部用 `fetch` 跑。

## 2. 认证：Bearer token，不是 cookie

两个接口只需要 `Authorization: Bearer <localStorage.userToken 的 .value>`：

```
列表  /api/v0/chat_session/fetch_page?lte_cursor.pinned=false[&lte_cursor.updated_at=]   游标翻页，has_more 判定
消息  /api/v0/chat/history_messages?chat_session_id=<id>&cache_version=0
```

响应统一一层 `{ code, msg, data: { biz_code, biz_msg, biz_data } }`。

**cookie 不够用**：在页面里直接 `fetch` 历史接口（带 cookie、不带 Bearer）会返回 `40003 INVALID_TOKEN`。这也是为什么"读浏览器 cookie"这条路从一开始就不该作为主路径。

## 3. 读浏览器 LevelDB：能读，但别指望

设计里留了一条"纯 Node 直读浏览器 `Local Storage/leveldb`"的降级路径。它在本机 Chrome 上确实能扫到 key，但有两个坑：

- **`.ldb` 是 Snappy 压缩块**，`userToken` 的 value 在压缩数据里，靠明文扫描是碰运气；扫到的往往是别的站点的同名 key（这次就扫到了 qwen.ai 的 `userToken`）。
- **WSL 场景直接失效**：dsh 跑在 WSL、Chrome 在 Windows 时，profile 在 `/mnt/c/...`，能读到文件，但压缩 + 无索引让提取变得不可靠。

**结论**：这条路径只保留给"Linux/macOS 本机浏览器 + 刚写过 WAL"的场景，不能写进产品承诺。

## 4. 登录态的可靠路径：CDP

实测最稳的是 CDP：让 Chrome 带 `--remote-debugging-port` 起来，连上去执行一次 `localStorage.getItem('userToken')`。

注意 Chrome 136+ 的安全限制：**不允许对默认 profile 开远程调试**，必须用独立的 `--user-data-dir`。这也意味着用户要在那个独立窗口里登录一次（扫码/手机号），无法完全免交互。

WSL → Windows Chrome 的坑：`cmd.exe` 不在 PATH 里（要用 `/mnt/c/Windows/System32/cmd.exe`），而 Chrome 调试端口默认只绑 `127.0.0.1`，跨 WSL 网络不通。**最省事的做法是在 Windows 侧用 PowerShell 连 CDP**，把结果写文件或打印回来，避免跨 OS 网络问题。

## 5. 附件：`signed_path` 不是完整地址

消息里的 `FILE` fragment 长这样：

```json
{"type":"FILE","files":[{"id":"file-…","file_name":"IMG_1816.webp","file_size":300682,
  "model_kind":"VISION","is_image":true,"width":4032,"height":3024,
  "signed_path":"/file?file_id=…&state=<签名>"}]}
```

直接 `GET https://chat.deepseek.com/file?...` 拿到的是 **SPA 的 HTML 外壳**（带 Bearer、带 cookie、带 image Accept 头都一样）。

真地址要点来自前端 bundle 里的常量：

```js
ce = "files.deepseeksvc.com"      // 文件服务基础域名
ct = "/api"                        // 路径前缀
// URL = https://<filesBaseDomain>/api + signed_path + ty=<p|r>
```

于是：

```
https://files.deepseeksvc.com/api/file?file_id=<uuid>&state=<sig>&ty=p        原图（webp/jpeg）
https://files.deepseeksvc.com/api/file?file_id=<uuid>&state=<sig>&ty=p&fmt=jpeg  强制转码
https://files.deepseeksvc.com/api/file?file_id=<uuid>&state=<sig>&ty=r        其它文件原件
```

缺 `ty` 会返回 `400 Failed to deserialize query string: missing field ty`。图片没有 raw（`ty=r` 是 400），必须 `ty=p`。

## 6. 格式：不自创，用 interchange v1

不自己定义格式，直接对齐 `dsh-chat-import` 的 interchange v1（`{"interchange":"dsh-chat-import","version":1,"turns":[…]}`）。好处是导入器现成、幂等和墓碑机制现成、工作区归组现成；代价是要严格守它的约束：

- 标记必须落在文件前 64KB
- 时间戳一律毫秒（DeepSeek 给的是秒）
- 内容块只认 `text` / `reasoning` / `image` / `tool-call` / `tool-result`，其余计数丢弃
- `toolResults[].toolCallId` 必须能在某一步的 `toolCalls` 里找到 id，否则被丢弃

DeepSeek 的实际字段和这些约束对得上：`fragments` 里的 `THINK` → `reasoning`，`RESPONSE` → `text`，`TOOL_SEARCH`/`TOOL_OPEN` → 文本证据，`FILE` → `image` 块。

## 7. 会话树不是线性数组

DeepSeek 存的是消息树（`message_id` + `parent_id`），"重新生成"会留下分支。直接用 `chat_messages` 数组会把所有分支混进来。正确做法是从 `chat_session.current_message_id` 沿 `parent_id` 往回走，只取当前分支。测试里专门锁了这条（分支外的消息不能出现）。

## 8. 稳定性：限速、断点、幂等

- 请求间隔写死 1s，429 指数退避，最多 4 次——**不开放并发参数**，因为用户一定会调到 100 然后被风控。
- 状态落 `~/.dsh/dsh-deepseek-import/state.json`，每完成一条会话立刻刷盘；重跑只补缺口。
- 导入幂等依赖 dsh-chat-import 的 registry：重跑同一目录必须 `imported=0, alreadyImported=N`。

## 9. 移动端

dsh-go 是 Flutter App，Android 上引擎跑在 PRoot 的 Ubuntu（有 Node），也能"遥控电脑"。结论：

- **遥控模式可行**：迁移跑在电脑的引擎上，手机只负责发起和看进度。
- **手机本机模式不可行**：PRoot 里跑 Chromium 需要额外下载几百 MB、`--no-sandbox`、syscall 不全；iOS/鸿蒙连可用的 Chromium 都没有。

所以文档里明确写"手机能接着聊，但第一次迁移要一台电脑"。

## 10. 还没做到的（离"一键"差什么）

1. 登录桥产品化：自动探测 9222、没有就自动拉起带调试端口的浏览器、自动取 token。目前 CDP 那套还是手工接线。
2. 插件内 `tool → migrate → chatImport.importPath` 全链路未在真实进程里验证。
3. 分发：发 npm + 插件市场索引 + SkillHub 上架，才能做到"点安装/一句话使用"。
