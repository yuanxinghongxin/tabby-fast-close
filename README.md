# tabby-fast-close

[![npm version](https://img.shields.io/npm/v/tabby-fast-close.svg)](https://www.npmjs.com/package/tabby-fast-close)
[![license](https://img.shields.io/npm/l/tabby-fast-close.svg)](LICENSE)

让 [Tabby](https://tabby.sh/) 里按 `Cmd+W` 关闭本地 shell 标签页**瞬间完成**(实测 26–51ms,原生约 1260ms),且不污染 shell history。SSH / 串口等会话不受影响。

## 安装

在 Tabby 中:**设置 → 插件 → 搜索 `fast-close` → 安装**,然后完全退出并重启 Tabby。

也可以在 Tabby 插件目录手动安装:

```bash
cd ~/Library/Application\ Support/tabby/plugins   # macOS
npm install tabby-fast-close
```

> Windows: `%APPDATA%\tabby\plugins` · Linux: `~/.config/tabby/plugins`
>
> 插件加载发生在启动时,安装后必须**完全退出并重启 Tabby**,只关窗口无效。

## 效果

| 场景 | 原生 | 本插件 |
|---|---|---|
| 关闭本地 shell(含"系统默认") | ~1260ms | **26–51ms** |
| SSH / 串口 / Telnet / 设置页 | 快 | 不变(走原生逻辑) |
| shell history | `exit` 会留痕 | 无残留(只发控制字符) |

## 原理

Tabby 原生的 `close-tab` 在真正销毁标签前会串行做三件慢事:

1. 枚举全系统进程检查子进程 (`canClose()`)
2. 序列化最多 1000 行终端回滚缓冲 (`getFullRecoveryToken` → `saveState()`)
3. 本地 session 的 `gracefullyKillProcess()` 硬编码等待 500ms(SSH 无此等待,所以 SSH 本来就快)

本插件在启动时包装 `AppService.closeTab`:

- 关闭**本地 shell** 标签时,向 PTY 发送 `Ctrl-U` + `Ctrl-D`(控制字符,不是命令),让 shell 因 EOF 正常退出 → 走 pty `exit` → `session.destroy()` → 标签移除的链路,跳过上面全部慢步骤。**不发任何命令文本,所以 history 里不会留下 `exit`。**
- 同时把该 session 的 `gracefullyKillProcess` 临时替换为 SSH 式"发信号立即返回"版本,省掉那 500ms。
- Tabby 1.x 即使单个终端也被包在 `SplitTabComponent` 里,所以插件会取分屏的所有子标签:**全部是本地 shell** 才走快速路径(全部发 EOF,靠最后一个子标签移除时自动 collapse 关闭分屏);只要有一个非本地子标签(SSH/串口等)就回退原生逻辑,保证正确。
- 若 500ms 内标签仍未关闭(如 shell 设了 `ignoreeof`、前台程序吞掉 EOF),恢复原方法并回退原生关闭。

SSH / 串口 / Telnet / 设置页等标签**完全走原生逻辑,一个字节都不碰**。

> 为什么不直接 `kill('SIGTERM')`:实测交互式 zsh 不响应 PTY 层的 SIGTERM,标签不会关闭,只会白等 500ms 再回退。EOF 走的是正常退出链路,才同时满足"快"和"不留痕"。

## 开发

源码入口是 `src/index.ts`。

```bash
npm install       # 安装构建依赖
npm run build     # 构建到 dist/index.js
npm run watch     # 开发时监听变化
```

本地调试:把 `package.json` + `dist/` 复制到 Tabby 插件目录,或用 `TABBY_PLUGINS=$(pwd) tabby --debug` 直接加载源码目录。改动后必须重启 Tabby(插件不会热重载)。

### 一个容易踩的坑

`package.json` 必须保留 `author` 字段 —— Tabby 的 `parsePluginInfo()` 会读取 `author.name`,缺失会让插件被**静默跳过**(不报错、不加载)。

## 卸载

在 Tabby 设置 → 插件里卸载,或删除插件目录:

```bash
rm -rf ~/Library/Application\ Support/tabby/plugins/node_modules/tabby-fast-close
```

## License

MIT
