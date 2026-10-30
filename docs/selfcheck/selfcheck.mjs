#!/usr/bin/env node
// 一条命令自检：锚点漂移检测（exit 0/1/2）+ 规则源单一性（J3-6）
//
// 退出码语义（用户 Q-13/J3-3 要求三态明确）：
//   0 = 无漂移，且（若给了 AGENTS.md）规则投影一致
//   1 = 漂移（锚点变了）或 规则投影不一致
//   2 = 环境不可用（源码目录不存在 / node 版本不符 / 目标文件读不到 / 规则文件非法）
//
// 用法：
//   node selfcheck.mjs                          # 检查当前检出（默认）
//   node selfcheck.mjs --source-root <dir>      # 指定源码根（用于 exit 2 用例）
//   node selfcheck.mjs --rules <path> --agents-md <path>   # 加做 J3-6 一致性检查
//   node selfcheck.mjs --json                   # 机器可读输出
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { consistencyCheck, validateRules } from "./rules/rules-engine.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(HERE, "..", "..", "..");

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_ENV = 2;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const jsonMode = process.argv.includes("--json");
const sourceRoot = argValue("--source-root") ?? DEFAULT_REPO;
const rulesPath = argValue("--rules");
const agentsMdPath = argValue("--agents-md");

// 锚点表：plan/R-01.md §4 的 5 条（期望行号）+ 行为档由调用方另跑
// 每条：{ id, file, pattern, expectLine, why }
const ANCHORS = [
  {
    expectLine: 7,
    file: "apps/zcode-cli/packages/contracts/src/hooks/index.ts",
    id: "A1-hook-event-names",
    pattern: "export const HookEventName = \\{",
    why: "7 个事件名枚举；改名/增删会让 config 里 PermissionRequest 失效",
  },
  {
    expectLine: 205,
    file: "apps/zcode-cli/packages/core/src/tool/executor/permission-flow.ts",
    id: "A2-runHooks-switch",
    pattern: "runHooks: hooksAvailable",
    why: "hook 是否参与竞速的总开关",
  },
  {
    expectLine: 62,
    file: "apps/zcode-cli/packages/core/src/tool/executor/permission-responder-race.ts",
    id: "A3-race-broker-first",
    pattern: "requestBroker\\(brokerController\\.signal",
    why: "broker 先启动 + claimResponse 语义；决定 hook 有没有窗口",
  },
  {
    expectLine: 144,
    file: "apps/zcode-cli/packages/core/src/permission/service.ts",
    id: "A4-user-once",
    pattern: 'approvalMode: "user-once"',
    why: "user-once 范围；决定哪些请求跳过 hook",
  },
  {
    expectLine: 95,
    file: "apps/zcode-cli/packages/core/src/runtime/helpers/runtime-tools.ts",
    id: "A5-runner-gate",
    pattern: "runtime\\.config\\.hooks\\?\\.enabled \\|\\| deps\\.workspaceHookSnapshot",
    why: "runner 启用门；配了却不跑/没配却在跑都在这里",
  },
  // 件 3 新增：规则引擎依赖的不变式
  {
    expectLine: 139,
    file: "apps/zcode-cli/packages/core/src/runtime/types.ts",
    id: "A6-permission-timeout-field",
    pattern: "permissionTimeoutMs\\?: number",
    why: "无 host 超时的证据锚点；若上游补了 setter，看门狗策略需重议",
  },
  {
    expectLine: null, // 只要求存在，不要求行号（易漂移）
    file: "apps/zcode-cli/packages/core/src/hooks/output.ts",
    id: "A7-no-decision-passthrough",
    pattern: "if \\(!output\\) return result;",
    why: "无决定/空输出时返回空结果（显式退赛的语义基础）",
  },
];

function fail(code, message) {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ exitCode: code, message, ok: false })}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(code);
}

// ---- 环境检查（→ exit 2）----
if (!existsSync(sourceRoot) || !existsSync(path.join(sourceRoot, "apps", "zcode-cli"))) {
  fail(EXIT_ENV, `环境不可用：源码根不存在或不是 ZCode 检出: ${sourceRoot}`);
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
  fail(EXIT_ENV, `环境不可用：需要 Node >= 20（当前 ${process.version}）`);
}

// ---- 规则校验（→ exit 2，不是 1：规则坏了是"环境/输入不可用"而非"漂移"）----
let rules = null;
if (rulesPath) {
  if (!existsSync(rulesPath)) fail(EXIT_ENV, `环境不可用：规则文件不存在: ${rulesPath}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(rulesPath, "utf8"));
  } catch (error) {
    fail(EXIT_ENV, `环境不可用：规则文件不是合法 JSON: ${String(error?.message ?? error)}`);
  }
  const v = validateRules(raw);
  if (!v.ok) {
    fail(EXIT_ENV, `环境不可用：规则校验失败 → ${v.errors.join(" ; ")}`);
  }
  rules = v.rules;
}

// ---- 锚点检查（→ exit 1）----
const results = [];
for (const a of ANCHORS) {
  const full = path.join(sourceRoot, a.file);
  if (!existsSync(full)) {
    results.push({ ...a, status: "missing-file" });
    continue;
  }
  const text = readFileSync(full, "utf8");
  const lines = text.split(/\r?\n/);
  const hits = [];
  lines.forEach((line, idx) => {
    try {
      if (new RegExp(a.pattern).test(line)) hits.push(idx + 1);
    } catch {
      /* ignore */
    }
  });
  if (hits.length === 0) {
    results.push({ ...a, actualLines: [], status: "pattern-gone" });
    continue;
  }
  const ok = a.expectLine === null ? true : hits.includes(a.expectLine);
  results.push({ ...a, actualLines: hits, status: ok ? "ok" : "line-moved" });
}

const drift = results.filter((r) => r.status !== "ok");

// ---- 规则源单一性（J3-6，→ exit 1）----
let consistency = null;
if (rules && agentsMdPath) {
  if (!existsSync(agentsMdPath)) {
    fail(EXIT_ENV, `环境不可用：AGENTS.md 不存在: ${agentsMdPath}`);
  }
  consistency = consistencyCheck(rules, readFileSync(agentsMdPath, "utf8"));
}

// ---- AGENTS.md 尺寸预警（2026-10-30 T3 新增，用户要求；预警不判红）----
// 依据：产品读取上限 100*1024（adapters/src/context/index.ts:25 DEFAULT_MAX_BYTES），
// 超限整文件截断（request-user-context.ts:119-122 追加 [File truncated] 标记）。
// >90KB 即预警：接近截断线，zcode-rules 投影段可能不完整。只打印，不改 exit 码。
const agentsMdWarnings = [];
if (agentsMdPath && existsSync(agentsMdPath)) {
  const st = statSync(agentsMdPath);
  if (st.size > 90 * 1024) {
    agentsMdWarnings.push(
      `AGENTS.md ${st.size}B 已超 90KB 预警线（产品读取上限 100*1024，adapters/src/context/index.ts:25）；超限会被截断，zcode-rules 段可能不完整`,
    );
  }
}

// ---- 输出 ----
const driftCount = drift.length;
const consistencyBad = consistency && !consistency.ok;

if (jsonMode) {
  process.stdout.write(
    `${JSON.stringify(
      {
        agentsMdWarnings,
        anchors: results.map((r) => ({
          actualLines: r.actualLines,
          expectLine: r.expectLine,
          file: r.file,
          id: r.id,
          status: r.status,
          why: r.why,
        })),
        consistency,
        driftCount,
        exitCode: driftCount > 0 || consistencyBad ? EXIT_DRIFT : EXIT_OK,
        node: process.version,
        ok: driftCount === 0 && !consistencyBad,
        sourceRoot,
      },
      null,
      2,
    )}\n`,
  );
} else {
  process.stdout.write(`自检 · sourceRoot=${sourceRoot}\n`);
  process.stdout.write(`node=${process.version}\n\n`);
  for (const r of results) {
    const mark = r.status === "ok" ? "OK  " : "DRIFT";
    const actual = r.actualLines?.length ? `实际行=${r.actualLines.join(",")}` : "未命中";
    process.stdout.write(
      `[${mark}] ${r.id.padEnd(28)} ${r.file}:${r.expectLine ?? "任意"}  ${actual}\n`,
    );
    if (r.status !== "ok") {
      process.stdout.write(`         为什么敏感：${r.why}\n`);
      if (r.status === "pattern-gone") {
        process.stdout.write(`         正则：${r.pattern}\n`);
      }
    }
  }
  if (consistency) {
    process.stdout.write(`\n规则源单一性（J3-6）：${consistency.ok ? "一致" : "不一致"}\n`);
    for (const p of consistency.problems) process.stdout.write(`  - ${p}\n`);
  }
  if (agentsMdWarnings.length > 0) {
    process.stdout.write(`\nAGENTS.md 尺寸预警：\n`);
    for (const w of agentsMdWarnings) process.stdout.write(`  [WARN] ${w}\n`);
  }
  process.stdout.write(
    `\n结论：${driftCount === 0 && !consistencyBad ? "无漂移（exit 0）" : `漂移 ${driftCount} 条${consistencyBad ? " + 投影不一致" : ""}（exit 1）`}\n`,
  );
}

process.exit(driftCount > 0 || consistencyBad ? EXIT_DRIFT : EXIT_OK);
