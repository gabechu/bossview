// bossview: a board of your Claude Code sessions, sorted by what they need from you.
// Built for a wide pane:  cmux sidebar open bossview
// Spacing, type scale and palette follow agent-orchestrator's SessionsBoardView
// and tokens.css (dark theme).

const TOKEN = {
  surface: "#ffffff0a",
  border: "#ffffff12",
  borderStrong: "#ffffff0a",
  hover: "#ffffff0a",
  claude: "#D97757",
};

const KAWAII = {
  body: "#FFD3B6",
  ink: "#3D2C2C",
  blush: "#FF9AA2",
  board: "#FFFFFF",
  blocks: ["#FF8FA3", "#8FD3F5", "#9BE3B5"],
};

const FONT = { "2xs": 10.5, xs: 12, smMd: 11.5, title: 15 };
const RADIUS_LG = 10;
const ICON_2XS = 12;
const HEADER_HEIGHT = 48;

// Columns run from most to least of your attention; finished sessions sit last, ready to close.
const LANES = [
  { id: "needs", label: "Needs you", color: "#f06445" },
  { id: "review", label: "Review", color: "#e58bb5" },
  { id: "working", label: "Working", color: "#60a5fa" },
  { id: "close", label: "Safe to close", color: "#4ade80" },
];
const NEEDS = LANES[0];
const CLOSE = LANES[3];

// Hidden run after each ask: 16 chars of panel id, 2 of triage, 4 per byte of
// git facts as JSON, then a word joiner.
const ZERO_WIDTH = ["\u200b", "\u200c", "\u200d", "\u2060"];
const HIDDEN_RUN = /^(.+?)([\u200b\u200c\u200d\u2060]{16,})$/;
const TRIAGE = ["blocked", "approve", "decide", "review", "done", "working"];
const STALE_WORKING_SECONDS = 10 * 60;

const TRIAGE_META = {
  blocked: { lane: "needs", label: "Blocked", icon: "exclamationmark.octagon" },
  approve: { lane: "needs", label: "Approve", icon: "lock.shield" },
  decide: { lane: "needs", label: "Decide", icon: "questionmark.bubble" },
  waiting: { lane: "needs", label: "Waiting", icon: "ellipsis.bubble" },
  review: { lane: "review", label: "Review", icon: "eye" },
  untriaged: { lane: "review", label: "Not triaged", icon: "circle.dashed" },
  working: { lane: "working", label: "Working", icon: "arrow.triangle.2.circlepath" },
  done: { lane: "close", label: "Done", icon: "checkmark.circle" },
};

const epoch = () => data.clock()?.epoch ?? 0;

function ago(since) {
  if (!since) return "";
  const s = Math.max(0, Math.floor(epoch() - since));
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function clean(text) {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find((l) => l) ?? "";
  return line.replace(/^[^\p{L}\p{N}\p{Ps}]+/u, "");
}

function folderName(path) {
  return (path ?? "").replace(/\/+$/, "").split("/").pop();
}

function decodeHex(hidden) {
  let out = "";
  for (let i = 0; i + 1 < hidden.length; i += 2) {
    out += ((ZERO_WIDTH.indexOf(hidden[i]) << 2) | ZERO_WIDTH.indexOf(hidden[i + 1])).toString(16);
  }
  return out.toUpperCase();
}

function decodeFacts(hidden) {
  const hex = decodeHex(hidden);
  if (!hex) return null;

  try {
    return JSON.parse(decodeURIComponent(hex.replace(/../g, "%$&")));
  } catch {
    return null;
  }
}

function verdictFor(ws, agent) {
  const tags = [agent.panelId, agent.surfaceId].filter(Boolean).map((id) => id.slice(0, 8).toUpperCase());
  for (const line of (ws.description ?? "").split("\n")) {
    const m = HIDDEN_RUN.exec(line);
    if (!m || !tags.includes(decodeHex(m[2].slice(0, 16)))) continue;
    const triage = TRIAGE[parseInt(decodeHex(m[2].slice(16, 18)) || "2", 16)] ?? "decide";
    return { triage, ask: m[1], facts: decodeFacts(m[2].slice(18)) };
  }
  return null;
}

// A verdict is cleared whenever you send a prompt, so one only exists once that prompt
// has finished; it wins over cmux's "working", which sticks after an interrupted turn.
// A prompt cancelled before any reply fires no hook at all, so a "working" session
// with no tool activity for a while is treated as untriaged.
function triageOf(status, verdict, since) {
  if (verdict) return verdict.triage;
  const quietSeconds = epoch() - since;
  if (status === "working" && quietSeconds < STALE_WORKING_SECONDS) return "working";
  return status === "needs_input" ? "waiting" : "untriaged";
}

function askText(triage, verdict, tab) {
  if (verdict) return verdict.ask;
  if (triage === "working") return clean(tab?.latestPrompt) || "Working";
  if (triage === "waiting") return "Waiting for your input";
  return "Not triaged yet";
}

function plural(count, word) {
  return count + " " + word + (count === 1 ? "" : "s");
}

function leftInCheckout(facts) {
  const left = [];
  if (facts.dirty) left.push("Commit changes on " + facts.branch);

  if (facts.unpushed) left.push("Push " + plural(facts.unpushed, "commit") + " on " + facts.branch);

  const merged = facts.mr?.state === "MERGED";
  if (facts.ahead && !merged) {
    const mrOpen = facts.mr?.state === "OPEN";
    left.push(mrOpen ? "Merge " + facts.mr.label : "Open an MR for " + facts.branch);
  }
  return left;
}

const repoBySession = new Map();

function toSession(ws, a) {
  const key = ws.id + ":" + a.id;
  const tab = (ws.tabs ?? []).find((t) => t.id === a.panelId);
  const verdict = verdictFor(ws, a);
  const since = a.lastActivityAt ?? a.sinceEpoch ?? 0;
  const triage = triageOf(a.status, verdict, since);
  const facts = verdict?.facts ?? null;
  const gitLeft = facts ? leftInCheckout(facts) : [];
  const complete = triage === "done" && gitLeft.length === 0;
  const doneButUnmerged = triage === "done" && gitLeft.length > 0;
  if (facts) repoBySession.set(key, facts.repo);

  const meta = TRIAGE_META[triage];
  return {
    key,
    ws, a, triage,
    surfaceId: tab?.surfaceId ?? a.surfaceId,
    lane: meta.lane,
    icon: meta.icon,
    label: meta.label,
    name: clean(tab?.title) || clean(a.title) || ws.title,
    branch: tab?.branch || ws.branch || "",
    repo: repoBySession.get(key) || folderName(a.directory ?? ws.directory) || ws.title,
    complete,
    ask: doneButUnmerged ? gitLeft.join(" · ") : askText(triage, verdict, tab),
    since,
  };
}

const byRecency = (x, y) => y.since - x.since;

const sessions = computed(() => {
  const out = [];
  for (const ws of data.workspaces() ?? []) {
    for (const a of ws.agents ?? []) {
      if (a.kind === "claude" && a.status !== "ended") out.push(toSession(ws, a));
    }
  }
  out.sort(byRecency);
  return out;
});

const inLane = (lane) => () => sessions().filter((s) => s.lane === lane);

const laneOf = (id) => LANES.find((lane) => lane.id === id);

function toProject(repo, list) {
  const open = list.filter((s) => !s.complete);
  const done = list.filter((s) => s.complete);
  return { repo, open, done };
}

let repoOrder = [];

const projects = computed(() => {
  const sessionsByRepo = new Map();
  for (const s of sessions()) {
    if (!sessionsByRepo.has(s.repo)) sessionsByRepo.set(s.repo, []);
    sessionsByRepo.get(s.repo).push(s);
  }

  repoOrder = repoOrder.filter((repo) => sessionsByRepo.has(repo));
  for (const repo of sessionsByRepo.keys()) {
    if (!repoOrder.includes(repo)) repoOrder.push(repo);
  }

  return repoOrder.map((repo) => toProject(repo, sessionsByRepo.get(repo)));
});

function jump(s) {
  cmux("workspace.select", { workspace_id: s.ws.id });
  if (s.surfaceId) cmux("surface.focus", { surface_id: s.surfaceId, workspace_id: s.ws.id });
}

const hRule = () => Rectangle().fill(TOKEN.borderStrong).frame({ height: 1, maxWidth: "infinity" });
const vRule = () => Rectangle().fill(TOKEN.borderStrong).frame({ width: 1, maxHeight: "infinity" });
const cardRule = () => Rectangle().fill(TOKEN.border).frame({ height: 1, maxWidth: "infinity" });

// The ask is the point of the card, so it gets the full width and never truncates.
function askBlock(s, lane) {
  return Text(() => s().ask)
    .font(FONT.xs).color("primary")
    .fixedSize("vertical")
    .frame({ maxWidth: "infinity", alignment: "leading" })
    .padding(8)
    .background(lane.color + "14")
    .cornerRadius(6);
}

function card(s, lane) {
  const attention = lane.id === NEEDS.id;
  return VStack({ alignment: "leading", spacing: 0 }, [
    VStack({ alignment: "leading", spacing: 6 }, [
      HStack({ spacing: 10 }, [
        Image("sparkle").font(14).color(TOKEN.claude),
        Text(() => s().name)
          .font(FONT.smMd).weight("semibold").color("primary")
          .lineLimit(2).truncation("tail"),
        Spacer({ minLength: 0 }),
      ]),
      HStack({ spacing: 6 }, [
        Image("arrow.triangle.branch").font(ICON_2XS - 2).color("secondary"),
        Text(() => s().branch)
          .font(FONT["2xs"]).color("secondary")
          .lineLimit(1).truncation("middle"),
        Spacer({ minLength: 0 }),
      ]),
      askBlock(s, lane),
    ]).paddingHorizontal(14).paddingVertical(10),
    cardRule(),
    HStack({ spacing: 6 }, [
      Image(() => s().icon).font(ICON_2XS - 1).color(lane.color),
      Text(() => s().label).font(FONT["2xs"]).weight("medium").color(lane.color).fixedSize(),
      Spacer({ minLength: 0 }),
      Text(() => ago(s().since)).font(FONT["2xs"]).monospaced().color("secondary").fixedSize(),
    ]).paddingHorizontal(14).paddingVertical(10),
  ])
    .background(attention ? lane.color + "14" : TOKEN.surface)
    .cornerRadius(RADIUS_LG)
    .borderColor(attention ? lane.color : TOKEN.border)
    .borderWidth(1)
    .hoverBackground(TOKEN.hover)
    .frame({ maxWidth: "infinity" })
    .cursor("pointer")
    .onTap(() => jump(s()));
}

function projectHeader(p) {
  return HStack({ spacing: 8 }, [
    Image("folder").font(ICON_2XS).color("secondary"),
    Text(() => p().repo)
      .font(FONT.xs).weight("semibold").color("primary")
      .lineLimit(1).truncation("middle"),
    Spacer({ minLength: 0 }),
  ]).paddingHorizontal(16).frame({ height: HEADER_HEIGHT, maxWidth: "infinity" });
}

function section(label, color, items) {
  return VStack({ alignment: "leading", spacing: 10 }, [
    HStack({ spacing: 8 }, [
      Text(label).font(FONT["2xs"]).weight("medium").color(color),
      Spacer(),
      Text(() => String(items().length)).font(FONT["2xs"]).monospaced().color("tertiary"),
    ]),
    ForEach({ items, key: (s) => s.key + ":" + s.lane }, (s) => card(s, laneOf(s().lane))),
  ]).padding(12);
}

function project(p) {
  return HStack({ alignment: "top", spacing: 0 }, [
    VStack({ alignment: "leading", spacing: 0 }, [
      projectHeader(p),
      hRule(),
      section("Not complete", "secondary", () => p().open),
      hRule(),
      section("Complete", CLOSE.color, () => p().done),
      Spacer(),
    ]).frame({ maxWidth: "infinity", maxHeight: "infinity" }),
    vRule(),
  ]);
}

// cmux sidebars can't load image files, so this redraws assets/mascot.svg from shapes.
function outlined(color, width, height, radius) {
  return Rectangle().fill(color).frame({ width, height }).cornerRadius(radius)
    .borderColor(KAWAII.ink).borderWidth(2);
}

function avatar(needs) {
  const eye = () => Circle({ size: 4 }).fill(KAWAII.ink);
  const cheek = () => Capsule().fill(KAWAII.blush).frame({ width: 5, height: 3 });
  const block = (color) => Rectangle().fill(color).frame({ width: 3, height: 4 }).cornerRadius(1);
  return ZStack({ alignment: "center" }, [
    outlined(KAWAII.body, 32, 30, 13),
    VStack({ alignment: "center", spacing: 1 }, [
      HStack({ spacing: 8 }, [eye(), eye()]),
      HStack({ spacing: 3 }, [
        cheek(),
        Text(() => (needs().length ? "o" : "ᴗ")).font(7).weight("bold").color(KAWAII.ink),
        cheek(),
      ]),
      ZStack({ alignment: "center" }, [
        outlined(KAWAII.board, 16, 10, 3),
        HStack({ spacing: 1 }, KAWAII.blocks.map(block)),
      ]),
    ]),
  ]);
}

function topBar() {
  const needs = inLane(NEEDS.id);
  return HStack({ spacing: 10 }, [
    avatar(needs),
    Text("Board").font(FONT.title).weight("semibold").color("primary"),
    Spacer(),
    Text(() => (needs().length ? `${needs().length} need${needs().length === 1 ? "s" : ""} you` : "All clear"))
      .font(FONT.xs).weight("medium")
      .color(() => (needs().length ? NEEDS.color : "tertiary")),
  ]).paddingHorizontal(16).frame({ height: HEADER_HEIGHT, maxWidth: "infinity" });
}

sidebar(() =>
  VStack({ alignment: "leading", spacing: 0 }, [
    topBar(),
    hRule(),
    HStack({ alignment: "top", spacing: 0 }, [
      ForEach({ items: projects, key: (p) => p.repo }, project),
    ]),
  ]).frame({ maxWidth: "infinity", maxHeight: "infinity" })
)
