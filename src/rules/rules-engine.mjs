// 件 3 规则引擎：一份规则源，两个出口（hook 判据 + AGENTS.md 段投影）
//
// 用户 2026-10-30 裁定（Q-13 / Q-14 / Q-15）：
//   · unmatched 与 onTimeout 是**正交两件事**，必须分开：
//       unmatched: "abstain"(默认) | "deny"   —— 规则不命中时怎么办
//       onTimeout: "deny"(唯一可选)           —— 已介入但没能在期限内裁决时怎么办
//   · 一份规则源、两个出口；冲突以规则文件为权威，AGENTS.md 段是它的**投影**，不允许手改两份
//   · 只交 schema + 空模板 + 示例，**不自拟默认放行策略**
//
// 这个模块只做"规则 → 判定"与"规则 → AGENTS.md 段"两件事，不做安装、不写真实配置。
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Schema（手写校验，不引依赖；错误信息带字段路径便于定位）
// ---------------------------------------------------------------------------
export const RULE_SCHEMA_VERSION = 1;

const UNMATCHED_VALUES = ["abstain", "deny"];
const ON_TIMEOUT_VALUES = ["deny"]; // 只有 deny：其他语义本版本不可安全实现（Q-13）

export function validateRules(raw) {
  const errors = [];
  const warnings = [];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["规则必须是 JSON 对象"], warnings, rules: null };
  }

  const r = raw;

  if (r.version !== RULE_SCHEMA_VERSION) {
    errors.push(`version 必须是 ${RULE_SCHEMA_VERSION}（当前 ${JSON.stringify(r.version)}）`);
  }

  if (typeof r.name !== "string" || r.name.trim() === "") {
    errors.push("name 必填（非空字符串），用于日志与 AGENTS.md 段标题");
  }

  if (r.description !== undefined && typeof r.description !== "string") {
    errors.push("description 必须是字符串");
  }

  // unmatched：默认 abstain（产品行为完全不变）
  const unmatched = r.unmatched ?? "abstain";
  if (!UNMATCHED_VALUES.includes(unmatched)) {
    errors.push(`unmatched 只能是 ${UNMATCHED_VALUES.join(" | ")}（当前 ${JSON.stringify(r.unmatched)}）`);
  }

  // onTimeout：唯一可选 deny
  const onTimeout = r.onTimeout ?? "deny";
  if (!ON_TIMEOUT_VALUES.includes(onTimeout)) {
    errors.push(
      `onTimeout 只能是 ${ON_TIMEOUT_VALUES.join(" | ")}（当前 ${JSON.stringify(r.onTimeout)}）；` +
        `其它语义（如"退回问人"）在本版本无法安全实现——broker 退赛后仍会无限等`,
    );
  }

  // watchdogMs：默认 120000（产品值），可配；范围保护
  const watchdogMs = r.watchdogMs ?? 120000;
  if (typeof watchdogMs !== "number" || !Number.isFinite(watchdogMs) || watchdogMs <= 0) {
    errors.push(`watchdogMs 必须是正数毫秒（当前 ${JSON.stringify(r.watchdogMs)}）`);
  } else {
    if (watchdogMs < 1000) warnings.push(`watchdogMs=${watchdogMs}ms 过短，可能误杀正常的用户确认`);
    if (watchdogMs > 600000) warnings.push(`watchdogMs=${watchdogMs}ms 超过 10 分钟，看门狗意义有限`);
  }

  // rules：有序数组，first-match-wins
  if (!Array.isArray(r.rules)) {
    errors.push("rules 必须是数组（可以为空数组 = 空模板）");
  } else {
    const seenIds = new Set();
    r.rules.forEach((rule, i) => {
      const at = `rules[${i}]`;
      if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
        errors.push(`${at} 必须是对象`);
        return;
      }
      if (typeof rule.id !== "string" || rule.id.trim() === "") {
        errors.push(`${at}.id 必填（非空字符串，用于审计与日志）`);
      } else if (seenIds.has(rule.id)) {
        errors.push(`${at}.id 重复：${rule.id}（id 必须唯一，first-match-wins 才有确定含义）`);
      } else {
        seenIds.add(rule.id);
      }
      if (typeof rule.decision !== "string" || !["allow", "deny", "ask"].includes(rule.decision)) {
        errors.push(`${at}.decision 必须是 allow | deny | ask（当前 ${JSON.stringify(rule.decision)}）`);
      }
      if (typeof rule.tool !== "string" || rule.tool.trim() === "") {
        errors.push(`${at}.tool 必填（工具名，或 "*" 表示任意工具）`);
      }
      if (rule.commandPattern !== undefined) {
        if (typeof rule.commandPattern !== "string") {
          errors.push(`${at}.commandPattern 必须是字符串`);
        } else {
          try {
            new RegExp(rule.commandPattern);
          } catch (error) {
            errors.push(`${at}.commandPattern 不是合法正则：${String(error?.message ?? error)}`);
          }
        }
      }
      if (rule.comment !== undefined && typeof rule.comment !== "string") {
        errors.push(`${at}.comment 必须是字符串`);
      }
      if (rule.decision === "allow" && !rule.comment) {
        warnings.push(`${at} 是 allow 但没写 comment——放行是高危决定，请写清理由（审计用）`);
      }
    });
  }

  return { ok: errors.length === 0, errors, warnings, rules: errors.length === 0 ? normalize(r) : null };
}

function normalize(r) {
  return {
    description: r.description ?? "",
    name: r.name.trim(),
    onTimeout: r.onTimeout ?? "deny",
    rules: r.rules.map((rule) => ({
      commandPattern: rule.commandPattern,
      comment: rule.comment ?? "",
      decision: rule.decision,
      id: rule.id.trim(),
      tool: rule.tool.trim(),
    })),
    unmatched: r.unmatched ?? "abstain",
    version: RULE_SCHEMA_VERSION,
    watchdogMs: r.watchdogMs ?? 120000,
  };
}

// ---------------------------------------------------------------------------
// 出口 1：hook 判据
// ---------------------------------------------------------------------------
// 返回三种形态，**必须显式可区分**（用户 Q-13 要求，也是我踩过的"坑 1"）：
//   { kind: "allow",  rule, reason }        → 输出 allow 决定
//   { kind: "deny",   rule, reason }        → 输出 deny 决定
//   { kind: "abstain", reason }             → 输出**合法 JSON 但无 decision**，让产品按原行为处理
//                                             （注意：不能用"空 stdout"或"非法 stdout"表达退赛，
//                                              那两者在产品侧的日志形态与"静默失效"混淆）
//   { kind: "ask",    rule, reason }        → 与 abstain 同效（本版本 ask 无法生效），单独标出便于审计
export function evaluate(rules, hookInput) {
  const toolName = hookInput?.toolName ?? hookInput?.tool_name ?? "";
  const command =
    typeof hookInput?.toolInput?.command === "string"
      ? hookInput.toolInput.command
      : typeof hookInput?.tool_input?.command === "string"
        ? hookInput.tool_input.command
        : "";

  for (const rule of rules.rules) {
    if (rule.tool !== "*" && rule.tool !== toolName) continue;
    if (rule.commandPattern !== undefined) {
      let re;
      try {
        re = new RegExp(rule.commandPattern);
      } catch {
        continue; // 校验阶段已拦住；运行期防御性跳过而非放行
      }
      if (!re.test(command)) continue;
    }
    if (rule.decision === "allow") {
      return { command, kind: "allow", reason: `rule ${rule.id}: allow ${toolName}`, rule, toolName };
    }
    if (rule.decision === "deny") {
      return { command, kind: "deny", reason: `rule ${rule.id}: deny ${toolName}`, rule, toolName };
    }
    // decision==="ask"：本版本无法让 hook 表达"问"，等价于 abstain，但显式标注
    return {
      command,
      kind: "ask",
      reason: `rule ${rule.id}: ask（本版本 hook 无法表达 ask，按 ${rules.unmatched} 处理）`,
      rule,
      toolName,
    };
  }

  return {
    command,
    kind: rules.unmatched === "deny" ? "deny" : "abstain",
    reason:
      rules.unmatched === "deny"
        ? `no rule matched, unmatched=deny`
        : `no rule matched, unmatched=abstain (产品原行为)`,
    rule: null,
    toolName,
  };
}

// ---------------------------------------------------------------------------
// 出口 2：AGENTS.md 规则段投影
// ---------------------------------------------------------------------------
// AGENTS.md 是**纯文本全文注入**（adapters/src/context/index.ts:131 readFirstTextBytes），
// 产品不解析其结构。所以这里是"规则 → 人可读文本"的投影，不是给产品读的配置。
export const AGENTS_SECTION_BEGIN = "<!-- BEGIN zcode-rules (generated from JSON, DO NOT EDIT) -->";
export const AGENTS_SECTION_END = "<!-- END zcode-rules -->";

export function renderAgentsSection(rules) {
  const lines = [];
  lines.push(AGENTS_SECTION_BEGIN);
  lines.push(`## ${rules.name}`);
  lines.push("");
  lines.push(
    "> 本段由 `rules/<name>.json` 自动生成，**不要手改**；改规则请改 JSON 并重新导出。",
  );
  lines.push(`> 规则文件版本 ${rules.version}；未命中策略 \`${rules.unmatched}\`；超时策略 \`${rules.onTimeout}\`（${rules.watchdogMs}ms）。`);
  lines.push("");

  if (rules.rules.length === 0) {
    lines.push("（当前规则集为空：所有请求都按产品原行为处理。）");
  } else {
    const byDecision = { allow: [], ask: [], deny: [] };
    for (const rule of rules.rules) byDecision[rule.decision].push(rule);

    const label = { allow: "允许", ask: "询问", deny: "禁止" };
    for (const d of ["allow", "ask", "deny"]) {
      const list = byDecision[d];
      if (list.length === 0) continue;
      lines.push(`### ${label[d]}（${list.length} 条）`);
      for (const rule of list) {
        const scope = rule.tool === "*" ? "任意工具" : `\`${rule.tool}\``;
        const cmd = rule.commandPattern ? `，命令匹配 \`/${rule.commandPattern}/\`` : "";
        const why = rule.comment ? ` —— ${rule.comment}` : "";
        lines.push(`- [\`${rule.id}\`] ${scope}${cmd}${why}`);
      }
      lines.push("");
    }
  }

  lines.push(
    `> 本段只描述"允许什么/禁止什么"，**不代替**权限系统的实际判定；实际拦截由 hook 执行。`,
  );
  lines.push(AGENTS_SECTION_END);
  return lines.join("\n");
}

// 注：旧的 `upsertAgentsSection` 已于 2026-10-30 移除。
// 它用"猜分隔符"实现，且在原文末尾无换行时会多写 1 个换行 —— 导致逐字节还原失败
// （WP12 复核发现）。现统一由 `agents-section.mjs` 的 `upsert()` 负责：
// 记录 meta（码元数 + 分隔符），卸载时精确回退 + sha256 自校验。
// ---------------------------------------------------------------------------
// 单一性自检（J3-6）：证明"一份规则源、两个出口"真的成立
// ---------------------------------------------------------------------------
export function consistencyCheck(rules, agentsMarkdown) {
  const expected = renderAgentsSection(rules);
  const begin = agentsMarkdown.indexOf(AGENTS_SECTION_BEGIN);
  const end = agentsMarkdown.indexOf(AGENTS_SECTION_END);
  const problems = [];

  if (begin < 0 || end < 0) {
    problems.push("AGENTS.md 里没有 zcode-rules 段（尚未导出）");
    return { ok: false, problems };
  }
  const actual = agentsMarkdown.slice(begin, end + AGENTS_SECTION_END.length);
  if (actual.trim() !== expected.trim()) {
    problems.push(
      "AGENTS.md 的 zcode-rules 段与规则文件投影不一致（有人手改，或规则改了没重新导出）",
    );
  }
  // 反向：段里出现的规则 id 必须与规则文件一一对应
  const idsInSection = [...actual.matchAll(/\[`([^`]+)`\]/g)].map((m) => m[1]);
  const idsInRules = rules.rules.map((r) => r.id);
  const missing = idsInRules.filter((id) => !idsInSection.includes(id));
  const extra = idsInSection.filter((id) => !idsInRules.includes(id));
  if (missing.length) problems.push(`段里缺少这些规则 id：${missing.join(", ")}`);
  if (extra.length) problems.push(`段里多出这些规则 id（规则文件里没有）：${extra.join(", ")}`);

  return { ok: problems.length === 0, problems };
}

export function fingerprintRules(rules) {
  return createHash("sha256").update(JSON.stringify(rules)).digest("hex").slice(0, 16);
}
