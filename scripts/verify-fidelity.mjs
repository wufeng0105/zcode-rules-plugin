#!/usr/bin/env node
// 参照实现保真校验：4 个文件的实际 sha256 必须与仓库内 FIDELITY.json 的基线**全等**。
//
// 为什么基线在仓库里而不是在 ZCode 检出里：
//   ZCode 检出（docs/zcode-mod/selfcheck/）只存在于作者本机，CI runner 上没有它。
//   把基线落成仓库内文件后，任何人在任何机器上 `node scripts/verify-fidelity.mjs`
//   都能判「这 4 个文件有没有被改过」，不需要 ZCode 检出、不需要联网。
//
// 基线值的出处：2026-10-30 WP33 实测（README「来源与保真」表逐行同源）。
//   重新生成：node scripts/verify-fidelity.mjs --list
//
// 用法：
//   node scripts/verify-fidelity.mjs                     # 校验；exit 0 全等 / 1 有差异或基线不可用
//   node scripts/verify-fidelity.mjs --list               # 只打印实测 sha256（不比对）
//   node scripts/verify-fidelity.mjs --root <dir> --manifest <file>
//                                                         # 换根/换基线（单测用，不碰工作树）
//
// 失败判据（任一即 exit 1，绝不"少查一个就算过"）：
//   · 基线 JSON 不可读 / 不是对象
//   · 基线键集合与本文件的 REFERENCE_FILES 不一致（**少一条或多一条都算失败**，
//     否则「删掉一条基线」就能让保真校验静默失效）
//   · 基线值不是 64 位小写十六进制
//   · 被校验文件缺失、读失败，或 sha256 与基线不等
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 参照实现清单：这 4 个文件从 ZCode 检出 `docs/zcode-mod/selfcheck/` 原样复制，**不改一行**。
// 清单本身是代码常量，不从基线文件里读——否则改基线就能改清单。
export const REFERENCE_FILES = Object.freeze([
  "src/rules/rules-engine.mjs",
  "src/rules/agents-section.mjs",
  "src/rules/export-agents.mjs",
  "src/hooks/permission-rules.mjs",
]);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SHA256_RE = /^[0-9a-f]{64}$/;

function parseArgs(argv) {
  const opts = { list: false, manifest: join(REPO_ROOT, "FIDELITY.json"), root: REPO_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") opts.list = true;
    else if (arg === "--manifest") opts.manifest = resolve(argv[(i += 1)] ?? "");
    else if (arg === "--root") opts.root = resolve(argv[(i += 1)] ?? "");
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "用法: node scripts/verify-fidelity.mjs [--list] [--root <dir>] [--manifest <file>]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`未知参数：${arg}\n用法: node scripts/verify-fidelity.mjs [--list] [--root <dir>] [--manifest <file>]\n`);
      process.exit(2);
    }
  }
  return opts;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readBaseline(manifestPath) {
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: [`基线文件不存在：${manifestPath}`], baseline: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, errors: [`基线不是合法 JSON：${String(error?.message ?? error)}`], baseline: null };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: ["基线必须是 JSON 对象：{ \"<相对路径>\": \"<sha256>\" }"], baseline: null };
  }
  const errors = [];
  const missing = REFERENCE_FILES.filter((f) => !Object.prototype.hasOwnProperty.call(parsed, f));
  const extra = Object.keys(parsed).filter((k) => !REFERENCE_FILES.includes(k));
  if (missing.length > 0) errors.push(`基线缺少条目：${missing.join(", ")}`);
  if (extra.length > 0) errors.push(`基线含清单外条目（清单是代码常量，不接受扩张）：${extra.join(", ")}`);
  for (const file of REFERENCE_FILES) {
    const value = parsed[file];
    if (value === undefined) continue;
    if (typeof value !== "string" || !SHA256_RE.test(value)) {
      errors.push(`基线值非法（需 64 位小写十六进制）：${file} = ${JSON.stringify(value)}`);
    }
  }
  return { ok: errors.length === 0, errors, baseline: parsed };
}

const opts = parseArgs(process.argv.slice(2));
const loaded = readBaseline(opts.manifest);

if (opts.list) {
  process.stdout.write(`# 实测 sha256（root=${opts.root}）\n`);
  for (const file of REFERENCE_FILES) {
    const target = join(opts.root, file);
    process.stdout.write(`${file}  ${existsSync(target) ? sha256File(target) : "<文件缺失>"}\n`);
  }
  process.exit(loaded.ok ? 0 : 1);
}

process.stdout.write(`# 参照实现保真校验\n# root=${opts.root}\n# manifest=${opts.manifest}\n`);

if (!loaded.ok) {
  for (const error of loaded.errors) process.stderr.write(`FAIL  ${error}\n`);
  process.stderr.write("结论：基线不可用，拒绝报「全部一致」（fail-closed）\n");
  process.exit(1);
}

let failed = 0;
for (const file of REFERENCE_FILES) {
  const expected = loaded.baseline[file];
  const target = join(opts.root, file);
  if (!existsSync(target)) {
    failed += 1;
    process.stdout.write(`FAIL  ${file}\n      文件缺失：${target}\n`);
    continue;
  }
  let actual;
  try {
    actual = sha256File(target);
  } catch (error) {
    failed += 1;
    process.stdout.write(`FAIL  ${file}\n      读失败：${String(error?.message ?? error)}\n`);
    continue;
  }
  if (actual === expected) {
    process.stdout.write(`ok    ${file}\n      sha256=${actual}\n`);
  } else {
    failed += 1;
    process.stdout.write(
      `FAIL  ${file}\n      期望 sha256=${expected}\n      实测 sha256=${actual}\n` +
        "      这 4 个文件是参照实现，必须逐字节不变；改它就等于改了「一份规则源、两个出口」的基准。\n",
    );
  }
}

process.stdout.write(
  failed === 0
    ? `结论：${REFERENCE_FILES.length} 个参照实现逐字节一致（exit 0）\n`
    : `结论：${failed} 个文件与基线不一致（exit 1）\n`,
);
process.exit(failed === 0 ? 0 : 1);
