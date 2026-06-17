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
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream, rmSync } from "node:fs";
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
const PERM = cfg.permissionMode || "acceptEdits";   // read-only | acceptEdits(=workspace) | full
const AGENT = (cfg.agent || "claude").toLowerCase(); // claude | codex
const CLAUDE_BIN = cfg.claudeBin || "claude";
const CODEX_BIN = cfg.codexBin || "codex";
if (!cfg.appId || !cfg.appSecret || cfg.appSecret === "PASTE_APP_SECRET_HERE") {
  console.error("[配置错误] appId / appSecret 必填");
  process.exit(1);
}
function saveCfg() {
  writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

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
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", PERM, "--add-dir", VAULT, MEDIA_DIR];
    const prev = sessions.get(chatId);
    if (prev) args.push("--resume", prev);
    const child = spawn(CLAUDE_BIN, args, { cwd: VAULT, env: process.env });

    // 图片：claude 用 Read 工具看本地路径
    const full = imagePath ? `${prompt}\n\n[用户发来一张图片，本地路径：${imagePath}。请用 Read 工具查看它。]` : prompt;
    child.stdin.write(full);
    child.stdin.end();

    let assistantText = "", finalText = "", sessionId = null;
    const handleLine = (raw) => {
      const line = raw.trim(); if (!line) return;
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === "system" && ev.subtype === "init" && ev.session_id) sessionId = ev.session_id;
      else if (ev.type === "assistant" && ev.message?.content) {
        for (const b of ev.message.content) if (b.type === "text" && b.text) { assistantText += b.text; onUpdate?.(assistantText); }
      } else if (ev.type === "result") {
        if (ev.session_id) sessionId = ev.session_id;
        if (typeof ev.result === "string" && ev.result.length) finalText = ev.result;
      }
    };
    streamLines(child, handleLine, (code, stderr, spawnErr) => {
      if (sessionId) sessions.set(chatId, sessionId);
      const out = (finalText || assistantText).trim();
      if (spawnErr) resolve({ text: stderr, error: true });
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

// ---------- 处理一条消息 ----------
async function handleText(chatId, text, imagePath) {
  const t = (text || "").trim();
  if (!imagePath && (t === "/new" || t === "/reset" || t === "新会话")) {
    sessions.delete(chatId);
    await sendCard(chatId, "已开新会话，上下文清空。", { done: true });
    return;
  }
  if (!imagePath && (t === "/help" || t === "帮助")) {
    await sendCard(chatId, `直接发消息＝问 ${AGENT_LABEL}（会话连续）。\n\`/new\` 开新会话。图片可直接发。`, { done: true });
    return;
  }

  const prompt = t || (imagePath ? "请查看这张图片并回应。" : "");
  if (!prompt && !imagePath) return;

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

// ---------- 事件分发 ----------
const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    try {
      const message = data.message, sender = data.sender;
      const senderId = sender?.sender_id?.open_id;
      const chatId = message?.chat_id, msgId = message?.message_id, chatType = message?.chat_type;
      if (!senderId || !chatId || !msgId) return;

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
      let text = "", imagePath = null;
      if (type === "text") {
        text = JSON.parse(message.content || "{}").text || "";
      } else if (type === "image") {
        const fileKey = JSON.parse(message.content || "{}").image_key;
        try { imagePath = await downloadImage(msgId, fileKey); }
        catch (e) { await sendCard(chatId, `图片下载失败：${e.message}`, { error: true }); return; }
      } else if (type === "post") {
        const c = JSON.parse(message.content || "{}");
        const lines = [];
        const content = c?.content || c?.post?.zh_cn?.content || [];
        for (const para of content) for (const node of para) if (node.text) lines.push(node.text);
        text = lines.join("\n");
      } else {
        await sendCard(chatId, `暂不支持的消息类型：${type}（先发文字或图片）`, { error: true });
        return;
      }
      if (!text.trim() && !imagePath) return;

      enqueueWork(() => handleText(chatId, text, imagePath));
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
