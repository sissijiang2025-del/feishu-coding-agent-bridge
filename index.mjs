#!/usr/bin/env node
// feishu-coding-agent-bridge —— 飞书 <-> 本地 Claude Code / Codex 桥（Windows-friendly）
//
// 为什么不撞现成工具的 Windows bug：现成的 lark-channel-bridge 发消息调编译过的
// lark-cli.exe，里面一道"取密钥脚本必须非 world-writable"的 Unix 权限审计，Windows
// 不支持这套权限、node 一律报 0666 → 审计必挂 → 收得到、回不了。本工具直接用官方
// @larksuiteoapi/node-sdk 进程内收发，没有被审计的脚本，那道坎不存在。
//
// 支持两种 agent：config.agent = "claude" | "codex"。跑两个实例（两份配置、两个飞书
// 应用）即可同时拥有 Claude bot 和 Codex bot。
//
// 配置（库外，密钥不进库/不进仓库）：默认 ~/.feishu-claude-bridge/config.json
//   也可 `node index.mjs --config <path>` 或环境变量 FEISHU_BRIDGE_CONFIG 指定另一份。

import * as Lark from "@larksuiteoapi/node-sdk";
import spawn from "cross-spawn";   // 跨平台安全 spawn：正确处理 Windows 的 .cmd/.ps1，无需 shell:true
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream, rmSync, appendFileSync, mkdtempSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ---------- 配置（支持 --config / 环境变量，便于跑多实例）----------
const argv = process.argv.slice(2);
const ci = argv.indexOf("--config");
const CFG_PATH = ci >= 0 ? argv[ci + 1]
  : (process.env.FEISHU_BRIDGE_CONFIG || join(homedir(), ".feishu-claude-bridge", "config.json"));

if (!existsSync(CFG_PATH)) {
  console.error(`[配置缺失] 没找到 ${CFG_PATH}`);
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(CFG_PATH, "utf8"));
const VAULT = cfg.vault;
const PERM = cfg.permissionMode || "full";   // read-only | acceptEdits(=workspace) | full
// PERM -> claude 的 --permission-mode 值。full=bypassPermissions（完全不设权限闸，最流畅，
// 对齐 Zara 产品的默认；红线靠"机主自己不叫它对外发送"+system prompt 规范守）。
const PERM_TO_CLAUDE = { full: "bypassPermissions", workspace: "acceptEdits", acceptEdits: "acceptEdits", "read-only": "plan" };
const CLAUDE_PERM = PERM_TO_CLAUDE[PERM] || "bypassPermissions";
// 空闲/硬超时（秒）：任一次运行超过 idle 秒无输出、或总时长超过 max 秒，自动停止，
// 免得一个卡住的 run 把整条串行队列堵死（我们旧版最致命的"整个 bot 冻结"根因）。
const IDLE_MS = (cfg.idleTimeoutSec || 300) * 1000;
const HARD_MS = (cfg.maxRunSec || 1200) * 1000;
const AGENT = (cfg.agent || "claude").toLowerCase(); // claude | codex
const CLAUDE_BIN = cfg.claudeBin || "claude";
const CODEX_BIN = cfg.codexBin || "codex";
// 模型：Claude 默认钉 opus(=最新最强 Opus 4.8)，免得 headless 默认成更轻的模型显得"呆"。
// Codex 不默认指定(用它自己的默认)。config 里写 model 可覆盖。
const MODEL = cfg.model || (AGENT === "codex" ? "" : "opus");
// 放行 lark-cli：让 Claude 能无人值守地调用飞书全套(文档/表格/画板/日历/任务/搜索…)。
// 默认关（公开仓库保守）；在 config 里设 enableLarkCli:true 开启。仅对 claude 生效。
const LARK_CLI = cfg.enableLarkCli === true && AGENT === "claude";
// im "读/建/搜" 开关：放行建群、列群、读聊天、搜消息、下载聊天附件等。
// 【故意不含】给别人发消息(+messages-send)和回复(+messages-reply)——那是机主明确拒绝的高危项。
const LARK_CLI_IM = cfg.enableLarkCliMessaging === true && LARK_CLI;
// 允许的 im 只读/创建类子命令（不含任何发送）
const IM_SAFE_SUBCMDS = ["chat-create", "chat-list", "chat-messages-list", "chat-search", "chat-update", "messages-mget", "messages-search", "messages-resources-download", "threads-messages-list"];

// 钉死 Claude 对自身环境的认知，杜绝它幻想"权限弹窗"让用户点允许
const BRIDGE_SYSTEM_PROMPT = [
  "你通过一个飞书(Lark)桥在无人值守的 headless 模式运行(claude -p)，用户在飞书里跟你私聊。",
  "【绝对规则】这里没有任何\"权限弹窗\"、没有\"点允许\"的界面——它不存在。永远不要让用户去点弹窗或授权框，也不要说\"命令已发起，等你允许\"。",
  "你能直接调用的飞书能力(通过本机已授权的全局 lark-cli，身份=机主本人)：文档 docs、表格 sheets、多维表格 base、日历 calendar、任务 task、画板 whiteboard、幻灯片 slides、知识库 wiki、妙记 minutes、云盘 drive、通讯录 contact、邮箱 mail、即时通讯 im 等全套。",
  "【对外发送红线】默认不要主动给别人发消息、发邮件、群发——除非机主在当前对话里明确要求。要替她对外发送前，先复述对象和内容跟她确认；绝不自作主张替她对外发。这条是硬规范，不是能力限制。",
  "需要某个操作时，直接执行对应的 lark-cli 命令并把真实结果告诉用户。如果某命令执行失败或未被允许，就【如实】说明失败原因，绝不编造弹窗、授权、超时等借口。",
  "【执行习惯】跑 lark-cli 命令时尽量单条、直接执行，不要用 `;`、`&&`、`|`、`echo $?` 之类把多条命令串在一起——退出码/结果我能从工具输出里看到，不用你另外 echo。"
].join("\n");
if (!cfg.appId || !cfg.appSecret || cfg.appSecret === "PASTE_APP_SECRET_HERE") {
  console.error("[配置错误] appId / appSecret 必填");
  process.exit(1);
}
function saveCfg() {
  writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

// 单实例锁：同一个飞书 app 只允许一个实例在跑（防重复双击/自启+手动叠加导致多连接抢同一 app）
const CFG_DIR = dirname(CFG_PATH);
const LOCK = join(CFG_DIR, `.lock-${cfg.appId}`);
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
if (existsSync(LOCK)) {
  const old = parseInt(String(readFileSync(LOCK, "utf8")).trim(), 10);
  if (old && pidAlive(old)) {
    console.error(`[已在运行] app ${cfg.appId} 已有实例(PID ${old})在跑，本次退出。`);
    process.exit(0);
  }
}
writeFileSync(LOCK, String(process.pid), "utf8");
function releaseLock() {
  try { if (existsSync(LOCK) && String(readFileSync(LOCK, "utf8")).trim() === String(process.pid)) rmSync(LOCK, { force: true }); } catch {}
}
process.on("exit", releaseLock);
process.on("SIGINT", () => { releaseLock(); process.exit(0); });
process.on("SIGTERM", () => { releaseLock(); process.exit(0); });
// 文件日志：把 console 输出同时写到 cfgDir/bridge-<agent>.log，方便隐藏启动时排障
const LOG_FILE = join(CFG_DIR, `bridge-${AGENT}.log`);
const _log = console.log.bind(console), _err = console.error.bind(console);
function _tee(tag, args) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}]${tag} ` + args.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n"); } catch {}
}
console.log = (...a) => { _log(...a); _tee("", a); };
console.error = (...a) => { _err(...a); _tee("[ERR]", a); };

// 别让零星的未处理错误（如 WS 断线的 promise 拒绝）直接崩掉常驻进程
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e?.stack || e));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.stack || e));

// ---------- 飞书客户端 ----------
const client = new Lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret });
const wsClient = new Lark.WSClient({ appId: cfg.appId, appSecret: cfg.appSecret });

// ---------- 状态 ----------
const sessions = new Map();      // chatId -> agent 的会话 id（claude=session_id / codex=thread_id）
const seenMsgIds = new Set();

// 下载的图片/语音存这里；必须加进 agent 的允许目录白名单，否则 agent 读不到（在库根之外）
const MEDIA_DIR = join(tmpdir(), "feishu-bridge-media");
if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });

// 全局单写队列：任一时刻只跑一个 agent，避免并发改同一目录
let workChain = Promise.resolve();
function enqueueWork(fn) {
  workChain = workChain.then(fn).catch((e) => console.error("[work]", e?.stack || e));
  return workChain;
}

// 当前正在跑的 agent 子进程句柄（串行队列，同一时刻至多一个）。/stop 靠它中断。
let activeChild = null;
function stopActive() {
  if (!activeChild) return false;
  const c = activeChild.child;
  try { c.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); } catch {} }, 3000);
  return true;
}

// 把 append-system-prompt 写进临时文件，用 --append-system-prompt-file 传，而不是塞进 argv。
// 原因（Zara 的 Windows 踩坑）：claude 在 Windows 解析成 claude.cmd，经 cmd.exe /s /c 时会把
// argv 里的引号/换行/尖括号吃掉或截断——我们旧版把整段带引号的多行 system prompt 直接塞 argv，
// 很可能在 Windows 下被污染，导致"别编权限弹窗"这类指令根本没生效。走文件就彻底避开 shell。
function writeSystemPromptFile(content) {
  const dir = mkdtempSync(join(tmpdir(), "feishu-bridge-sp-"));
  const path = join(dir, "system-prompt.md");
  writeFileSync(path, content, "utf8");
  return { path, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

// 把工具调用渲染成一行人话，实时推到卡上——这是"感觉活着"的关键（旧版执行工具时卡是静止的）。
function toolBasename(p) { return String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(p || ""); }
function toolMarker(name, input) {
  const i = input || {};
  switch (name) {
    case "Bash": { const c = String(i.command || "").replace(/\s+/g, " ").trim(); return "🔧 运行 `" + (c.length > 70 ? c.slice(0, 70) + "…" : c) + "`"; }
    case "Read": return "📖 读 " + toolBasename(i.file_path);
    case "Edit": case "MultiEdit": return "✏️ 改 " + toolBasename(i.file_path);
    case "Write": return "📝 写 " + toolBasename(i.file_path);
    case "Grep": return "🔍 搜 " + (i.pattern || "");
    case "Glob": return "🔍 找 " + (i.pattern || "");
    case "Skill": return "🧩 技能 " + (i.command || i.skill || "");
    case "Task": case "Agent": return "🤖 子任务 " + String(i.description || "").slice(0, 40);
    case "WebSearch": return "🌐 搜网 " + (i.query || "");
    case "WebFetch": return "🌐 取网页 " + (i.url || "");
    case "TodoWrite": return "📋 更新待办";
    default: return "🔧 " + name;
  }
}

// ---------- 卡片 ----------
const AGENT_LABEL = AGENT === "codex" ? "Codex" : "Claude";
function buildCard(text, { done = false, error = false } = {}) {
  const content = (text && text.length ? text : "…").slice(0, 9000);
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: error ? "red" : done ? "green" : "blue",
      title: { tag: "plain_text", content: error ? `${AGENT_LABEL} · 出错` : done ? `${AGENT_LABEL} · 完成` : `${AGENT_LABEL} · 思考中…` }
    },
    elements: [{ tag: "div", text: { tag: "lark_md", content } }]
  };
}
async function sendCard(chatId, text, opts) {
  const res = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(buildCard(text, opts)) }
  });
  return res?.data?.message_id;
}
async function patchCard(messageId, text, opts) {
  if (!messageId) return;
  try {
    await client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(buildCard(text, opts)) }
    });
  } catch (e) {
    console.error("[patchCard]", e?.message || e);
  }
}

// 通用：边读 stdout 边按行喂给 handleLine；close 时补处理尾包
function streamLines(child, handleLine, onClose) {
  let buf = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
  child.on("error", (e) => onClose(-1, `启动失败：${e.message}`, true));
  child.on("close", (code) => {
    if (buf.trim()) handleLine(buf);   // 处理无换行结尾的尾包
    onClose(code, stderr, false);
  });
}

// ---------- 跑 Claude Code（stream-json）----------
function runClaude(prompt, chatId, onUpdate, imagePath) {
  return new Promise((resolve) => {
    const sysFile = writeSystemPromptFile(BRIDGE_SYSTEM_PROMPT);
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", CLAUDE_PERM, "--add-dir", VAULT, MEDIA_DIR];
    if (MODEL) args.push("--model", MODEL);
    args.push("--append-system-prompt-file", sysFile.path);   // 走文件，避开 Windows cmd.exe 吞字符
    const prev = sessions.get(chatId);
    if (prev) args.push("--resume", prev);
    // full 档 = bypassPermissions，什么都放行，无需白名单（也就没有"命令变形被拒→幻想放行"这类摩擦）。
    // 仅在收紧档（workspace/acceptEdits）才上白名单：定向放行 lark-cli 安全域 + 无害胶水命令。
    if (CLAUDE_PERM === "acceptEdits" && LARK_CLI) {
      const safeDomains = ["docs", "sheets", "base", "calendar", "task", "whiteboard", "slides", "wiki", "minutes", "drive", "contact", "okr", "vc"];
      const allow = safeDomains.map((d) => `Bash(lark-cli ${d}:*)`);
      if (LARK_CLI_IM) for (const sc of IM_SAFE_SUBCMDS) allow.push(`Bash(lark-cli im +${sc}:*)`);
      allow.push("Skill");
      const GLUE = ["echo", "cd", "pwd", "ls", "cat", "head", "tail", "grep", "wc", "sort", "uniq", "jq", "true", "printf"];
      for (const g of GLUE) allow.push(`Bash(${g}:*)`);
      args.push("--allowedTools", ...allow);
    }
    const child = spawn(CLAUDE_BIN, args, { cwd: VAULT, env: process.env });
    activeChild = { child, chatId };

    // 图片：claude 用 Read 工具看本地路径
    const full = imagePath ? `${prompt}\n\n[用户发来一张图片，本地路径：${imagePath}。请用 Read 工具查看它。]` : prompt;
    child.stdin.write(full);
    child.stdin.end();

    // 空闲/硬超时看门狗：任一次运行卡住不再让整条队列冻结。
    let timedOut = false;
    const killChild = (why) => { timedOut = why; try { child.kill("SIGTERM"); } catch {} setTimeout(() => { try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch {} }, 3000); };
    let idleTimer = setTimeout(() => killChild("idle"), IDLE_MS);
    const hardTimer = setTimeout(() => killChild("hard"), HARD_MS);
    const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => killChild("idle"), IDLE_MS); };
    child.stdout.on("data", resetIdle);

    let assistantText = "", finalText = "", sessionId = null, display = "";
    const emit = () => onUpdate?.(display);
    const handleLine = (raw) => {
      const line = raw.trim(); if (!line) return;
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === "system" && ev.subtype === "init" && ev.session_id) sessionId = ev.session_id;
      else if (ev.type === "assistant" && ev.message?.content) {
        for (const b of ev.message.content) {
          if (b.type === "text" && b.text) {
            assistantText += b.text;
            display += (display && !display.endsWith("\n") ? "\n\n" : "") + b.text;
            emit();
          } else if (b.type === "tool_use") {
            display += (display ? "\n\n" : "") + toolMarker(b.name, b.input);   // 实时把工具调用推到卡上
            emit();
          }
        }
      } else if (ev.type === "user" && ev.message?.content) {
        for (const b of ev.message.content) if (b.type === "tool_result" && b.is_error) { display += " ⚠️"; emit(); }
      } else if (ev.type === "result") {
        if (ev.session_id) sessionId = ev.session_id;
        if (typeof ev.result === "string" && ev.result.length) finalText = ev.result;
      }
    };
    streamLines(child, handleLine, (code, stderr, spawnErr) => {
      clearTimeout(idleTimer); clearTimeout(hardTimer);
      sysFile.cleanup();
      if (activeChild && activeChild.child === child) activeChild = null;
      if (sessionId) sessions.set(chatId, sessionId);
      const out = (finalText || assistantText || display).trim();
      if (timedOut) {
        const tip = timedOut === "idle" ? `⏱️ ${Math.round(IDLE_MS / 1000)} 秒无输出，已自动停止。发条新消息可继续。` : `⏱️ 运行超过 ${Math.round(HARD_MS / 1000)} 秒，已自动停止。`;
        resolve({ text: (out ? out + "\n\n" : "") + tip, error: true });
      } else if (spawnErr) resolve({ text: stderr, error: true });
      else if (code !== 0 && !out) resolve({ text: `Claude 退出码 ${code}\n${String(stderr).slice(-1500)}`, error: true });
      else resolve({ text: out || "(无输出)", error: false });
    });
  });
}

// ---------- 跑 Codex（codex exec --json）----------
function runCodex(prompt, chatId, onUpdate, imagePath) {
  return new Promise((resolve) => {
    // permissionMode -> codex sandbox
    const sandboxFlags = PERM === "read-only" ? ["--sandbox", "read-only"]
      : PERM === "full" ? ["--dangerously-bypass-approvals-and-sandbox"]
      : ["--sandbox", "workspace-write"];
    const flags = ["--json", "--skip-git-repo-check", "-C", VAULT, "--add-dir", MEDIA_DIR, ...sandboxFlags];
    if (MODEL) flags.push("-m", MODEL);
    if (imagePath) flags.push("-i", imagePath);
    const prev = sessions.get(chatId);
    // prompt 走参数（codex exec 的 stdin 会挂；cross-spawn 无 shell，参数传递安全）
    const args = prev ? ["exec", "resume", prev, ...flags, prompt] : ["exec", ...flags, prompt];
    const child = spawn(CODEX_BIN, args, { cwd: VAULT, env: process.env });
    child.stdin.end();   // 关掉 stdin，别让 codex 等输入

    let assistantText = "", threadId = null;
    const handleLine = (raw) => {
      const line = raw.trim(); if (!line) return;
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === "thread.started" && ev.thread_id) threadId = ev.thread_id;
      else if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) {
        assistantText += (assistantText ? "\n\n" : "") + ev.item.text;
        onUpdate?.(assistantText);
      }
    };
    streamLines(child, handleLine, (code, stderr, spawnErr) => {
      if (threadId) sessions.set(chatId, threadId);
      const out = assistantText.trim();
      if (spawnErr) resolve({ text: stderr, error: true });
      else if (code !== 0 && !out) resolve({ text: `Codex 退出码 ${code}\n${String(stderr).slice(-1500)}`, error: true });
      else resolve({ text: out || "(无输出)", error: false });
    });
  });
}

const runAgent = AGENT === "codex" ? runCodex : runClaude;

// ---------- 下载图片 ----------
async function downloadImage(messageId, fileKey) {
  const safe = String(fileKey).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "img";
  const dest = join(MEDIA_DIR, `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}.png`);
  const resp = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: "image" }
  });
  try {
    await pipeline(resp.getReadableStream(), createWriteStream(dest));
  } catch (e) {
    try { rmSync(dest, { force: true }); } catch {}
    throw e;
  }
  return dest;
}

// ---------- 下载文件附件（docx/pdf/xls/任意 file 消息）----------
// 飞书 file 消息 content = { file_key, file_name }。用 messageResource.get(type:"file") 取流，
// 落到 MEDIA_DIR（已在 agent 的 --add-dir 白名单里，库外也能读）。保留原文件名后缀，
// 后缀决定 agent 用什么方式读（见 attachmentHint）。
async function downloadFile(messageId, fileKey, fileName) {
  // 保留中文/字母数字/点/连字符；取末尾 80 字符（保住扩展名），其余替成 _
  const safeName = String(fileName || "file").replace(/[^\w.一-龥-]/g, "_").slice(-80) || "file";
  const dest = join(MEDIA_DIR, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`);
  const resp = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: "file" }
  });
  try {
    await pipeline(resp.getReadableStream(), createWriteStream(dest));
  } catch (e) {
    try { rmSync(dest, { force: true }); } catch {}
    throw e;
  }
  return dest;
}

// 按扩展名给 agent 一段明确的读法指引（拼进 prompt）。
// 关键：docx/xlsx/pptx 是 zip 包，Read 工具读不了，必须解压 XML（库里有 SOP）。
function attachmentHint(filePath, fileName) {
  const ext = (String(fileName || filePath || "").toLowerCase().match(/\.[a-z0-9]+$/) || [""])[0];
  const head = `\n\n[用户发来一个文件「${fileName || "(未命名)"}」，已下载到本地：${filePath}。`;
  const readable = [".pdf", ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".xml", ".html", ".htm", ".yaml", ".yml", ".rtf"];
  if (readable.includes(ext)) {
    return `${head}请直接用 Read 工具读取它的内容，再回应。]`;
  }
  if ([".docx", ".xlsx", ".pptx"].includes(ext)) {
    return `${head}这是 Office (zip) 格式，Read 工具读不了——用「内联」PowerShell 命令 + System.IO.Compression 解压提取文本（不要写成 .ps1 文件再执行，headless 下执行外部脚本会被审批闸拦；内联命令可以跑）：docx 读 word/document.xml；xlsx 读 xl/sharedStrings.xml 与 xl/worksheets/sheet*.xml；pptx 读 ppt/slides/slide*.xml。提取出文字后再回应。]`;
  }
  if ([".doc", ".xls", ".ppt"].includes(ext)) {
    return `${head}这是老式 Office 二进制格式（非 zip），无法直接解压。先尝试用现有工具/脚本解析；若确实读不出，就如实告诉用户这是 ${ext} 旧格式、建议另存为新格式或贴文字。]`;
  }
  return `${head}先判断能否解析这种格式（${ext || "无扩展名"}）：文本类用 Read；Office(.docx/.xlsx/.pptx) 用 PowerShell 解压 XML；若是无法解析的二进制，如实告诉用户。]`;
}

// ---------- 处理一条消息 ----------
async function handleText(chatId, text, imagePath, filePath, fileName) {
  const t = (text || "").trim();
  if (!imagePath && !filePath && (t === "/new" || t === "/reset" || t === "新会话")) {
    sessions.delete(chatId);
    await sendCard(chatId, "已开新会话，上下文清空。", { done: true });
    return;
  }
  if (!imagePath && !filePath && (t === "/help" || t === "帮助")) {
    await sendCard(chatId, `直接发消息＝问 ${AGENT_LABEL}（会话连续，执行时工具调用会实时显示在卡上）。\n\`/new\` 开新会话；\`/stop\`（或"停"）中断当前任务。图片、文件（Word/PDF/Excel 等）都可直接发。`, { done: true });
    return;
  }

  let prompt = t || (imagePath ? "请查看这张图片并回应。" : (filePath ? "请查看我发来的这个文件，读出内容后回应。" : ""));
  if (!prompt && !imagePath && !filePath) return;
  if (filePath) prompt += attachmentHint(filePath, fileName);

  const msgId = await sendCard(chatId, "🤔 …");
  let patchChain = Promise.resolve();
  const queuePatch = (txt, opts) => { patchChain = patchChain.then(() => patchCard(msgId, txt, opts)).catch(() => {}); return patchChain; };
  let lastPatch = 0, lastText = "";
  const { text: out, error } = await runAgent(prompt, chatId, (partial) => {
    const now = Date.now();
    if (now - lastPatch > 800 && partial !== lastText) { lastPatch = now; lastText = partial; queuePatch(partial); }
  }, imagePath);
  await patchChain;
  await patchCard(msgId, out, { done: !error, error });
}

// 从飞书交互卡片里尽力抽取可读文本 + 链接（用于转发进来的卡片，如妙记/文档通知）
function extractCardText(node, out = []) {
  if (node == null || typeof node === "string" || typeof node === "number") return out;
  if (Array.isArray(node)) { for (const x of node) extractCardText(x, out); return out; }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string") {
        if (k === "content" || k === "text") out.push(v);
        else if (/url|href|link/i.test(k)) out.push(v);
      } else extractCardText(v, out);
    }
  }
  return out;
}

// ---------- 事件分发 ----------
const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    try {
      const message = data.message, sender = data.sender;
      const senderId = sender?.sender_id?.open_id;
      const chatId = message?.chat_id, msgId = message?.message_id, chatType = message?.chat_type;
      if (!senderId || !chatId || !msgId) return;

      // [临时诊断 2026-07-01] 打印每条收到的事件，用于判断群消息(不@)有没有被飞书推送过来。测通后删掉这一行。
      console.log(`[事件] type=${chatType} mt=${message?.message_type} chat=${chatId} sender=${senderId}`);

      if (seenMsgIds.has(msgId)) return;
      seenMsgIds.add(msgId);
      if (seenMsgIds.size > 500) seenMsgIds.clear();

      // 认主：只接受【私聊】首条来认主（群聊不能抢占）
      if (!cfg.owner) {
        if (chatType !== "p2p") { console.log(`[忽略] 未认主前只接受私聊认主（chat_type=${chatType}）`); return; }
        cfg.owner = senderId; saveCfg(); console.log(`[认主] owner = ${senderId}`);
      }
      if (senderId !== cfg.owner) { console.log(`[忽略] 非机主 ${senderId}`); return; }

      const type = message.message_type;
      let text = "", imagePath = null, filePath = null, fileName = null;
      if (type === "text") {
        text = JSON.parse(message.content || "{}").text || "";
      } else if (type === "image") {
        const fileKey = JSON.parse(message.content || "{}").image_key;
        try { imagePath = await downloadImage(msgId, fileKey); }
        catch (e) { await sendCard(chatId, `图片下载失败：${e.message}`, { error: true }); return; }
      } else if (type === "file") {
        // 上传的文件附件（Word/PDF/Excel/任意 file）：下载到本地，交给 agent 按后缀读
        const c = JSON.parse(message.content || "{}");
        fileName = c.file_name || "file";
        try { filePath = await downloadFile(msgId, c.file_key, fileName); }
        catch (e) { await sendCard(chatId, `文件下载失败：${e.message}`, { error: true }); return; }
      } else if (type === "post") {
        const c = JSON.parse(message.content || "{}");
        const lines = [];
        const content = c?.content || c?.post?.zh_cn?.content || [];
        for (const para of content) for (const node of para) if (node.text) lines.push(node.text);
        text = lines.join("\n");
      } else if (type === "interactive") {
        // 转发进来的卡片（妙记/文档通知等）：抽取文字+链接交给 Claude
        const c = JSON.parse(message.content || "{}");
        const parts = [...new Set(extractCardText(c).map((s) => s.trim()).filter(Boolean))];
        text = parts.join("\n").trim();
        if (!text) { await sendCard(chatId, "（收到一张卡片，但没抽出可读内容，先忽略了）", { done: true }); return; }
        text = `[我转发了一张飞书卡片，内容/链接如下，请理解并按需处理（如是妙记/文档/云盘链接，可用 lark-cli 进一步获取）]\n${text}`;
      } else {
        await sendCard(chatId, `（收到一条 ${type} 消息，目前只处理文字/图片/文件/卡片，先忽略了）`, { done: true });
        return;
      }
      if (!text.trim() && !imagePath && !filePath) return;

      // /stop 必须在入队【之前】即时处理——否则它会排在正卡住的那个 run 后面，永远轮不到。
      const tt = text.trim();
      if (!imagePath && !filePath && (tt === "/stop" || tt === "停" || tt === "停止" || tt === "取消")) {
        const stopped = stopActive();
        await sendCard(chatId, stopped ? "🛑 已停止当前任务。" : "现在没有正在跑的任务。", { done: true });
        return;
      }

      enqueueWork(() => handleText(chatId, text, imagePath, filePath, fileName));
    } catch (e) {
      console.error("[事件处理出错]", e?.stack || e);
    }
  }
});

// ---------- 启动 ----------
console.log("====================================");
console.log(` feishu-bridge 启动中… (agent=${AGENT})`);
console.log(` app: ${cfg.appId}`);
console.log(` 工作目录: ${VAULT}`);
console.log(` 权限档: ${PERM}`);
console.log(` 配置: ${CFG_PATH}`);
console.log(` 机主: ${cfg.owner || "（未认主，等你私聊发第一条消息）"}`);
console.log("====================================");
wsClient.start({ eventDispatcher });
