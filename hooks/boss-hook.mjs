#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { accessSync, appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// cmux puts a claude shim first on PATH that wraps every call like a user session;
// the triage call has to reach the real binary.
function realClaude() {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir || dir.includes("cmux-cli-shims")) continue;
    try {
      accessSync(join(dir, "claude"), constants.X_OK);
      return join(dir, "claude");
    } catch {}
  }
  return "claude";
}

const CLAUDE = process.env.BOSSVIEW_CLAUDE ?? realClaude();
const CMUX = process.env.CMUX_BUNDLED_CLI_PATH ?? "cmux";
const STATE_DIR = join(homedir(), ".bossview");
const TRANSCRIPT_TAIL_BYTES = 400_000;
const CONTEXT_CHARS = 3000;
// Each ask line ends with its panel id and triage hidden in zero-width characters,
// so cmux's own sidebar shows only the ask while bossview can still read both.
const ZERO_WIDTH = ["\u200b", "\u200c", "\u200d", "\u2060"];
// cmux trims a trailing \u200b, so every hidden run ends with a word joiner.
const TAG_END = "\u2060";
const TRIAGE = ["blocked", "approve", "decide", "review", "done"];

const SYSTEM_PROMPT = `You triage one AI coding session for a busy boss.
You get the boss's last request, the agent's latest message, and sometimes a pending prompt.
Reply with only a JSON object: {"triage": "...", "ask": "..."}

triage, by how much the session needs the boss:
- "blocked": the agent hit an error or needs something only the boss can provide (credentials, files, access).
- "approve": the agent is waiting for permission to run or change something.
- "decide": the agent asked a question or needs the boss to choose.
- "review": the agent changed code or files, or produced work the boss should check before it counts.
- "done": the boss got what they came for (a question answered, an explanation, a task already verified) and nothing is pending, so the session can be closed.

ask: at most 8 words, no trailing period. For "done", say what was settled. Otherwise say what the boss should do next, in imperative mood.

Examples:
{"triage": "decide", "ask": "Pick auth library: Clerk or Auth0"}
{"triage": "approve", "ask": "Approve running database migration"}
{"triage": "blocked", "ask": "Add STRIPE_KEY to .env"}
{"triage": "review", "ask": "Check the login bug fix"}
{"triage": "done", "ask": "Answered how cache invalidation works"}`;

function log(message) {
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(join(STATE_DIR, "hook.log"), `${new Date().toISOString()} ${message}\n`);
}

function readTail(path, bytes) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    closeSync(fd);
  }
}

function textOf(content) {
  if (typeof content === "string") return content;
  return (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function lastExchange(transcriptPath) {
  let request = "";
  let reply = [];
  for (const line of readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES).split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain || entry.isMeta) continue;
    const text = textOf(entry.message?.content).trim();
    if (!text) continue;
    if (entry.type === "user" && !text.startsWith("<")) {
      request = text;
      reply = [];
    } else if (entry.type === "assistant") {
      reply.push(text);
    }
  }
  return { request: request.slice(0, 500), reply: reply.join("\n").slice(-CONTEXT_CHARS) };
}

function parseTriage(out, notice) {
  let result;
  try {
    result = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] ?? "");
  } catch {
    result = { ask: out.trim().split("\n")[0] };
  }
  const triage = notice ? "approve" : TRIAGE.includes(result.triage) ? result.triage : "decide";
  const ask = String(result.ask ?? "").trim().replace(/[.\s]+$/, "").slice(0, 90);
  return { triage, ask: ask || "Check this session" };
}

function triageSession({ request, reply }, notice) {
  const input = [
    `Boss's last request:\n${request || "(none)"}`,
    `Agent's latest message:\n${reply || "(none)"}`,
    notice ? `Pending prompt:\n${notice}` : "",
  ].filter(Boolean).join("\n\n");
  const env = { ...process.env, BOSSVIEW_SUMMARIZER: "1" };
  for (const key of Object.keys(env)) if (key.startsWith("CMUX_")) delete env[key];
  const out = execFileSync(CLAUDE, [
    "-p", "--model", "haiku",
    "--setting-sources", "", "--strict-mcp-config", "--tools", "", "--no-session-persistence",
    "--system-prompt", SYSTEM_PROMPT,
  ], { input, env, encoding: "utf8", timeout: 60_000 });
  return parseTriage(out, notice);
}

function workspaceDescription(workspaceId) {
  const tree = JSON.parse(execFileSync(CMUX, ["tree", "--all", "--json"], { encoding: "utf8" }));
  for (const window of tree.windows ?? []) {
    for (const ws of window.workspaces ?? []) if (ws.id === workspaceId) return ws.description ?? "";
  }
  return "";
}

function hide(n) {
  return ZERO_WIDTH[n >> 2] + ZERO_WIDTH[n & 3];
}

function hiddenTag(panelId) {
  return [...panelId.slice(0, 8).toUpperCase()].map((c) => hide(parseInt(c, 16))).join("");
}

function belongsTo(line, tag) {
  const hidden = line.match(/[\u200b\u200c\u200d\u2060]+$/)?.[0] ?? "";
  return hidden.startsWith(tag) || /^\[[0-9A-F]{8}\] /.test(line);
}

function setAsk(workspaceId, panelId, result) {
  const tag = hiddenTag(panelId);
  const lines = workspaceDescription(workspaceId).split("\n").filter((l) => l && !belongsTo(l, tag));
  if (result) lines.push(result.ask + tag + hide(TRIAGE.indexOf(result.triage)) + TAG_END);
  const args = lines.length
    ? ["workspace-action", "--action", "set-description", "--workspace", workspaceId, "--description", lines.join("\n")]
    : ["workspace-action", "--action", "clear-description", "--workspace", workspaceId];
  execFileSync(CMUX, args, { stdio: "ignore" });
}

function generationPath(panelId) {
  return join(STATE_DIR, `${panelId}.gen`);
}

function bumpGeneration(panelId) {
  mkdirSync(STATE_DIR, { recursive: true });
  const gen = `${Date.now()}-${process.pid}`;
  writeFileSync(generationPath(panelId), gen);
  return gen;
}

function isCurrent(panelId, gen) {
  try {
    return readFileSync(generationPath(panelId), "utf8") === gen;
  } catch {
    return false;
  }
}

// Stop can fire before the final reply is flushed to the transcript, so prefer
// the copy Claude Code hands the hook directly.
function runJob(job) {
  const exchange = lastExchange(job.transcriptPath);
  if (job.reply) exchange.reply = job.reply.slice(-CONTEXT_CHARS);
  const result = triageSession(exchange, job.notice);
  if (isCurrent(job.panelId, job.gen)) setAsk(job.workspaceId, job.panelId, result);
}

function hasAsk(workspaceId, panelId) {
  const tag = hiddenTag(panelId);
  return workspaceDescription(workspaceId).split("\n").some((l) => belongsTo(l, tag));
}

// An interrupted turn fires no Stop, so the 60-second idle notification is the
// only signal that the session is waiting on the boss again.
function needsTriage(event, input, workspaceId, panelId) {
  if (event === "Stop") return true;
  if (event !== "Notification") return false;
  if (input.notification_type === "idle_prompt") return !hasAsk(workspaceId, panelId);
  return input.notification_type === "permission_prompt" || input.notification_type === "elicitation_dialog";
}

function handleHook(input) {
  const workspaceId = process.env.CMUX_WORKSPACE_ID;
  const panelId = process.env.CMUX_PANEL_ID ?? process.env.CMUX_SURFACE_ID;
  const event = input.hook_event_name;
  if (!workspaceId || !panelId) return;

  if (event === "UserPromptSubmit" || event === "SessionEnd") {
    bumpGeneration(panelId);
    setAsk(workspaceId, panelId, null);
    return;
  }
  if (!needsTriage(event, input, workspaceId, panelId)) return;

  const job = {
    workspaceId, panelId,
    gen: bumpGeneration(panelId),
    transcriptPath: input.transcript_path,
    notice: input.notification_type === "permission_prompt" ? input.message : "",
    reply: input.last_assistant_message ?? "",
  };
  spawn(process.execPath, [process.argv[1], "--job"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, BOSSVIEW_JOB: JSON.stringify(job) },
  }).unref();
}

function liveSurfaceIds() {
  const tree = JSON.parse(execFileSync(CMUX, ["tree", "--all", "--json", "--id-format", "uuids"], { encoding: "utf8" }));
  const ids = new Set();
  for (const window of tree.windows ?? []) {
    for (const ws of window.workspaces ?? []) {
      for (const pane of ws.panes ?? []) {
        for (const surface of pane.surfaces ?? []) ids.add(surface.id);
      }
    }
  }
  return ids;
}

function idleSessions() {
  const live = liveSurfaceIds();
  const listing = execFileSync(CMUX, ["sessions", "list", "--agent", "claude", "--all", "--json"], { encoding: "utf8" });
  const newestBySurface = new Map();
  for (const record of JSON.parse(listing).sessions ?? []) {
    if (!live.has(record.surface_id)) continue;
    const newest = newestBySurface.get(record.surface_id);
    if (!newest || record.updated_at_unix > newest.updated_at_unix) newestBySurface.set(record.surface_id, record);
  }
  return [...newestBySurface.values()].filter(
    (record) => record.stored_pid_exists && record.transcript_path && record.agent_lifecycle === "idle",
  );
}

function backfill() {
  for (const session of idleSessions()) {
    const workspaceId = session.workspace_id;
    const panelId = session.surface_id;
    if (hasAsk(workspaceId, panelId)) continue;

    try {
      runJob({
        workspaceId, panelId,
        gen: bumpGeneration(panelId),
        transcriptPath: session.transcript_path,
        notice: "",
        reply: "",
      });
    } catch (err) {
      log(err.stack ?? String(err));
    }
  }
}

try {
  if (process.argv.includes("--job")) {
    runJob(JSON.parse(process.env.BOSSVIEW_JOB));
  } else if (process.argv.includes("--backfill")) {
    backfill();
  } else if (!process.env.BOSSVIEW_SUMMARIZER) {
    handleHook(JSON.parse(readFileSync(0, "utf8") || "{}"));
  }
} catch (err) {
  log(err.stack ?? String(err));
}
