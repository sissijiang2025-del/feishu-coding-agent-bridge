# feishu-coding-agent-bridge

**飞书（Lark）里直接私聊指挥本地的 Claude Code 或 Codex，回复以卡片流式返回。**
**Drive your local Claude Code / Codex CLI from Feishu (Lark) chat. Built for Windows.**

> ⚠️ **For Windows users** — 这个项目就是为了解决现成工具在 **Windows** 上的兼容问题而写的（见下）。在 macOS/Linux 上现成工具一般能用，本项目对你的价值主要在 Windows。

## 为什么有这个项目 / Why this exists

现成的同类桥（如 `lark-channel-bridge` / `lark-coding-agent-bridge`）发消息时会调用一个编译好的 `lark-cli` 二进制，它对"取密钥脚本"做一道 Unix 文件权限审计（要求该脚本非 world-writable）。

**Windows 不支持这套 Unix 文件权限模型**，Node 一律把文件 mode 报成 `0666`（"谁都可写"），于是审计在 Windows 上**必然失败** → bot 收得到消息、却回不了（卡片显示 `(no content)`）。这个审计逻辑在编译过的二进制里，改不动；配置每次重启又会被重写。

本项目不依赖那条链路：**直接用官方 `@larksuiteoapi/node-sdk` 在 Node 进程内收/发**，没有被审计的脚本，那道坎根本不存在。

## 工作方式 / How it works

```
飞书消息 → SDK 长连接(WSClient)收 → 本地 agent CLI 跑 → 卡片流式回飞书
```

- 收消息走长连接，**不需要公网地址、不需要开端口**。
- 回复用飞书交互卡片，边生成边更新，完成时定稿。
- 支持两种 agent：**Claude Code** 和 **Codex**（`config.agent` 切换）。

## 安全模型 / Security model

- **只服务机主一人**：第一个**私聊** bot 的人被记为 `owner`（群聊不能抢占）；之后只服务 owner，其他人静默忽略。
- **密钥不进仓库**：App Secret 只存本机配置文件，不在代码里。
- **跨会话全局单写队列**：任一时刻只跑一个 agent，避免并发改同一目录。
- Claude：prompt 走 stdin（不进命令行）；Codex：prompt 走参数 + cross-spawn 无 shell（均无注入面）。

## 安装 / Install

```bash
npm install
```
需先装好并登录 [Claude Code](https://claude.com/claude-code)（用 Claude）或 [Codex](https://github.com/openai/codex)（用 Codex），对应 CLI 在 PATH 上。

## 配置 / Config

默认读 `~/.feishu-claude-bridge/config.json`（Windows = `%USERPROFILE%\.feishu-claude-bridge\config.json`）。
跑多个实例时用 `node index.mjs --config <另一份路径>` 指定。

```json
{
  "appId": "cli_xxxxxxxxxxxx",
  "appSecret": "你的 App Secret（飞书开放平台 → 该应用 → 凭证与基础信息）",
  "vault": "C:/path/to/your/working-dir",
  "agent": "claude",
  "permissionMode": "acceptEdits",
  "owner": null,
  "claudeBin": "claude",
  "codexBin": "codex"
}
```

- `agent`：`"claude"` 或 `"codex"`。
- `vault`：agent 的工作目录（Windows 路径用正斜杠最省事）。
- `permissionMode`：`read-only` | `acceptEdits`（=workspace 写） | `full`。
  - Claude 映射到 `--permission-mode`；Codex 映射到 `--sandbox`（read-only / workspace-write / 完全放开）。
- `owner`：留 `null`，第一条私聊自动认主。

## 跑两个 bot（Claude + Codex）/ Running both

每个 bot 需要一个**独立的飞书应用**（各自 appId/secret）。准备两份配置，分别 `agent: "claude"` 和 `agent: "codex"`，然后开两个进程：

```bash
node index.mjs --config "%USERPROFILE%\.feishu-claude-bridge\config.json"
node index.mjs --config "%USERPROFILE%\.feishu-claude-bridge\config.codex.json"
```

## ⚠️ Codex 的额外注意

Claude Code 会读工作目录里的 `.claude/settings.json`（deny 规则、PreToolUse hook 等保护）。**Codex 不认这些。** 所以如果你用 `agent: codex` + `workspace-write` 指向一个含敏感文件的目录，那些文件不受 Claude 那套保护。建议给 Codex bot 用 `read-only`，或指向一个专门的工作目录。

## 开机自启（Windows，可选）/ Autostart

双击 `设置开机自启.vbs` 一次 → 在「启动」文件夹建快捷方式，之后每次登录隐藏启动。取消：删掉启动文件夹里的 `FeishuClaudeBridge` 快捷方式（Win+R → `shell:startup`）。
> 本地进程，只在电脑开机并登录时在线。
> 默认那份脚本启动的是默认配置（Claude）。要自启 Codex 实例，复制一份 `start-hidden.vbs` 改成带 `--config <codex配置>` 即可。

## License

MIT
