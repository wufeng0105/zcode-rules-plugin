// 规则 → AGENTS.md 段导出（幂等），并写安装元数据（卸载逐字节还原靠它）。
//
// 用法：
//   node export-agents.mjs --rules <rules.json> --agents-md <AGENTS.md> [--state <install-state.json>] [--dry-run]
//
// 行为：
//   · 若 AGENTS.md 已有 zcode-rules 段 → **原地替换**（保留段外内容与既有段落）
//   · 若无 → 追加到末尾，并把 { originalSha256, appendedChars, sep, ... } 写进 state 文件
//   · --dry-run 只打印将要写入的段，不落盘
//
// ⚠️ 2026-10-30 修复（WP12 复核暴露的连带缺陷）：
//   本文件此前调用 `rules-engine.mjs` 的旧 `upsertAgentsSection`，那个实现
//   ① 用"猜分隔符"而非记录元数据 ② 会多写 1 个换行 —— 正是逐字节还原失败的成因。
//   现改为统一调用 `agents-section.mjs` 的 `upsert()`（记录 meta，码元单位截断）。
//
// 注意：AGENTS.md 是纯文本全文注入（adapters/src/context/index.ts:131），产品不解析其结构。
//       所以本段是给**模型看的人可读投影**，不是产品配置；真正拦截由 hook 执行。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { locateSection, removeSectionBySentinels, sha256, upsert } from "./agents-section.mjs";
import { renderAgentsSection, validateRules } from "./rules-engine.mjs";

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const rulesPath = argValue("--rules");
const agentsMdPath = argValue("--agents-md");
const statePath = argValue("--state");
const dryRun = process.argv.includes("--dry-run");
// 卸载模式：用于演练与验收
const uninstall = process.argv.includes("--uninstall");

if (!rulesPath || !agentsMdPath) {
  process.stderr.write(
    "用法: node export-agents.mjs --rules <rules.json> --agents-md <AGENTS.md> [--state <state.json>] [--dry-run|--uninstall]\n",
  );
  process.exit(2);
}
if (!existsSync(agentsMdPath)) {
  process.stderr.write(`环境不可用：AGENTS.md 不存在: ${agentsMdPath}\n`);
  process.exit(2);
}

// ---- 卸载模式（v2：2026-10-30 用户裁定，收尾补账 #3）----
// 语义变更：从"逐字节还原装机前文件"改为"sentinel 外科摘除——只摘我们加的投影段，
// 保留用户装后自行演化的内容"。残缺哨兵一律 refused（exit 1），绝不盲删。
if (uninstall) {
  if (!statePath || !existsSync(statePath)) {
    process.stderr.write(`环境不可用：卸载需要 state 文件: ${statePath ?? "<未提供>"}\n`);
    process.exit(2);
  }
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    process.stderr.write(`环境不可用：state 不是合法 JSON: ${String(error?.message ?? error)}\n`);
    process.exit(2);
  }
  const before = readFileSync(agentsMdPath, "utf8");
  const result = removeSectionBySentinels(before, state.agentsMd);
  if (result.action === "refused") {
    process.stderr.write(`${result.reason}\n`);
    process.exit(1);
  }
  if (result.action === "absent") {
    process.stdout.write(`段不存在，跳过（幂等） → ${agentsMdPath}\n  sha256=${sha256(before)}\n`);
    process.exit(0);
  }
  writeFileSync(agentsMdPath, result.content, "utf8");
  process.stdout.write(
    `已卸载 zcode-rules 段 → ${agentsMdPath}\n` +
      `  策略=${result.strategy}  摘除=${result.removedBytes}B sha256=${result.removedSha256}\n` +
      `  段外用户内容保留：${Buffer.byteLength(result.content, "utf8")}B  sha256=${sha256(result.content)}\n`,
  );
  process.exit(0);
}

// ---- 导出模式 ----
if (!existsSync(rulesPath)) {
  process.stderr.write(`环境不可用：规则文件不存在: ${rulesPath}\n`);
  process.exit(2);
}

let raw;
try {
  raw = JSON.parse(readFileSync(rulesPath, "utf8"));
} catch (error) {
  process.stderr.write(`环境不可用：规则文件不是合法 JSON: ${String(error?.message ?? error)}\n`);
  process.exit(2);
}
const v = validateRules(raw);
if (!v.ok) {
  process.stderr.write(`环境不可用：规则校验失败 → ${v.errors.join(" ; ")}\n`);
  process.exit(2);
}
for (const w of v.warnings ?? []) process.stderr.write(`警告：${w}\n`);

if (dryRun) {
  process.stdout.write(`${renderAgentsSection(v.rules)}\n`);
  process.exit(0);
}

const before = readFileSync(agentsMdPath, "utf8");
const { action, content, meta } = upsert(before, v.rules);
writeFileSync(agentsMdPath, content, "utf8");

// ---- 记账 v2（2026-10-30 收尾补账 #2，用户裁定修 bug）----
// 旧 bug：state 只在"首次追加"时写 meta；重导出（replace）后段已变大（525B → 约 1070B）
// 但 state 仍记旧值，且对用户装后自行演化的内容零记账 → v1 卸载按 originalSha256
// 门禁必然 fail-closed「安全但卸不掉」。
// v2：**每次导出（append 与 replace）都回写审计 meta**——段当前 sha/字节 +
// 周边内容（段以外全部字节）sha + lastExportAt。original*/appended*/sep 为装机时
// 历史快照，保留不覆盖；卸载 v2 只依赖 sep（逆操作用），其余为审计字段。
let stateNote = "";
if (statePath) {
  let prior = {};
  if (existsSync(statePath)) {
    try {
      prior = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      prior = {};
    }
  }
  const loc = locateSection(content);
  const chunk = loc ? content.slice(loc.begin, loc.end) : "";
  const surroundings = loc ? content.slice(0, loc.begin) + content.slice(loc.end) : content;
  const agentsMd = {
    ...(prior.agentsMd ?? {}),
    ...(meta ?? {}),
    lastExportAt: new Date().toISOString(),
    path: agentsMdPath,
    sectionBytes: Buffer.byteLength(chunk, "utf8"),
    sectionSha256: sha256(chunk),
    surroundingsBytes: Buffer.byteLength(surroundings, "utf8"),
    surroundingsSha256: sha256(surroundings),
  };
  const next = { ...prior, agentsMd, rulesPath, updatedAt: new Date().toISOString() };
  writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  stateNote =
    `  meta → ${statePath}（${action}：段 ${agentsMd.sectionBytes}B sha=${agentsMd.sectionSha256.slice(0, 8)}…` +
    `；周边 ${agentsMd.surroundingsBytes}B sha=${agentsMd.surroundingsSha256.slice(0, 8)}…）`;
}

process.stdout.write(
  `${action === "appended" ? "已追加" : "已替换"} zcode-rules 段 → ${agentsMdPath}\n` +
    `  段定位=${locateSection(content) ? "OK" : "FAIL"}${stateNote}\n`,
);
process.exit(0);
