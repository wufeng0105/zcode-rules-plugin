// PermissionRequest hook 入口 launcher（v0.2.1）。
//
// 为什么需要这一层：真实 home 首次安装时数据目录还没有 rules.json。参考 hook 在
// "规则不可读" 时按 onTimeout=deny 走看门狗（120s 后 exit 2 → deny），这会让
// 「还没配置规则」变成「拒绝所有权限请求」——违反「空规则 = 零行为变化」。
//
// 本 launcher 的选择顺序：
//   1) <data>/rules.json 存在 → 交给参考 hook 判定（数据规则永远优先）；
//   2) 否则 <default> 存在（缺省 `${ZCODE_PLUGIN_ROOT}/rules.default.json`）→ 用内置空规则；
//   3) 两者都不存在 → 直接输出合法 abstain（无 decision + systemMessage），exit 0；
//   4) 委托执行（spawnSync，stdin 原文透传），原样转发输出并继承 0/2 退出码；
//   5) launcher 自身任何异常（含委托基础设施失败）→ 输出合法 abstain + stderr + exit 0。
//
// 边界：
//   · 不创建、不写任何文件（数据目录不存在也不 mkdir）；
//   · 不解析 stdin（JSON 合法性由参考 hook 判定：非法 stdin 仍 fail-closed exit 2）；
//   · 不持有定时器（看门狗在参考 hook 内，不要 unref）；
//   · 无外部依赖。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_EVENT = "PermissionRequest";
const DEFAULT_RULES_FILE = "rules.default.json";
const RULES_FILE = "rules.json";
const EXIT_ABSTAIN = 0;
const EXIT_DENY = 2;
const MAX_BUFFER = 16 * 1024 * 1024;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REFERENCE_HOOK = join(MODULE_DIR, "permission-rules.mjs");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function describe(error) {
  return String(error?.message ?? error);
}

// 合法 abstain：合法 JSON、无 decision 字段。产品侧会把它当作"无决定"，原行为不变。
function emitAbstain(reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: HOOK_EVENT },
      systemMessage: `zcode-rules: abstain (entry: ${reason})`,
    })}\n`,
  );
  return EXIT_ABSTAIN;
}

function failSafe(context, error) {
  const message = error === undefined ? context : `${context}: ${describe(error)}`;
  process.stderr.write(`zcode-rules-entry: ${message}; abstain (fail-safe, zero behavior change)\n`);
  return emitAbstain(message);
}

// 委托输出必须是"合法 JSON 对象"，否则产品侧会 parse 失败 → 静默失效。
// 这里只做最小校验，不改写字节。
function isJsonObject(text) {
  try {
    const parsed = JSON.parse(text.trim());
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function readStdin() {
  return readFileSync(0, "utf8");
}

function chooseRules() {
  const dataDir = firstNonEmpty(argValue("--data"), process.env.ZCODE_PLUGIN_DATA);
  const root = firstNonEmpty(argValue("--root"), process.env.ZCODE_PLUGIN_ROOT);
  const explicitDefault = firstNonEmpty(argValue("--default"));

  const dataRulesPath = dataDir ? join(resolve(dataDir), RULES_FILE) : null;
  const defaultRulesPath = explicitDefault
    ? resolve(explicitDefault)
    : root
      ? join(resolve(root), DEFAULT_RULES_FILE)
      : null;

  if (dataRulesPath && existsSync(dataRulesPath)) {
    return { chosen: dataRulesPath, dataRulesPath, defaultRulesPath };
  }
  if (defaultRulesPath && existsSync(defaultRulesPath)) {
    return { chosen: defaultRulesPath, dataRulesPath, defaultRulesPath };
  }
  return { chosen: null, dataRulesPath, defaultRulesPath };
}

function delegate(stdinText, chosenRulesPath) {
  const args = [REFERENCE_HOOK, "--rules", chosenRulesPath];
  const watchdogMs = firstNonEmpty(argValue("--watchdog-ms"));
  if (watchdogMs) args.push("--watchdog-ms", watchdogMs);

  let result;
  try {
    result = spawnSync(process.execPath, args, {
      encoding: "utf8",
      input: stdinText,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
  } catch (error) {
    return { status: failSafe("delegate spawn threw", error) };
  }

  if (result.error) return { status: failSafe("delegate spawn failed", result.error) };

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";

  if (result.status === EXIT_ABSTAIN) {
    if (!isJsonObject(stdout)) {
      if (stderr) process.stderr.write(stderr);
      return { status: failSafe("delegate produced empty or invalid JSON") };
    }
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    return { status: EXIT_ABSTAIN };
  }

  if (result.status === EXIT_DENY) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    return { status: EXIT_DENY };
  }

  if (stderr) process.stderr.write(stderr);
  const detail = result.signal
    ? `delegate killed by signal ${result.signal}`
    : `delegate exited with unexpected status ${JSON.stringify(result.status)}`;
  return { status: failSafe(detail) };
}

function main() {
  // 1) 同步读全量 stdin（不解析：原文交给参考 hook）
  let stdinText;
  try {
    stdinText = readStdin();
  } catch (error) {
    return failSafe("stdin unreadable", error);
  }

  // 2) 规则选择：数据规则优先；缺则内置空规则；两者皆缺 → abstain
  let selection;
  try {
    selection = chooseRules();
  } catch (error) {
    return failSafe("rule path resolution failed", error);
  }

  if (!selection.chosen) {
    const attempted = [
      selection.dataRulesPath ? `data=${selection.dataRulesPath}` : "data=<unset>",
      selection.defaultRulesPath ? `default=${selection.defaultRulesPath}` : "default=<unset>",
    ].join(", ");
    return emitAbstain(`no rules file (${attempted})`);
  }

  // 3) 委托参考 hook：stdin 原文透传，0/2 退出码继承
  return delegate(stdinText, selection.chosen).status;
}

try {
  process.exitCode = main();
} catch (error) {
  process.exitCode = failSafe("unexpected launcher exception", error);
}
