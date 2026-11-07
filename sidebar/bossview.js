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

const FONT = { "2xs": 10.5, xs: 12, smMd: 11.5, title: 15 };
const RADIUS_LG = 10;
const SWATCH = 8;
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

// Hidden run after each ask: 16 chars of panel id, 2 of triage, then a word joiner.
const ZERO_WIDTH = ["\u200b", "\u200c", "\u200d", "\u2060"];
const HIDDEN_RUN = /^(.+?)([\u200b\u200c\u200d\u2060]{16,})$/;
const TRIAGE = ["blocked", "approve", "decide", "review", "done"];

const TRIAGE_META = {
  blocked: { lane: "needs", rank: 0, label: "Blocked", icon: "exclamationmark.octagon" },
  approve: { lane: "needs", rank: 1, label: "Approve", icon: "lock.shield" },
  decide: { lane: "needs", rank: 2, label: "Decide", icon: "questionmark.bubble" },
  waiting: { lane: "needs", rank: 3, label: "Waiting", icon: "ellipsis.bubble" },
  review: { lane: "review", rank: 4, label: "Review", icon: "eye" },
  untriaged: { lane: "review", rank: 5, label: "Not triaged", icon: "circle.dashed" },
  working: { lane: "working", rank: 6, label: "Working", icon: "arrow.triangle.2.circlepath" },
  done: { lane: "close", rank: 7, label: "Done", icon: "checkmark.circle" },
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
  return line.replace(/^[^\p{L}\p{N}]+/u, "");
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

function verdictFor(ws, agent) {
  const tags = [agent.panelId, agent.surfaceId].filter(Boolean).map((id) => id.slice(0, 8).toUpperCase());
  for (const line of (ws.description ?? "").split("\n")) {
    const m = HIDDEN_RUN.exec(line);
    if (!m || !tags.includes(decodeHex(m[2].slice(0, 16)))) continue;
    const triage = TRIAGE[parseInt(decodeHex(m[2].slice(16, 18)) || "2", 16)] ?? "decide";
    return { triage, ask: m[1] };
  }
  return null;
}

// A verdict is cleared whenever you send a prompt, so one only exists once that prompt
// has finished; it wins over cmux's "working", which sticks after an interrupted turn.
function triageOf(status, verdict) {
  if (verdict) return verdict.triage;
  if (status === "working") return "working";
  return status === "needs_input" ? "waiting" : "untriaged";
}

function askText(triage, verdict, tab) {
  if (verdict) return verdict.ask;
  if (triage === "working") return clean(tab?.latestPrompt) || "Working";
  if (triage === "waiting") return "Waiting for your input";
  return "Not triaged yet";
}

function toSession(ws, a) {
  const tab = (ws.tabs ?? []).find((t) => t.id === a.panelId);
  const verdict = verdictFor(ws, a);
  const triage = triageOf(a.status, verdict);
  const meta = TRIAGE_META[triage];
  return {
    key: ws.id + ":" + a.id,
    ws, a, triage,
    surfaceId: tab?.surfaceId ?? a.surfaceId,
    lane: meta.lane,
    rank: meta.rank,
    icon: meta.icon,
    label: meta.label,
    name: clean(tab?.title) || clean(a.title) || ws.title,
    location: [folderName(a.directory ?? ws.directory) || ws.title, ws.branch].filter(Boolean).join(" / "),
    ask: askText(triage, verdict, tab),
    since: a.sinceEpoch ?? a.lastActivityAt ?? 0,
  };
}

// Most urgent first; among equals, whoever has waited longest. Working shows newest first.
function byAttention(x, y) {
  if (x.rank !== y.rank) return x.rank - y.rank;
  return x.lane === "working" ? y.since - x.since : x.since - y.since;
}

const sessions = computed(() => {
  const out = [];
  for (const ws of data.workspaces() ?? []) {
    for (const a of ws.agents ?? []) {
      if (a.kind === "claude" && a.status !== "ended") out.push(toSession(ws, a));
    }
  }
  out.sort(byAttention);
  return out;
});

const inLane = (lane) => () => sessions().filter((s) => s.lane === lane);

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
        Text(() => s().location)
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

function columnHeader(lane, items) {
  return HStack({ spacing: 10 }, [
    Circle({ size: SWATCH }).fill(lane.color),
    Text(lane.label).font(FONT.xs).weight("medium").color(lane.color),
    Spacer(),
    Text(() => String(items().length)).font(FONT.xs).monospaced().color("tertiary"),
  ]).paddingHorizontal(16).frame({ height: HEADER_HEIGHT, maxWidth: "infinity" });
}

function column(lane) {
  const items = inLane(lane.id);
  return VStack({ alignment: "leading", spacing: 0 }, [
    columnHeader(lane, items),
    hRule(),
    VStack({ alignment: "leading", spacing: 10 }, [
      ForEach({ items, key: (s) => s.key }, (s) => card(s, lane)),
    ]).padding(12),
    Spacer(),
  ]).frame({ maxWidth: "infinity", maxHeight: "infinity" });
}

function topBar() {
  const needs = inLane(NEEDS.id);
  return HStack({ spacing: 12 }, [
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
    HStack({ alignment: "top", spacing: 0 }, LANES.flatMap((lane, i) => (i ? [vRule(), column(lane)] : [column(lane)]))),
  ]).frame({ maxWidth: "infinity", maxHeight: "infinity" })
)
