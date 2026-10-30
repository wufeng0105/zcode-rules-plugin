// AGENTS.md 段操作单元测试：node:test + node:assert/strict，零依赖、离线可跑。
//
// 纪律：
//   · 文档夹具全部内联（含 LF / 无末尾换行 / CRLF / 中文 / Emoji），
//     **不读取 ZCode 检出、不读真实 home、不写盘**；
//   · 重点守两处历史缺陷：①「UTF-8 字节数」当「UTF-16 码元数」用来 slice（含中文必错）；
//     ② 哨兵兜底不摘自己加的分隔符（原文无末尾换行时还原失败）。
//   · 断言用独立计算的 sha256 交叉验证实现返回的 removedSha256。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  AGENTS_SECTION_BEGIN,
  AGENTS_SECTION_END,
  renderAgentsSection,
  validateRules,
} from "../src/rules/rules-engine.mjs";
import {
  BEGIN_MARK,
  END_MARK,
  locateSection,
  removeSection,
  removeSectionBySentinels,
  sha256,
  upsert,
} from "../src/rules/agents-section.mjs";

// ---------------------------------------------------------------------------
// 内联夹具
// ---------------------------------------------------------------------------
const EMPTY_RULES_RAW = {
  version: 1,
  name: "空模板（未启用任何放行策略）",
  unmatched: "abstain",
  onTimeout: "deny",
  watchdogMs: 120000,
  rules: [],
};

const ONE_RULE_RAW = {
  version: 1,
  name: "一条规则（测试夹具）",
  unmatched: "abstain",
  onTimeout: "deny",
  watchdogMs: 120000,
  rules: [
    {
      id: "ro-git-status",
      tool: "Bash",
      commandPattern: "^git status$",
      decision: "allow",
      comment: "只读查询",
    },
  ],
};

// 文档形态覆盖：末尾 LF / 无末尾换行 / CRLF / 中文与 Emoji
const DOC_LF = "# 用户文件\n\n用户自己写的内容。\n";
const DOC_NO_TRAILING_LF = "# 用户文件\n\n用户自己写的内容。";
const DOC_CRLF = "# 用户文件\r\n\r\n用户自己写的内容。\r\n";
const DOC_CJK = "# 中文原文\n\n用户自己的说明：中文、全角标点，Emoji 😀 与 ASCII 混排。\n";

function accept(raw) {
  const result = validateRules(raw);
  assert.equal(result.ok, true, `夹具必须合法：${result.errors.join(" | ")}`);
  return result.rules;
}

/** 独立于被测实现计算 sha256（显式 UTF-8 字节），用于交叉验证 */
function independentSha256(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** 安装夹具：断言此前无段、action=appended，并返回安装结果 */
function install(doc, raw = ONE_RULE_RAW) {
  const rules = accept(raw);
  const result = upsert(doc, rules);
  assert.equal(result.action, "appended", "夹具前提：安装前文档不含 zcode-rules 段");
  assert.ok(result.meta !== null, "首次追加必须返回 meta");
  return { result, rules, section: renderAgentsSection(rules) };
}

// ---------------------------------------------------------------------------
// 1. 定位
// ---------------------------------------------------------------------------
test("locateSection 定位哨兵边界，段外切片与原文逐字符一致", () => {
  const { result, section } = install(DOC_LF);
  const loc = locateSection(result.content);

  assert.ok(loc !== null);
  assert.equal(loc.begin, DOC_LF.length);
  assert.equal(loc.end, loc.begin + section.length);
  assert.equal(result.content.slice(loc.begin, loc.end), section);
  assert.equal(result.content.slice(0, loc.begin), DOC_LF);
});

test("locateSection 对缺哨兵/仅有其一返回 null", () => {
  assert.equal(locateSection(DOC_LF), null);
  assert.equal(locateSection(`${DOC_LF}${BEGIN_MARK}\n`), null);
  assert.equal(locateSection(`${DOC_LF}${END_MARK}\n`), null);
});

// ---------------------------------------------------------------------------
// 2. upsert：首次追加
// ---------------------------------------------------------------------------
test("upsert 首次追加：段以 BEGIN/END 包裹写在末尾，原文前缀逐字节不变", () => {
  const { result, section } = install(DOC_LF);
  const { content, meta } = result;

  assert.equal(content, `${DOC_LF}${section}\n`);
  assert.equal(content.slice(0, DOC_LF.length), DOC_LF);
  assert.ok(content.endsWith(`${section}\n`));
  assert.equal(content.split(BEGIN_MARK).length - 1, 1, "BEGIN 哨兵只能出现一次");
  assert.equal(content.split(END_MARK).length - 1, 1, "END 哨兵只能出现一次");

  // meta 必须同时记录码元数与字节数（防单位混淆）
  assert.equal(meta.originalChars, DOC_LF.length);
  assert.equal(meta.originalBytes, Buffer.byteLength(DOC_LF, "utf8"));
  assert.equal(meta.originalSha256, independentSha256(DOC_LF));
  assert.equal(meta.sep, "", "原文已以 LF 结尾，不应再加分隔符");
  assert.equal(meta.appendedChars, content.length - DOC_LF.length);
});

// ---------------------------------------------------------------------------
// 3. upsert：再次导出 = 替换（幂等）
// ---------------------------------------------------------------------------
test("upsert 二次导出为替换：段不重复、段外字节不变、旧段内容被清除", () => {
  const first = install(DOC_LF, EMPTY_RULES_RAW);
  assert.ok(first.result.content.includes(EMPTY_RULES_RAW.name));

  const newRules = accept(ONE_RULE_RAW);
  const second = upsert(first.result.content, newRules);

  assert.equal(second.action, "replaced");
  assert.equal(second.meta, null, "替换不动基线，不返回新 meta");
  assert.ok(second.content.startsWith(DOC_LF), "段外前缀必须逐字符保留");
  assert.equal(second.content.split(BEGIN_MARK).length - 1, 1);
  assert.equal(second.content.split(END_MARK).length - 1, 1);
  assert.equal(second.content.includes(EMPTY_RULES_RAW.name), false, "旧段不得残留");
  assert.equal(second.content, `${DOC_LF}${renderAgentsSection(newRules)}\n`);
  assert.equal(second.content.length - DOC_LF.length, renderAgentsSection(newRules).length + 1);
});

test("upsert 对同一规则重复导出是幂等的：内容不变", () => {
  const { result, rules } = install(DOC_LF);
  const again = upsert(result.content, rules);
  assert.equal(again.action, "replaced");
  assert.equal(again.content, result.content, "同输入重复导出不得改变文件内容");
});

// ---------------------------------------------------------------------------
// 4. 分隔符：原文无末尾换行时补 sep，并记入 meta
// ---------------------------------------------------------------------------
test("upsert 对无末尾换行的原文补 sep=\\n\\n 并记入 meta", () => {
  const { result, section } = install(DOC_NO_TRAILING_LF);
  assert.equal(result.meta.sep, "\n\n");
  assert.equal(
    result.content,
    `${DOC_NO_TRAILING_LF}\n\n${section}\n`,
    "原文与段之间应恰好两个换行",
  );
  assert.equal(result.meta.appendedChars, result.content.length - DOC_NO_TRAILING_LF.length);
});

// ---------------------------------------------------------------------------
// 5. removeSection（v1）：按 meta 精确回退
// ---------------------------------------------------------------------------
test("removeSection 用 meta 码元数精确回退（strategy=meta-exact）", () => {
  const { result, section } = install(DOC_LF);
  const removed = removeSection(result.content, result.meta);

  assert.equal(removed.action, "removed");
  assert.equal(removed.strategy, "meta-exact");
  assert.equal(removed.content, DOC_LF);
  assert.equal(removed.content.includes(section), false);
  assert.equal(sha256(removed.content), result.meta.originalSha256);
});

test("removeSection 无 meta 时按哨兵摘除并明确警告无法自校验", () => {
  const { result } = install(DOC_LF);
  const removed = removeSection(result.content);

  assert.equal(removed.action, "removed");
  assert.equal(removed.strategy, "sentinel-no-meta");
  assert.equal(removed.content, DOC_LF);
  assert.ok(typeof removed.warning === "string" && removed.warning.includes("无法自校验"));
});

// ---------------------------------------------------------------------------
// 6. CJK：UTF-8 字节 ≠ UTF-16 码元（历史缺陷 1 的回归位）
// ---------------------------------------------------------------------------
test("upsert 含中文/Emoji 时区块按码元计长、按字节计量，两者不相等且 meta-exact 可还原", () => {
  const { result } = install(DOC_CJK);
  const { content, meta } = result;
  const appendedTail = content.slice(DOC_CJK.length);

  assert.ok(DOC_CJK.includes("中文"));
  assert.equal(meta.appendedChars, appendedTail.length, "appendedChars 必须等于 UTF-16 码元数");
  assert.equal(meta.appendedBytes, Buffer.byteLength(appendedTail, "utf8"));
  assert.ok(meta.appendedBytes > meta.appendedChars, "UTF-8 字节数必须严格大于 UTF-16 码元数");
  assert.equal(content.length - DOC_CJK.length, meta.appendedChars, "码元差必须与 slice 单位一致");

  const removed = removeSection(content, meta);
  assert.equal(removed.action, "removed");
  assert.equal(removed.strategy, "meta-exact", "若用字节数截断，这里会偏移成 sentinel/refused");
  assert.equal(removed.content, DOC_CJK);
});

// ---------------------------------------------------------------------------
// 7. removeSectionBySentinels（v2）：正常摘除
// ---------------------------------------------------------------------------
test("removeSectionBySentinels 正常摘除：段外字节不变、哨兵零残留、审计值可复核", () => {
  const { result, section } = install(DOC_LF);
  const loc = locateSection(result.content);
  const chunk = result.content.slice(loc.begin, loc.end);
  assert.equal(chunk, section);

  const removed = removeSectionBySentinels(result.content, result.meta);

  assert.equal(removed.action, "removed");
  assert.equal(removed.strategy, "sentinel-surgical");
  assert.equal(removed.content, DOC_LF);
  assert.equal(removed.content.includes(BEGIN_MARK), false);
  assert.equal(removed.content.includes(END_MARK), false);
  assert.equal(removed.removedBytes, Buffer.byteLength(chunk, "utf8"));
  assert.equal(removed.removedSha256, independentSha256(chunk));
  assert.equal(removed.removedSha256, sha256(chunk));
});

test("removeSectionBySentinels 保留装后演化的段外内容（用户尾注不丢）", () => {
  const { result } = install(DOC_LF);
  const userTail = "\n## 装后尾注\n\n用户装后自己追加的内容。\n";
  const evolved = `${result.content}${userTail}`;

  const removed = removeSectionBySentinels(evolved, result.meta);

  assert.equal(removed.action, "removed");
  assert.equal(removed.content, `${DOC_LF}${userTail}`, "只摘投影段，用户尾注必须原样保留");
  assert.equal(removed.content.includes(BEGIN_MARK), false);
});

test("removeSectionBySentinels 无末尾换行 + 中文：把我方 sep 一并摘除并精确还原", () => {
  const doc = "# 中文标题\n最后一行没有换行，含中文内容";
  const { result } = install(doc);
  assert.equal(result.meta.sep, "\n\n");

  const removed = removeSectionBySentinels(result.content, result.meta);
  assert.equal(removed.action, "removed");
  assert.equal(removed.content, doc);
  assert.ok(removed.removedBytes > 0);

  const loc = locateSection(result.content);
  const sectionChunk = result.content.slice(loc.begin, loc.end);
  // 被摘除的块 = 我方分隔符（meta.sep）+ 投影段
  const removedChunk = `${result.meta.sep}${sectionChunk}`;
  assert.equal(removed.removedBytes, Buffer.byteLength(removedChunk, "utf8"));
  assert.equal(removed.removedSha256, independentSha256(removedChunk));
  assert.ok(removed.removedBytes > removedChunk.length, "中文段：UTF-8 字节数必须大于 UTF-16 码元数");
});

test("removeSectionBySentinels 保持 CRLF 文档的段外行尾不变", () => {
  const { result } = install(DOC_CRLF);
  assert.equal(result.meta.sep, "", "原文以 CRLF 结尾，不应再加分隔符");
  assert.equal(
    (result.content.match(/\r\n/g) ?? []).length,
    (DOC_CRLF.match(/\r\n/g) ?? []).length,
    "段外 CRLF 行尾不得被改写",
  );

  const removed = removeSectionBySentinels(result.content, result.meta);
  assert.equal(removed.action, "removed");
  assert.equal(removed.content, DOC_CRLF);
});

// ---------------------------------------------------------------------------
// 8. removeSectionBySentinels：拒绝盲删 / 幂等 absent
// ---------------------------------------------------------------------------
test("removeSectionBySentinels 哨兵残缺或乱序时 refused，内容原样返回", () => {
  const cases = [
    `${DOC_LF}${BEGIN_MARK}\n## 只有 BEGIN 的残段\n`,
    `${DOC_LF}${END_MARK}\n`,
    `${END_MARK}\n${DOC_LF}${BEGIN_MARK}\n`,
  ];

  for (const text of cases) {
    const removed = removeSectionBySentinels(text);
    assert.equal(removed.action, "refused", `应拒绝盲删：${JSON.stringify(text.slice(0, 40))}`);
    assert.equal(removed.content, text, "拒绝时不得改动任何字节");
    assert.ok(typeof removed.reason === "string" && removed.reason.length > 0);
  }
});

test("removeSectionBySentinels 对无段文档返回 absent 且内容不变", () => {
  const removed = removeSectionBySentinels(DOC_LF, { sep: "" });
  assert.equal(removed.action, "absent");
  assert.equal(removed.content, DOC_LF);
});

// ---------------------------------------------------------------------------
// 9. sha256 单位：显式 UTF-8 字节
// ---------------------------------------------------------------------------
test("sha256 按 UTF-8 字节计算（已知向量 + 中文独立复核）", () => {
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256("中文"), independentSha256("中文"));
  assert.equal(sha256("中文").length, 64);
});

// ---------------------------------------------------------------------------
// 10. 与投影的一致性：段内容必须是 renderAgentsSection 的原样输出
// ---------------------------------------------------------------------------
test("安装段与 renderAgentsSection 输出逐字符一致（单一规则源、两个出口）", () => {
  const rules = accept(ONE_RULE_RAW);
  const section = renderAgentsSection(rules);
  assert.ok(section.startsWith(AGENTS_SECTION_BEGIN));
  assert.ok(section.endsWith(AGENTS_SECTION_END));

  const { result } = install(DOC_LF);
  assert.ok(result.content.includes(section));
});
