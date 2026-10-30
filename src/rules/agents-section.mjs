// AGENTS.md 段操作：导出（幂等 upsert）与卸载（逐字节还原）
//
// 用户真实 ~/.zcode/AGENTS.md 形态（2026-10-30 实测）：
//   5860 B / sha256 d395433199adff7f... / LF 行尾 / 无 BOM / 末尾为 "\n\n" / 无 zcode-rules 段
//
// 硬要求（用户 2026-10-30）：
//   · 安装：保留原内容、段可精确定位
//   · 卸载：**逐字节还原**（sha256 必须回到原值）
//
// ── 2026-10-30 阶段三独立复核发现并修掉的两个缺陷（WP12）──────────────────
//
//   缺陷 1（致命，静默）：`appendedBytes` 记的是 **UTF-8 字节数**，而 `text.slice()`
//     用的是 **UTF-16 码元数**。段内含中文时两者必然不等，于是 meta-exact 路径
//     **永远算错**（slice 位置偏移），只是被 sentinel 兜底掩盖成"成功"。
//     修法：meta 另记 `appendedChars`（UTF-16 码元数），截断用码元数；
//           `appendedBytes` 保留仅作人类可读信息。
//
//   缺陷 2（形态相关）：sentinel 兜底只删"段 + 段后一个换行"，**不删我们加的
//     分隔符**。原文末尾无换行时我们加了 "\n\n"，兜底就把这 2 字节留在结果里，
//     导致 3 种形态（无末尾换行的 LF / CRLF / BOM）**还原失败**（判 refused）。
//     修法：meta 记下 `sep` 原文，兜底按它精确回退。
//
//   复核证据：`.zhll/rt/wp12/edge-roundtrip.out.txt`（修前 6/9 通过）
// ─────────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { renderAgentsSection } from "./rules-engine.mjs";

export const BEGIN_MARK = "<!-- BEGIN zcode-rules";
export const END_MARK = "<!-- END zcode-rules -->";

const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** 定位段落边界；返回 { begin, end } 或 null */
export function locateSection(text) {
  const begin = text.indexOf(BEGIN_MARK);
  const endMark = text.indexOf(END_MARK);
  if (begin < 0 || endMark < 0 || endMark < begin) return null;
  return { begin, end: endMark + END_MARK.length };
}

/**
 * 幂等导出。返回 { action, content, meta }。
 * meta 记录卸载所需的一切（同时给码元数与字节数，避免单位混淆）。
 */
export function upsert(text, rules) {
  const section = renderAgentsSection(rules);

  const loc = locateSection(text);
  if (loc) {
    // 已存在段 → 只替换段内，段外逐字节保留
    const before = text.slice(0, loc.begin);
    const afterRaw = text.slice(loc.end);
    const after = afterRaw.startsWith("\n") ? afterRaw.slice(1) : afterRaw;
    return {
      action: "replaced",
      content: `${before}${section}\n${after}`,
      meta: null, // 替换不动基线，调用方保留既有 meta
    };
  }

  // 首次安装：原文 + 分隔 + 段 + "\n"
  const sep = text.length === 0 ? "" : /\r?\n$/.test(text) ? "" : "\n\n";
  const appended = `${sep}${section}\n`;
  return {
    action: "appended",
    content: `${text}${appended}`,
    meta: {
      // ★ 截断必须用码元数（与 String.prototype.slice 同单位）
      appendedChars: appended.length,
      // 人类可读信息，不参与计算
      appendedBytes: Buffer.byteLength(appended, "utf8"),
      installedAt: new Date().toISOString(),
      originalBytes: Buffer.byteLength(text, "utf8"),
      originalChars: text.length,
      originalSha256: sha256(text),
      // ★ 兜底回退所需：我们实际加了什么分隔符
      sep,
    },
  };
}

/**
 * 卸载：按 meta 精确回退，并用 sha256 自校验。
 * 返回 { action: "removed"|"absent"|"refused", content?, strategy?, reason? }
 */
export function removeSection(text, meta) {
  const loc = locateSection(text);
  if (!loc) return { action: "absent", content: text, reason: "段不存在" };

  // 策略 1：按 meta.appendedChars 精确截断（码元单位，与 slice 一致）
  if (meta && typeof meta.appendedChars === "number" && meta.appendedChars > 0) {
    const expected = text.slice(0, text.length - meta.appendedChars);
    if (sha256(expected) === meta.originalSha256) {
      return { action: "removed", content: expected, strategy: "meta-exact" };
    }
  }

  // 策略 2：按哨兵删除；若有 meta.sep，连分隔符一起精确回退
  const beforeRaw = text.slice(0, loc.begin);
  const sep = typeof meta?.sep === "string" ? meta.sep : "";
  const before = sep && beforeRaw.endsWith(sep) ? beforeRaw.slice(0, -sep.length) : beforeRaw;
  const afterRaw = text.slice(loc.end);
  const after = afterRaw.startsWith("\n") ? afterRaw.slice(1) : afterRaw;
  const candidate = `${before}${after}`;

  if (meta && typeof meta.originalSha256 === "string") {
    if (sha256(candidate) === meta.originalSha256) {
      return { action: "removed", content: candidate, strategy: "sentinel" };
    }
    return {
      action: "refused",
      reason:
        `无法逐字节还原：候选 sha256=${sha256(candidate).slice(0, 16)}… ` +
        `≠ 记录原值 ${meta.originalSha256.slice(0, 16)}…。请用安装时生成的 .bak 备份还原。`,
    };
  }

  // 无 meta：只能按哨兵删，明确告知无法自校验
  return {
    action: "removed",
    content: candidate,
    strategy: "sentinel-no-meta",
    warning: "没有安装元数据，无法自校验逐字节还原；请用 .bak 备份核对",
  };
}

/**
 * 卸载 v2（2026-10-30 收尾补账 #3，用户裁定）：sentinel 外科摘除 ——
 * 只摘我们加的投影段（含装时记录的 sep 与段后一个换行，均由 upsert 的逆操作决定），
 * **保留用户装后自行演化的前后内容**。
 *
 * 为什么不再对 originalSha256 做门禁：v1 语义是"逐字节还原装机前文件"；用户装后
 * 编辑过文件（如 2026-10-30 15:58 的 §0 节）后该 sha 必然失配，v1 会 fail-closed
 * 拒绝卸载（安全但"卸不掉"）。v2 的安全属性改为：①摘除块必须以 BEGIN 哨兵起、
 * END 哨兵止（残缺/乱序一律 refused，绝不盲删）；②摘后哨兵零残留；③段外字节不动。
 *
 * 返回 { action: "removed"|"absent"|"refused", content?, removedBytes?, removedSha256?, strategy?, reason? }
 */
export function removeSectionBySentinels(text, meta) {
  const begin = text.indexOf(BEGIN_MARK);
  const endMark = text.indexOf(END_MARK);
  if (begin < 0 && endMark < 0) return { action: "absent", content: text, reason: "段不存在" };
  if (begin < 0 || endMark < 0) {
    return { action: "refused", content: text, reason: "哨兵残缺（BEGIN/END 只剩其一），拒绝盲删；请手工核对段结构" };
  }
  if (endMark < begin) {
    return { action: "refused", content: text, reason: "END 哨兵出现在 BEGIN 之前，段结构异常，拒绝盲删" };
  }
  const end = endMark + END_MARK.length;
  // 段前：若紧贴 BEGIN 的是装时记录的 sep（我们加的），一并摘除；否则原样保留（用户内容）
  const beforeRaw = text.slice(0, begin);
  const sep = typeof meta?.sep === "string" ? meta.sep : "";
  const before = sep && beforeRaw.endsWith(sep) ? beforeRaw.slice(0, -sep.length) : beforeRaw;
  // 段后：upsert 写入形态是 段+"\n"，逆操作摘掉这一个换行；其余（用户尾注）原样保留
  const afterRaw = text.slice(end);
  const after = afterRaw.startsWith("\n") ? afterRaw.slice(1) : afterRaw;
  const chunk = text.slice(before.length, end);
  return {
    action: "removed",
    content: `${before}${after}`,
    removedBytes: Buffer.byteLength(chunk, "utf8"),
    removedSha256: sha256(chunk),
    strategy: "sentinel-surgical",
  };
}

export function readIfExists(p) {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export { sha256 };
