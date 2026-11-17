# 隐私说明（PRIVACY）

**一句话：所有数据都留在你自己机器上，本项目没有任何服务器。**

## 会碰到哪些数据

| 数据 | 从哪来 | 存到哪 | 用途 |
|---|---|---|---|
| DeepSeek 登录 token（`localStorage.userToken`） | 你自己的浏览器登录态 | `~/.dsh/dsh-deepseek-import/auth.json`（权限 600） | 调用 DeepSeek 网页端接口读你自己的会话 |
| 会话内容（提问、回答、思维链、联网搜索证据） | `chat.deepseek.com` 接口 | `~/.dsh/dsh-deepseek-import/out/*.interchange.json` | 转换成可导入格式 |
| 图片与附件（base64） | `files.deepseeksvc.com` | 同上，内嵌进 interchange 文件 | 让图片不丢 |
| 迁移进度（会话 id、标题、轮数、文件路径） | 本地生成 | `~/.dsh/dsh-deepseek-import/state.json` | 断点续跑、幂等跳过 |
| 浏览器持久化 profile | 你首次扫码登录时产生 | `~/.dsh/dsh-deepseek-import/browser-profile/` | 下次免登录 |

导入完成后，会话会落到 DSH 自己的会话库里（`~/.dsh/sessions/` 下的 `dsh-chat-import-workspace` 分组），
后续由 DeepSeek Harness 管理。

## 数据流向

```
你的机器                                         互联网
┌─────────────────────────────┐
│ 浏览器登录态 → token         │
│ token → chat.deepseek.com   │ ──▶ DeepSeek（你自己的账号）
│ 图片   → files.deepseeksvc  │ ──▶ DeepSeek 文件服务
│ 转换 / 落盘 / 导入           │  ◀── 不离开本机
└─────────────────────────────┘
```

只有两类对外请求：`chat.deepseek.com` 与 `files.deepseeksvc.com`，两者都是 DeepSeek 自己的域名，
且都使用**你自己的登录态**、只读取**你自己的数据**。

**本项目不收集、不上报、不包含任何遥测或统计。**

## 一个必须说明的边界

迁移本身不联网到别处，但**导入之后你在 DSH 里继续对话时，内容会发给你在 DSH 里配置的模型提供商**。
那是 DeepSeek Harness 和你的 provider 配置决定的，与本工具无关，但你应该知道这条链路。

## 怎么删

```bash
# 1. 删掉本工具的全部本地数据（token、状态、产物、浏览器 profile）
rm -rf ~/.dsh/dsh-deepseek-import

# 2. 删掉已导入的会话：在 DSH 里逐条删除，或用 dsh-chat-import 的 retract_import / 面板「历史」页
#    注意：卸载插件不会删除已导入的会话

# 3. 让旧 token 失效：在 DeepSeek 里退出登录（会签发新 token）
```

## 责任边界

- 这是**非官方**工具，通过你本人账号的登录态调用 DeepSeek 网页端非公开接口。是否被允许由 DeepSeek 的用户协议决定。
- 只应用于导出**你自己账号**的数据。不要用它读取他人账号。
- 你对自己的数据负责：产物目录里是明文对话内容，注意磁盘与备份的访问权限。
