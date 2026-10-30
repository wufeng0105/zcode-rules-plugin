// 命名哨兵双段引擎（v0.2.0 新增；不改既有 4 个参照实现文件）
//
// 为什么单独一个文件：`src/rules/rules-engine.mjs`、`src/rules/agents-section.mjs`、
// `src/rules/export-agents.mjs`、`src/hooks/permission-rules.mjs` 四个参照实现必须与
// ZCode 检出 `docs/zcode-mod/selfcheck/` 逐字节一致（判据 C3），所以通用段引擎只能新增。
// 其中 zcode-rules 段的 BEGIN/END 哨兵**从 rules-engine.mjs import**（不复制字面量），
// 保证与既有投影格式逐字兼容；zcode-content-policy 段的哨兵在本文件定义。
//
// 两个段：
//   · zcode-rules           结构化规则投影（由 rules-engine.renderAgentsSection 生成）
//   · zcode-content-policy  自由文本内容策略（不伪造任何默认指令）
//
// 硬约束：
//   · 段外字节不动：追加/替换只影响段本身；删除只摘段
//   · 幂等：同一输入二次 upsert，输出字节完全相同
//   · 保留原貌：不改既有行尾（CRLF/LF）；新增段沿用文档主导行尾
//   · 残缺/乱序/重复哨兵一律拒绝（upsert 抛错、remove 返回 refused），绝不盲写盲删
import { createHash } from "node:crypto";
import {
  AGENTS_SECTION_BEGIN,
  AGENTS_SECTION_END,
} from "./rules-engine.mjs";

export const SECTION_NAMES = Object.freeze({
  RULES: "zcode-rules",
  CONTENT_POLICY: "zcode-content-policy",
});

// zcode-rules 的哨兵必须逐字来自 rules-engine.mjs（判据：格式逐字兼容，不复制字面量）。
const SENTINELS = Object.freeze({
  [SECTION_NAMES.RULES]: Object.freeze({
    begin: AGENTS_SECTION_BEGIN,
    end: AGENTS_SECTION_END,
  }),
  [SECTION_NAMES.CONTENT_POLICY]: Object.freeze({
    begin: "<!-- BEGIN zcode-content-policy (free text, DO NOT EDIT) -->",
    end: "<!-- END zcode-content-policy -->",
  }),
});

export const KNOWN_SECTION_NAMES = Object.freeze(Object.keys(SENTINELS));

/** 取某段的哨兵常量；未知段名直接抛错（不猜格式）。 */
export function sentinelsFor(name) {
  const sentinels = SENTINELS[name];
  if (!sentinels) {
    throw new Error(
      `未知段名: ${JSON.stringify(name)}（只支持 ${KNOWN_SECTION_NAMES.join(" | ")}）`,
    );
  }
  return sentinels;
}

/** 文档主导行尾：含 CRLF 即按 CRLF，否则 LF。 */
export function detectLineEnding(text) {
  return String(text ?? "").includes("\r\n") ? "\r\n" : "\n";
}

const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

// 内部：三段式状态（absent / partial / inverted / duplicated / ok）。
// locateNamedSection 只暴露 ok，removeNamedSection 用完整状态决定是否 refused。
function inspectSection(text, sentinels) {
  const beginAt = text.indexOf(sentinels.begin);
  const endAt = text.indexOf(sentinels.end);
  if (beginAt < 0 && endAt < 0) return { status: "absent" };
  if (beginAt < 0) return { status: "partial", reason: "只找到 END 哨兵，缺 BEGIN 哨兵" };
  if (endAt < 0) return { status: "partial", reason: "只找到 BEGIN 哨兵，缺 END 哨兵" };
  if (endAt < beginAt) return { status: "inverted", reason: "END 哨兵出现在 BEGIN 之前" };
  const secondBegin = text.indexOf(sentinels.begin, beginAt + sentinels.begin.length);
  if (secondBegin >= 0) return { status: "duplicated", reason: "出现多个 BEGIN 哨兵，段边界不唯一" };
  const secondEnd = text.indexOf(sentinels.end, endAt + sentinels.end.length);
  if (secondEnd >= 0) return { status: "duplicated", reason: "出现多个 END 哨兵，段边界不唯一" };
  return {
    status: "ok",
    begin: beginAt,
    end: endAt + sentinels.end.length,
    bodyStart: beginAt + sentinels.begin.length,
    bodyEnd: endAt,
  };
}

/** 拆掉紧跟其后的一个行尾（upsert 写入形态的逆操作）；保持 CRLF/LF 原样。 */
function splitLeadingEol(text) {
  if (text.startsWith("\r\n")) return { after: text.slice(2), eol: "\r\n" };
  if (text.startsWith("\n")) return { after: text.slice(1), eol: "\n" };
  return { after: text, eol: "" };
}

/** body 是否已经是一段带同名哨兵的完整段（规则段由 renderAgentsSection 直接产出）。 */
function isCompleteSection(body, sentinels) {
  if (typeof body !== "string") return false;
  return body.startsWith(sentinels.begin) && body.trimEnd().endsWith(sentinels.end);
}

/**
 * 用哨兵包裹段内正文。`eol` 用于包裹用的换行（默认 LF）。
 * 注意：正文逐字保留；本函数不生成任何头部、标题或默认指令。
 */
export function composeNamedSection(name, body, eol = "\n") {
  const sentinels = sentinelsFor(name);
  const text = body === undefined || body === null ? "" : String(body);
  return `${sentinels.begin}${eol}${text}${eol}${sentinels.end}`;
}

/**
 * 定位段边界。返回 `{ begin, end, bodyStart, bodyEnd }`（end 为 END 哨兵之后一位），
 * 或 null（缺失、残缺、乱序、重复都返回 null；删除/写入前的严格判定见 remove/upsert）。
 */
export function locateNamedSection(text, name) {
  const sentinels = sentinelsFor(name);
  const inspected = inspectSection(String(text ?? ""), sentinels);
  if (inspected.status !== "ok") return null;
  return {
    begin: inspected.begin,
    end: inspected.end,
    bodyStart: inspected.bodyStart,
    bodyEnd: inspected.bodyEnd,
  };
}

/**
 * 幂等写入：
 *   · 段不存在 → 追加（必要时先补一个行尾分隔），返回 action="appended"
 *   · 段已存在 → 原地替换（只动段内；段后原有行尾原样保留），返回 action="replaced"
 *   · 哨兵残缺/乱序/重复 → 抛错（拒绝写入，避免把坏结构复制成两段）
 *
 * body 可以是段内正文（自动用哨兵包裹），也可以是已经带哨兵的完整段
 * （规则段由 renderAgentsSection 产出，逐字采用以保证格式兼容）。
 */
export function upsertNamedSection(text, name, body) {
  const sentinels = sentinelsFor(name);
  const doc = String(text ?? "");
  const inspected = inspectSection(doc, sentinels);
  if (inspected.status !== "ok" && inspected.status !== "absent") {
    throw new Error(
      `段 ${name} 的哨兵结构异常（${inspected.reason}），拒绝写入；请先人工核对段边界`,
    );
  }

  const eol = detectLineEnding(doc);
  const section = isCompleteSection(body, sentinels)
    ? String(body)
    : composeNamedSection(name, body, eol);

  if (inspected.status === "absent") {
    // 原文非空且末尾没有换行时补一个分隔，避免哨兵贴在用户最后一行文本上。
    const sep = doc.length === 0 || /(?:\r\n|\n)$/.test(doc) ? "" : eol;
    return { action: "appended", content: `${doc}${sep}${section}${eol}` };
  }

  const before = doc.slice(0, inspected.begin);
  const { after, eol: tailEol } = splitLeadingEol(doc.slice(inspected.end));
  return { action: "replaced", content: `${before}${section}${tailEol}${after}` };
}

/**
 * 删除（只摘段）：
 *   · 无哨兵 → action="absent"，内容原样
 *   · 段存在 → 摘除哨兵块 + 段后一个行尾，段外字节原样
 *   · 残缺/乱序/重复 → action="refused"，内容原样（绝不盲删）
 *
 * 返回 removedBytes / removedSha256（按 UTF-8 字节 / 段本身计算）供审计复核。
 */
export function removeNamedSection(text, name) {
  const sentinels = sentinelsFor(name);
  const doc = String(text ?? "");
  const inspected = inspectSection(doc, sentinels);
  if (inspected.status === "absent") {
    return { action: "absent", content: doc };
  }
  if (inspected.status !== "ok") {
    return { action: "refused", content: doc, reason: inspected.reason };
  }
  const chunk = doc.slice(inspected.begin, inspected.end);
  const { after } = splitLeadingEol(doc.slice(inspected.end));
  return {
    action: "removed",
    content: `${doc.slice(0, inspected.begin)}${after}`,
    removedBytes: Buffer.byteLength(chunk, "utf8"),
    removedSha256: sha256(chunk),
    removedSection: chunk,
    strategy: "sentinel-surgical",
  };
}

/**
 * 段状态快照（只读，不修改原文）：
 * `{ name, present, malformed, begin?, end?, bytes?, sha256?, bodyBytes?, bodySha256?, lineEnding }`
 * 缺失与「残缺/乱序/重复」用 present/malformed 区分（后者带 reason）。
 */
export function sectionSnapshot(text, name) {
  const sentinels = sentinelsFor(name);
  const doc = String(text ?? "");
  const inspected = inspectSection(doc, sentinels);
  const base = {
    name,
    lineEnding: detectLineEnding(doc),
    sentinels: { begin: sentinels.begin, end: sentinels.end },
  };
  if (inspected.status === "absent") {
    return { ...base, present: false, malformed: false };
  }
  if (inspected.status !== "ok") {
    return { ...base, present: false, malformed: true, reason: inspected.reason };
  }
  const chunk = doc.slice(inspected.begin, inspected.end);
  const body = doc.slice(inspected.bodyStart, inspected.bodyEnd);
  return {
    ...base,
    present: true,
    malformed: false,
    begin: inspected.begin,
    end: inspected.end,
    bodyBytes: Buffer.byteLength(body, "utf8"),
    bodySha256: sha256(body),
    bytes: Buffer.byteLength(chunk, "utf8"),
    sha256: sha256(chunk),
    beginsAtLineStart: inspected.begin === 0 || doc[inspected.begin - 1] === "\n",
    endsAtLineEnd:
      inspected.end === doc.length || doc[inspected.end] === "\n" || doc[inspected.end] === "\r",
  };
}

/** 供自检/审计复用的 UTF-8 sha256。 */
export { sha256 };
