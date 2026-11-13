#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { accessSync, appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

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
const CONTEXT_WINDOW = 200_000;
const LONG_CONTEXT_WINDOW = 1_000_000;
// Each ask line ends with its panel id, triage and git facts hidden in zero-width
// characters, so cmux's own sidebar shows only the ask while bossview can still read them.
const ZERO_WIDTH = ["\u200b", "\u200c", "\u200d", "\u2060"];
// cmux trims a trailing \u200b, so every hidden run ends with a word joiner.
const TAG_END = "\u2060";
const TRIAGE = ["blocked", "approve", "decide", "review", "done", "working"];

const SYSTEM_PROMPT = `You triage one AI coding session for a busy boss.
You get the boss's last request, the agent's latest message, and sometimes a pending prompt.
Reply with only a JSON object: {"triage": "...", "ask": "..."}

triage, by how much the session needs the boss:
- "blocked": the agent hit an error or needs something only the boss can provide (credentials, files, access).
- "approve": the agent is waiting for permission to run or change something.
- "decide": the agent asked a question or needs the boss to choose.
- "review": the agent changed code or files, or produced work the boss should check before it counts.
- "done": the boss got what they came for (a question answered, an explanation, a task already verified) and nothing is pending, so the session can be closed.
- "working": the agent ended its turn but is still waiting on its own background work (subagents, background commands) and will continue by itself.

ask: at most 8 words, no trailing period. For "done", say what was settled. For "working", say what it is waiting on. Otherwise say what the boss should do next, in imperative mood.

Examples:
{"triage": "decide", "ask": "Pick auth library: Clerk or Auth0"}
{"triage": "approve", "ask": "Approve running database migration"}
{"triage": "blocked", "ask": "Add STRIPE_KEY to .env"}
{"triage": "review", "ask": "Check the login bug fix"}
{"triage": "done", "ask": "Answered how cache invalidation works"}
{"triage": "working", "ask": "Waiting on staff engineer review"}`;

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

function contextPercent(transcriptPath) {
  let used = null;
  let window = CONTEXT_WINDOW;
  for (const line of readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES).split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain) continue;

    if (entry.type === "api-request") {
      const betas = entry.params?.betas ?? [];
      window = betas.some((beta) => beta.startsWith("context-1m")) ? LONG_CONTEXT_WINDOW : CONTEXT_WINDOW;
    }

    const usage = entry.type === "assistant" && entry.message?.model !== "<synthetic>" ? entry.message?.usage : null;
    if (usage) {
      used = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens + usage.output_tokens;
    }
  }
  if (used === null) return null;

  return Math.round((used / window) * 100);
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

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function defaultBranch(cwd) {
  try {
    return git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  } catch {
    return "";
  }
}

const GITLAB_STATE = { opened: "OPEN", merged: "MERGED", closed: "CLOSED" };

function run(cwd, command, args) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function toMergeRequest(mr) {
  return { label: "MR !" + mr.iid, state: GITLAB_STATE[mr.state] };
}

function linkedMergeRequest(cwd, transcriptPath) {
  const links = readFileSync(transcriptPath, "utf8").split("\n").filter((line) => line.includes('"type":"pr-link"'));
  if (!links.length) return null;

  const link = JSON.parse(links.at(-1));
  const repo = new URL(link.prUrl).host + "/" + link.prRepository;
  const out = run(cwd, "glab", ["mr", "view", String(link.prNumber), "-R", repo, "--output", "json"]);
  return toMergeRequest(JSON.parse(out));
}

function branchMergeRequest(cwd, branch) {
  const out = run(cwd, "glab", ["mr", "list", "--source-branch", branch, "--all", "--per-page", "1", "--output", "json"]);
  const mr = JSON.parse(out)[0];
  if (!mr) return null;

  return toMergeRequest(mr);
}

function mergeRequest(cwd, branch, transcriptPath) {
  try {
    return linkedMergeRequest(cwd, transcriptPath) ?? branchMergeRequest(cwd, branch);
  } catch {
    return null;
  }
}

function repoName(cwd) {
  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return basename(dirname(commonDir));
}

function workingFacts(cwd, transcriptPath) {
  const facts = { context: contextPercent(transcriptPath) };
  try {
    facts.repo = repoName(cwd);
  } catch {}
  return facts;
}

function gitFacts(cwd, transcriptPath) {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const base = defaultBranch(cwd);
  const onBase = !base || base.endsWith("/" + branch);
  const ahead = onBase ? 0 : Number(git(cwd, ["rev-list", "--count", "HEAD", "--not", base]));
  return {
    repo: repoName(cwd),
    branch,
    dirty: git(cwd, ["status", "--porcelain"]) !== "",
    unpushed: Number(git(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"])),
    ahead,
    mr: ahead > 0 ? mergeRequest(cwd, branch, transcriptPath) : null,
  };
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

function hideText(text) {
  return [...Buffer.from(text, "utf8")].map((byte) => hide(byte >> 4) + hide(byte & 15)).join("");
}

function hiddenTag(id) {
  return [...id.slice(0, 8).toUpperCase()].map((c) => hide(parseInt(c, 16))).join("");
}

function hiddenRun(line) {
  return line.match(/[\u200b\u200c\u200d\u2060]+$/)?.[0] ?? "";
}

function belongsTo(line, tag) {
  return hiddenRun(line).startsWith(tag) || /^\[[0-9A-F]{8}\] /.test(line);
}

function setAsk(workspaceId, sessionId, panelId, result, facts) {
  const tag = hiddenTag(sessionId);
  const panelTag = hiddenTag(panelId);
  const lines = workspaceDescription(workspaceId).split("\n").filter((l) => l && !belongsTo(l, tag) && !belongsTo(l, panelTag));
  if (result) {
    const hiddenFacts = facts ? hideText(JSON.stringify(facts)) : "";
    lines.push(result.ask + tag + hide(TRIAGE.indexOf(result.triage)) + hiddenFacts + TAG_END);
  }
  const args = lines.length
    ? ["workspace-action", "--action", "set-description", "--workspace", workspaceId, "--description", lines.join("\n")]
    : ["workspace-action", "--action", "clear-description", "--workspace", workspaceId];
  execFileSync(CMUX, args, { stdio: "ignore" });
}

function generationPath(sessionId) {
  return join(STATE_DIR, `${sessionId}.gen`);
}

function bumpGeneration(sessionId) {
  mkdirSync(STATE_DIR, { recursive: true });
  const gen = `${Date.now()}-${process.pid}`;
  writeFileSync(generationPath(sessionId), gen);
  return gen;
}

function isCurrent(sessionId, gen) {
  try {
    return readFileSync(generationPath(sessionId), "utf8") === gen;
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
  const facts = { context: contextPercent(job.transcriptPath) };
  try {
    Object.assign(facts, gitFacts(job.cwd, job.transcriptPath));
  } catch {}
  if (isCurrent(job.sessionId, job.gen)) setAsk(job.workspaceId, job.sessionId, job.panelId, result, facts);
}

function hasVerdict(workspaceId, sessionId) {
  const tag = hiddenTag(sessionId);
  const working = tag + hide(TRIAGE.indexOf("working"));
  return workspaceDescription(workspaceId).split("\n").some((l) => belongsTo(l, tag) && !hiddenRun(l).startsWith(working));
}

// An interrupted turn fires no Stop, so the 60-second idle notification is the
// only signal that the session is waiting on the boss again.
function needsTriage(event, input, workspaceId) {
  if (event === "Stop") return true;
  if (event !== "Notification") return false;
  if (input.notification_type === "idle_prompt") return !hasVerdict(workspaceId, input.session_id);
  return input.notification_type === "permission_prompt" || input.notification_type === "elicitation_dialog";
}

function handleHook(input) {
  const workspaceId = process.env.CMUX_WORKSPACE_ID;
  const panelId = process.env.CMUX_PANEL_ID ?? process.env.CMUX_SURFACE_ID;
  const sessionId = input.session_id;
  const event = input.hook_event_name;
  if (!workspaceId || !panelId || !sessionId) return;

  const headless = process.env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli";
  if (headless) return;

  if (event === "SessionEnd") {
    bumpGeneration(sessionId);
    setAsk(workspaceId, sessionId, panelId, null);
    return;
  }

  if (event === "UserPromptSubmit") {
    bumpGeneration(sessionId);
    const firstLine = String(input.prompt ?? "").trim().split("\n")[0];
    const ask = firstLine.slice(0, 90) || "Working";
    setAsk(workspaceId, sessionId, panelId, { triage: "working", ask }, workingFacts(input.cwd, input.transcript_path));
    return;
  }
  if (!needsTriage(event, input, workspaceId)) return;

  const job = {
    workspaceId, sessionId, panelId,
    gen: bumpGeneration(sessionId),
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
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

function isHeadless(record) {
  const args = record.stored_pid_arguments ?? [];
  return args.includes("-p") || args.includes("--print");
}

function idleSessions() {
  const live = liveSurfaceIds();
  const listing = execFileSync(CMUX, ["sessions", "list", "--agent", "claude", "--all", "--json"], { encoding: "utf8" });
  return (JSON.parse(listing).sessions ?? []).filter(
    (record) => live.has(record.surface_id)
      && record.stored_pid_exists
      && record.transcript_path
      && record.agent_lifecycle === "idle"
      && !isHeadless(record),
  );
}

function backfill() {
  for (const session of idleSessions()) {
    const workspaceId = session.workspace_id;
    const sessionId = session.session_id;
    if (hasVerdict(workspaceId, sessionId)) continue;

    try {
      runJob({
        workspaceId, sessionId,
        panelId: session.surface_id,
        gen: bumpGeneration(sessionId),
        transcriptPath: session.transcript_path,
        cwd: session.cwd,
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
