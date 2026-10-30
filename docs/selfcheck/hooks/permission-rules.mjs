// 件 3 PermissionRequest hook：读外置规则 → 判 allow/deny/退赛，超时按 onTimeout 处理。
//
// ⚠️ 性质：**验证用参考实现**，不是交付实现（无安装、无默认开启、不写用户真实配置）。
//
// 三种输出的显式形态（用户 Q-13 要求：必须与"输出非法导致静默失效"可区分）：
//   1) allow  → { hookSpecificOutput: { hookEventName, decision: { behavior: "allow" } } }
//   2) deny   → { continue:false, reason, hookSpecificOutput: { ..., decision: { behavior:"deny", message } } }
//   3) abstain→ { hookSpecificOutput: { hookEventName }, systemMessage: "zcode-rules: abstain(<原因>)" }
//      ← 关键：**合法 JSON、但无 decision 字段**。产品侧 processHookOutput 会得到
//        permissionRequestResult=undefined / permissionBehavior=undefined → 该 hook 视为"无决定"，
//        竞速里 return undefined → broker 继续单边等 ⇒ **产品原行为完全不变**。
//        这与"空 stdout / 非法 stdout"不同：后者 parseHookStdout 返回 undefined 或抛错，
//        日志形态与"静默失效"混淆，无法审计。
//
// 看门狗（onTimeout 唯一可选 deny）：
//   走到"已介入但没能裁决"（本实现在规则不可读/求值异常时）→ setTimeout(watchdogMs) → exit 2 → 产品侧 deny。
//   **注意不要 unref 定时器**（unref 会导致 exit 0 + 空输出 = 决定被静默丢弃，阶段二反证①实证）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { evaluate, validateRules } from "../rules/rules-engine.mjs";

// 不变式：任何未捕获异常都必须落成 exit 2（deny），绝不能是 exit 1（会被产品侧当成"非 0 非 2"的失败）
process.on("uncaughtException", (error) => {
  process.stderr.write(`zcode-rules: uncaught exception, failing closed (exit 2 -> deny): ${String(error?.message ?? error)}\n`);
  process.exit(2);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`zcode-rules: unhandled rejection, failing closed (exit 2 -> deny): ${String(reason)}\n`);
  process.exit(2);
});

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const markerPath = argValue("--marker");
const rulesPath = argValue("--rules");

function writeMarker(payload) {
  if (!markerPath) return;
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(`${markerPath}.json`, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    /* marker 只是证据，不能影响判定 */
  }
}

function emitAllow(reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
      reason,
    })}\n`,
  );
  process.exit(0);
}

function emitDeny(reason) {
  process.stdout.write(
    `${JSON.stringify({
      continue: false,
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: reason },
      },
      reason,
    })}\n`,
  );
  process.exit(0);
}

// 显式退赛：合法 JSON 但**不含 decision**
function emitAbstain(reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PermissionRequest" },
      systemMessage: `zcode-rules: abstain (${reason})`,
    })}\n`,
  );
  process.exit(0);
}

// ---- 读输入 ----
let stdinText = "";
let input = {};
try {
  stdinText = readFileSync(0, "utf8");
  input = stdinText ? JSON.parse(stdinText) : {};
} catch (error) {
  // stdin 不可解析 = 无法判断。这是"已介入但没能裁决"→ 走看门狗（唯一 onTimeout=deny）
  writeMarker({ phase: "stdin-unreadable", error: String(error?.message ?? error) });
  process.exit(2);
}

// ---- 读规则 ----
let rules;
let rulesError;
try {
  if (!rulesPath) throw new Error("--rules 未提供");
  if (!existsSync(rulesPath)) throw new Error(`规则文件不存在: ${rulesPath}`);
  const raw = JSON.parse(readFileSync(rulesPath, "utf8"));
  const v = validateRules(raw);
  if (!v.ok) throw new Error(`规则校验失败: ${v.errors.join("; ")}`);
  rules = v.rules;
} catch (error) {
  rulesError = String(error?.message ?? error);
}

writeMarker({
  phase: "start",
  hookEventName: input.hookEventName,
  mode: input.mode,
  rulesPath,
  rulesError,
  toolName: input.toolName,
  toolUseId: input.tool_use_id,
});

// 规则不可用 = "已介入但没能裁决"。按 onTimeout（唯一可选 deny）：等看门狗到点 → exit 2 → deny
if (rulesError) {
  const fallbackWatchdogMs = Number(argValue("--watchdog-ms") ?? 120000);
  writeMarker({ phase: "rules-unusable-waiting-watchdog", rulesError, watchdogMs: fallbackWatchdogMs });
  const startedAt = Date.now();
  setTimeout(() => {
    writeMarker({ phase: "watchdog-fired-on-rules-error", waitedMs: Date.now() - startedAt });
    process.stderr.write(
      `zcode-rules: rules unusable (${rulesError}); onTimeout=deny after ${Date.now() - startedAt}ms (exit 2 -> deny)\n`,
    );
    process.exit(2);
  }, fallbackWatchdogMs);
} else {
  // ---- 求值 ----
  const verdict = evaluate(rules, input);
  writeMarker({ phase: "evaluated", verdict });

  if (verdict.kind === "allow") emitAllow(verdict.reason);
  if (verdict.kind === "deny") emitDeny(verdict.reason);
  // abstain / ask：显式退赛，产品原行为
  emitAbstain(verdict.reason);
}
