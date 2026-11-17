# 国内网络环境安装与排错

这个工具**没有任何运行时第三方依赖**（只用 Node 内置模块）：
`fs / path / os / url / child_process / crypto` 都是内置的，`playwright` 是**可选**的最后手段。
所以正常安装只需要拉一个几十 KB 的包，慢的环节通常是 npm registry 和可选的 Playwright 浏览器下载。

## 1. 从 npm 装（推荐走镜像）

```bash
# 临时用镜像
npm i -g dsh-deepseek-account-import --registry=https://registry.npmmirror.com

# 或者给 dsh 的插件安装走镜像（pnpm）
pnpm config set registry https://registry.npmmirror.com
dsh plugin --profile web add dsh-deepseek-account-import
```

装的是 DSH 插件时，实际执行方是 profile 里的 pnpm，所以配 `pnpm` 的 registry 更有效。

## 2. 不装 npm 包也能用（源码安装）

```bash
git clone https://github.com/run-dream/dsh-deepseek-import.git
dsh plugin --profile web add /绝对路径/dsh-deepseek-import
```

本地目录安装走 `link:`，不访问 registry。

## 3. 可选依赖 Playwright（一般用不到）

登录链路优先用**系统已有的 Chromium 内核浏览器 + CDP**，不需要 Playwright。
只有当前面全部失败、需要弹出内置浏览器时才用到它：

```bash
# 包本身走镜像
npm i -g playwright --registry=https://registry.npmmirror.com

# 浏览器二进制走镜像（不设的话从 playwright CDN 下，国内经常很慢）
export PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
npx playwright install chromium
```

如果本机 `~/.cache/ms-playwright` 里已经有 chromium，程序会直接复用，不会重新下载。

## 4. 运行时要访问的两个域名

| 域名 | 用途 | 说明 |
|---|---|---|
| `chat.deepseek.com` | 会话列表与消息 | 国内正常可达 |
| `files.deepseeksvc.com` | 图片/附件下载（带签名） | 国内正常可达 |

两者都是 DeepSeek 自己的域名，没有任何第三方服务、没有遥测。跑一次自检：

```bash
ds-migrate doctor
```

会打印 Node 版本、两个域名的连通性与耗时、登录态、浏览器、磁盘剩余。

## 5. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `ETIMEDOUT` / `ECONNRESET` 装包 | registry 慢 | 用上面第 1 节的镜像 |
| `doctor` 显示 `chat.deepseek.com ✘ 超时 6s` | 本机网络/代理 | 检查代理；Node 的 `fetch` 默认不读 `HTTPS_PROXY`，需要让 DSH 侧配置网络代理 |
| 请求大量 429 | 被限流 | 工具已内置 1 req/s + 指数退避；不要并发跑多个迁移 |
| 图片下载 404 | DeepSeek 侧文件已不可取 | 会降级成 `[图片] 文件名` 文本占位并在报告里计数，属预期行为 |
| `登录态失效（HTTP 401）` | token 过期 | 重新 `ds-migrate login`；迁移会从断点继续，已完成的不会重做 |

## 6. 代理环境

如果你在需要代理的网络里，注意：Node 20/22 的全局 `fetch` **不会**自动使用 `HTTPS_PROXY`。
可选做法：

- 让 DSH 宿主注入代理 dispatcher（见 DSH 的 network-proxy 文档）；
- 或在能直连的机器上跑迁移，把产出的 `out/` 目录拷到目标机器再 `/import auto`。

产物是纯 JSON 文件，跨机器搬运没有任何额外依赖。
