// 从 AGENTS.md 的哨兵段反解真源（P-6「从 AGENTS.md 回填」的服务端实现）。
//
// 为什么放在服务端而不是面板：面板在沙箱 iframe 里跑、无法 import 本仓库模块，且反解必须
// 与 `rules-engine.renderAgentsSection` 的投影格式**逐字**一致。放这里可以让面板只做
// 「拿 selfcheck_run 给的候选 → 二次确认 → rules_write / content_policy_write」，
// 不复制任何解析逻辑（bridge.mjs 那套内联只因为它是纯协议帧，没有格式耦合）。
//
// 两条原则：
//   1. **不无损就不给候选**：解析出来的规则必须能重新渲染成与文件中**逐字节相同**的段
//      （`roundTrip`），否则 ok=false + errors，面板只能显示「无法无损回填」。
//   2. **不伪造**：段里没有的信息（如 `description`）不猜；面板回填时保留真源里已有的值。
//
// 格式常量与 `src/rules/rules-engine.mjs::renderAgentsSection` 一一对应；
// tests/agents-backfill.test.mjs 断言这些常量确实出现在引擎输出里（引擎改写文案时测试会红）。
import {
  RULE_SCHEMA_VERSION,
  renderAgentsSection,
  validateRules,
} from "../rules/rules-engine.mjs";
import {
  SECTION_NAMES,
  composeNamedSection,
  detectLineEnding,
  locateNamedSection,
  sectionSnapshot,
} from "../rules/sections.mjs";

/** `renderAgentsSection` 的第二行（生成说明）。 */
export const RULES_HEADER_NOTE =
  "> 本段由 `rules/<name>.json` 自动生成，**不要手改**；改规则请改 JSON 并重新导出。";
/** 空规则集时的占位行。 */
export const RULES_EMPTY_LINE = "（当前规则集为空：所有请求都按产品原行为处理。）";
/** 段尾说明行。 */
export const RULES_FOOTER_NOTE =
  '> 本段只描述"允许什么/禁止什么"，**不代替**权限系统的实际判定；实际拦截由 hook 执行。';

const SUMMARY_RE =
  /^> 规则文件版本 (\d+)；未命中策略 `(abstain|deny)`；超时策略 `(deny)`（(\d+)ms）。$/;
const GROUP_RE = /^### (允许|询问|禁止)（(\d+) 条）$/;
const BULLET_RE = /^- \[`([^`]+)`\] (.+)$/;
const GROUP_DECISION = { 允许: "allow", 询问: "ask", 禁止: "deny" };
const DECISION_GROUP = { allow: "允许", ask: "询问", deny: "禁止" };

/** EOL 归一化：只用于「是否逐字节等价」的比较，不改写任何落盘内容。 */
export function normalizeEol(text) {
  return String(text ?? "").replaceAll("\r\n", "\n");
}

/** 去掉 compose 用的一层首尾行尾（`composeNamedSection` 的精确逆操作）。 */
export function stripComposedEol(inner) {
  let text = String(inner ?? "");
  if (text.startsWith("\r\n")) text = text.slice(2);
  else if (text.startsWith("\n")) text = text.slice(1);
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);
  return text;
}

/** 取某段的原始 chunk 与段内正文；段不存在/哨兵异常返回 null。 */
function readSection(agentsText, name) {
  const text = String(agentsText ?? "");
  const snapshot = sectionSnapshot(text, name);
  const located = locateNamedSection(text, name);
  if (!snapshot.present || !located) {
    return { malformed: snapshot.malformed, present: false, reason: snapshot.reason ?? null };
  }
  const sectionText = text.slice(located.begin, located.end);
  const inner = text.slice(located.bodyStart, located.bodyEnd);
  return {
    body: stripComposedEol(inner),
    lineEnding: detectLineEnding(text),
    malformed: false,
    present: true,
    sectionText,
  };
}

/**
 * 解析 `zcode-rules` 段的正文（`renderAgentsSection` 的人读投影）→ 规则对象。
 * 严格：任何不符合投影格式的行都记 error；只有能完整还原时才 ok=true。
 */
export function parseRulesSectionBody(body) {
  const errors = [];
  const warnings = [];
  const lines = normalizeEol(body).split("\n");
  let i = 0;

  const fail = (message) => {
    errors.push(message);
    return { errors, ok: false, rules: null, warnings };
  };

  // 1) 标题 `## <name>`
  const title = lines[i] ?? "";
  if (!title.startsWith("## ") || title.slice(3).trim() === "") {
    return fail(`第 ${i + 1} 行不是段标题「## <规则名>」：${JSON.stringify(title)}`);
  }
  const name = title.slice(3).trim();
  i += 1;

  // 2) 空行 + 生成说明 + 摘要
  if ((lines[i] ?? "") !== "") return fail(`第 ${i + 1} 行应为空行：${JSON.stringify(lines[i] ?? "")}`);
  i += 1;
  if ((lines[i] ?? "") !== RULES_HEADER_NOTE) {
    return fail(`第 ${i + 1} 行不是生成说明（可能被手改）：${JSON.stringify(lines[i] ?? "")}`);
  }
  i += 1;
  const summary = SUMMARY_RE.exec(lines[i] ?? "");
  if (!summary) return fail(`第 ${i + 1} 行不是规则摘要（版本/未命中/超时）：${JSON.stringify(lines[i] ?? "")}`);
  i += 1;

  // 3) 空行
  if ((lines[i] ?? "") !== "") return fail(`第 ${i + 1} 行应为空行：${JSON.stringify(lines[i] ?? "")}`);
  i += 1;

  const rules = [];

  if ((lines[i] ?? "") === RULES_EMPTY_LINE) {
    i += 1;
  } else {
    // 4) 逐组解析：允许 / 询问 / 禁止
    while ((lines[i] ?? "").startsWith("### ")) {
      const group = GROUP_RE.exec(lines[i]);
      if (!group) return fail(`第 ${i + 1} 行不是分组标题：${JSON.stringify(lines[i])}`);
      const decision = GROUP_DECISION[group[1]];
      const declared = Number(group[2]);
      i += 1;
      let parsed = 0;
      while ((lines[i] ?? "").startsWith("- ")) {
        const bullet = BULLET_RE.exec(lines[i]);
        if (!bullet) return fail(`第 ${i + 1} 行不是规则条目：${JSON.stringify(lines[i])}`);
        const entry = parseBullet(bullet[1], bullet[2], decision);
        if (entry.error) return fail(`第 ${i + 1} 行${entry.error}：${JSON.stringify(lines[i])}`);
        rules.push(entry.rule);
        parsed += 1;
        i += 1;
      }
      if (parsed !== declared) {
        return fail(`分组「${group[1]}」声明 ${declared} 条，实际解析到 ${parsed} 条`);
      }
      if ((lines[i] ?? "") !== "") {
        return fail(`第 ${i + 1} 行应为空行（分组之后）：${JSON.stringify(lines[i] ?? "")}`);
      }
      i += 1;
    }
  }

  // 5) 段尾说明
  if ((lines[i] ?? "") !== RULES_FOOTER_NOTE) {
    return fail(`第 ${i + 1} 行不是段尾说明（可能被手改）：${JSON.stringify(lines[i] ?? "")}`);
  }
  i += 1;
  while (i < lines.length && lines[i] === "") i += 1; // 允许尾随空行（CRLF 文档末尾常见）
  if (i !== lines.length) return fail(`第 ${i + 1} 行之后还有未解析内容：${JSON.stringify(lines[i])}`);

  const raw = {
    description: "",
    name,
    onTimeout: summary[3],
    rules,
    unmatched: summary[2],
    version: Number(summary[1]),
    watchdogMs: Number(summary[4]),
  };
  const verdict = validateRules(raw);
  if (!verdict.ok) {
    return { errors: verdict.errors, ok: false, rules: null, warnings: verdict.warnings };
  }
  for (const warning of verdict.warnings) warnings.push(warning);
  if (raw.version !== RULE_SCHEMA_VERSION) {
    errors.push(`段里的版本 ${raw.version} 与当前 schema 版本 ${RULE_SCHEMA_VERSION} 不一致`);
    return { errors, ok: false, rules: null, warnings };
  }
  return { errors, ok: true, rules: verdict.rules, warnings };
}

/** 解析单条规则 bullet（`- [\`id\`] 作用域[，命令匹配 \`/re/\`][ —— 说明]`）。 */
function parseBullet(id, rest, decision) {
  let tool;
  let remainder;
  if (rest.startsWith("`")) {
    const close = rest.indexOf("`", 1);
    if (close < 0) return { error: "工具名的反引号不闭合" };
    tool = rest.slice(1, close).trim();
    remainder = rest.slice(close + 1);
    if (tool === "") return { error: "工具名为空" };
  } else if (rest.startsWith("任意工具")) {
    tool = "*";
    remainder = rest.slice(4);
  } else {
    return { error: "找不到作用域（`工具名` 或 任意工具）" };
  }

  let commandPattern;
  if (remainder.startsWith("，命令匹配 `")) {
    const inner = remainder.slice("，命令匹配 `".length);
    // 命令正则可能自身含 `/`，取最后一个反引号之前的全部内容。
    const close = inner.lastIndexOf("`");
    if (close < 0) return { error: "命令匹配的反引号不闭合" };
    commandPattern = inner.slice(0, close);
    if (commandPattern.startsWith("/") && commandPattern.endsWith("/")) {
      // renderAgentsSection 用 `/re/` 包裹；去掉首尾斜杠还原。
      commandPattern = commandPattern.slice(1, -1);
    }
    remainder = inner.slice(close + 1);
  }

  let comment = "";
  if (remainder.startsWith(" —— ")) {
    comment = remainder.slice(" —— ".length);
  } else if (remainder !== "") {
    return { error: "条目尾部有无法识别的内容" };
  }

  const rule = { decision, id, tool, ...(commandPattern === undefined ? {} : { commandPattern }) };
  if (comment !== "") rule.comment = comment;

  // 回渲校验：这一条必须能重新渲染成同样的文本，否则拒绝（宁可说不会，也不给半成品）。
  const rendered = renderBullet(rule);
  if (rendered !== `- [\`${id}\`] ${rest}`) {
    return { error: "条目无法无损回渲（可能含与分隔符冲突的字符）" };
  }
  return { rule };
}

/** 与 `renderAgentsSection` 内的条目拼装逐字相同（回渲校验用）。 */
function renderBullet(rule) {
  const scope = rule.tool === "*" ? "任意工具" : `\`${rule.tool}\``;
  const cmd = rule.commandPattern ? `，命令匹配 \`/${rule.commandPattern}/\`` : "";
  const why = rule.comment ? ` —— ${rule.comment}` : "";
  return `- [\`${rule.id}\`] ${scope}${cmd}${why}`;
}

/**
 * 把反解结果与当前真源合并成「回填后应写入的规则」。
 *
 * 为什么需要合并：`renderAgentsSection` 的投影按 decision 分组渲染（允许 → 询问 → 禁止），
 * 组内保序、**跨组次序不可还原**。而 hook 判定是 first-match-wins，跨组次序有语义。
 * 因此回填时保持当前 rules.json 里已存在规则的原次序，只把段里新增的 id 追加在后面；
 * 同时 `description`（投影里没有）沿用当前值，不因为回填被清空。
 *
 * 返回 `{ rules, orderChanged, appendedIds, droppedIds }`：
 *   · orderChanged 为 true 时面板必须显式提示「次序按当前真源保留，段内分组次序不作为依据」
 *   · droppedIds 是段里没有、回填后会消失的规则（面板二次确认文案要点名）
 */
export function mergeRuleOrder(current, parsed) {
  const parsedIds = new Set(parsed.rules.map((rule) => rule.id));
  const parsedById = new Map(parsed.rules.map((rule) => [rule.id, rule]));
  const currentIds = (current?.rules ?? []).map((rule) => rule.id);
  const merged = [];
  for (const rule of current?.rules ?? []) {
    const replacement = parsedById.get(rule.id);
    if (!replacement) continue;
    merged.push(replacement);
    parsedById.delete(rule.id);
  }
  const appended = [...parsedById.values()];
  merged.push(...appended);

  const candidate = {
    description: typeof current?.description === "string" ? current.description : "",
    name: parsed.name,
    onTimeout: parsed.onTimeout,
    rules: merged,
    unmatched: parsed.unmatched,
    version: parsed.version,
    watchdogMs: parsed.watchdogMs,
  };
  const verdict = validateRules(candidate);
  const mergedIds = merged.map((rule) => rule.id);
  return {
    appendedIds: appended.map((rule) => rule.id),
    droppedIds: currentIds.filter((id) => !parsedIds.has(id)),
    errors: verdict.ok ? [] : verdict.errors,
    ok: verdict.ok,
    orderChanged: mergedIds.join("\u0000") !== parsed.rules.map((rule) => rule.id).join("\u0000"),
    rules: verdict.ok ? verdict.rules : null,
    warnings: verdict.warnings,
  };
}

/**
 * 读 `zcode-rules` 段并给出回填候选。
 * 返回 `{ present, malformed, reason, sectionText, body, ok, roundTrip, rules, suggested, errors, warnings }`。
 * `ok && roundTrip` 才允许面板显示「从 AGENTS.md 回填真源」；`suggested` 是合并后的写入载荷。
 */
export function readRulesSection(agentsText, currentRules = null) {
  const found = readSection(agentsText, SECTION_NAMES.RULES);
  if (!found.present) {
    return { errors: [], malformed: found.malformed, ok: false, present: false, reason: found.reason, roundTrip: false, rules: null, suggested: null, warnings: [] };
  }
  const parsed = parseRulesSectionBody(found.body);
  const roundTrip =
    parsed.ok && normalizeEol(renderAgentsSection(parsed.rules)) === normalizeEol(found.sectionText);
  const suggested = parsed.ok ? mergeRuleOrder(currentRules, parsed.rules) : null;
  return {
    body: found.body,
    errors: parsed.errors,
    malformed: false,
    ok: parsed.ok && roundTrip,
    present: true,
    roundTrip,
    rules: parsed.ok ? parsed.rules : null,
    sectionText: found.sectionText,
    suggested,
    warnings: parsed.warnings,
  };
}

/**
 * 读 `zcode-content-policy` 段并给出回填候选（自由文本，逐字无损）。
 * 返回 `{ present, malformed, reason, text, roundTrip, ok }`。
 */
export function readPolicySection(agentsText) {
  const found = readSection(agentsText, SECTION_NAMES.CONTENT_POLICY);
  if (!found.present) {
    return { malformed: found.malformed, ok: false, present: false, reason: found.reason, roundTrip: false, text: "" };
  }
  const expected = composeNamedSection(
    SECTION_NAMES.CONTENT_POLICY,
    found.body,
    detectedLineEnding(found, agentsText),
  );
  const roundTrip = normalizeEol(expected) === normalizeEol(found.sectionText);
  return {
    malformed: false,
    ok: roundTrip,
    present: true,
    roundTrip,
    sectionText: found.sectionText,
    text: found.body,
  };
}

function detectedLineEnding(found, agentsText) {
  return found.lineEnding ?? detectLineEnding(agentsText);
}
