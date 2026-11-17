# dsh-deepseek-account-import

[![ci](https://github.com/run-dream/dsh-deepseek-import/actions/workflows/ci.yml/badge.svg)](https://github.com/run-dream/dsh-deepseek-import/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-deepseek-account-import.svg)](https://www.npmjs.com/package/dsh-deepseek-account-import)

> **非官方项目**：与 DeepSeek、DeepSeek Harness 均无隶属或背书关系。它通过你本人账号的登录态调用 DeepSeek
> 网页端的私有接口，属于灰色地带；只导出你自己的数据、限速使用、后果自负。

把 **一个 DeepSeek 账号里的全部对话**（含思维链、图片、附件）整批迁移进 DeepSeek Harness（dsh）。

链路：

```
chat.deepseek.com 私有接口  →  interchange v1  →  dsh-chat-import  →  dsh 会话
   （Bearer token）              （本项目转换）        （官方导入器）       （可继续对话）
```

## 为什么是这套分工

- **抓取**：DeepSeek 网页/APP 没有官方导出。本项目用它的两个私有接口（会话分页 + 历史消息）和 `localStorage.userToken` 作 Bearer token，纯 HTTP 完成，不需要逐页模拟点击。
- **格式**：不自己造格式，转成 `dsh-chat-import` 的 **interchange v1**（`interchange: "dsh-chat-import"`, `version: 1`）。`reasoning` 块、`image` 块、附件都原生支持，思维链不会丢。
- **导入**：交给已装的 `dsh-chat-import`（`/import auto` 或 `chatImport` 服务），幂等、墓碑、工作区归组都是现成的。

## 安装

```bash
# 从 npm 装（推荐）
dsh plugin --profile web add dsh-deepseek-account-import

# 或从源码装
dsh plugin --profile web add /absolute/path/to/dsh-deepseek-import
```

要求 Node ≥ 20。**首次登录**需要 `playwright`（不下载 Chromium，复用系统 Edge/Chrome）：

```bash
npm i -g playwright
```

不想装 playwright 也行：只要系统 Chrome/Edge 里登录过 DeepSeek，第三级备略会用纯 Node 直接读浏览器 profile 的 LevelDB 取 token。

## 用法

在 dsh 会话里说一句：

> 把我 DeepSeek 里的对话都迁过来

或者用命令：

```
/ds-migrate status           # 登录态 / 已迁移数量 / 产物目录
/ds-migrate login            # 弹窗登录一次
/ds-migrate preview          # 只读预览：共几条、将处理几条
/ds-migrate run              # 拉取 → 转换 → 导入
/ds-migrate import           # 只导入已有产物目录
```

独立 CLI（不经过 dsh，方便排查）：

```bash
node bin/cli.mjs login | whoami | list | dump <id> | run | doctor
```

## 登录态三级备略

1. `~/.dsh/dsh-deepseek-import/auth.json`（Playwright 登录时保存）
2. 纯 Node 读系统浏览器 `Local Storage/leveldb` 里的 `userToken`（零依赖、零交互）
3. Playwright 拉起系统浏览器弹窗登录一次（`channel: msedge | chrome`，不下载 Chromium）

## 限速与体量

- 请求间隔写死 1s，429 指数退避，最多重试 4 次；**不开放“并发”参数**。
- 单文件上限 20MB，单次迁移附件预算 200MB，超出的降级成文本占位。
- 断点续跑：状态在 `~/.dsh/dsh-deepseek-import/state.json`，每完成一条会话立即落盘，重跑只补缺口。

## 设计取舍

为什么不用无头浏览器硬爬、登录态为什么要走 CDP、附件地址是怎么找到的、为什么选 interchange v1——都在 [docs/design.md](docs/design.md)。

## 验收

```bash
node test/convert.test.mjs   # 转换：分支裁剪、新旧格式、思维链、图片
node test/migrate.test.mjs   # 编排：幂等、force、min-turns、limit
```

## 安全与隐私

- 数据全部留在本机，没有任何服务器：[PRIVACY.md](PRIVACY.md)
- 威胁模型、已知风险、漏洞上报： [SECURITY.md](SECURITY.md)

**最短版**：登录 token 存在 `~/.dsh/dsh-deepseek-import/auth.json`（权限 600），等价于账号访问权；
产物是明文对话；只对 `chat.deepseek.com` 与 `files.deepseeksvc.com` 发请求。用完可 `rm -rf ~/.dsh/dsh-deepseek-import`。

## 已知限制

- **手机本机模式不支持**：抓取要有桌面浏览器/HTTP 环境，dsh-go 的 App 只作入口，迁移跑在连着的电脑上。
- DeepSeek 的文件接口没有公开文档，附件下载按已知形态依次尝试，失败会降级成文本占位并在报告里计数。
- 大批量抓取可能触发风控，这是使用私有接口的固有风险，别调高频率。

## 测试

```bash
node test/convert.test.mjs      # 分支裁剪 / 新旧格式 / 思维链 / 图片内嵌
node test/migrate.test.mjs      # 幂等 / force / min-turns / limit
node test/api.test.mjs          # 附件下载 URL（ty=p / ty=r / HTML 丢弃）
node test/import-compat.test.mjs # 喂给真 dsh-chat-import 解析器（未装则 SKIP）
```

## License

MIT · 见 [LICENSE](LICENSE)。隐私与安全说明见 [PRIVACY.md](PRIVACY.md)、[SECURITY.md](SECURITY.md)。
