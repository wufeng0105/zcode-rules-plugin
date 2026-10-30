// hook 入口 launcher（src/hooks/permission-rules-entry.mjs）端到端单测
//
// 全部通过 spawnSync 真进程跑：stdin 是 hook JSON，规则文件落在 os.tmpdir()。
// 不读真实 home、不读 ZCode 检出、不写临时目录之外的位置。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO_ROOT, "src", "hooks", "permission-rules-entry.mjs");
const DEFAULT_RULES = join(REPO_ROOT, "rules.default.json");

const HOOK_INPUT = `${JSON.stringify({ hookEventName: "PermissionRequest", toolName: "Bash", mode: "build" })}\n`;

const ALLOW_RULES = {
  version: 1,
  name: "入口测试放行",
  unmatched: "abstain",
  rules: [{ id: "allow-bash", tool: "Bash", decision: "allow", comment: "测试用：放行 Bash" }],
};

const DENY_RULES = {
  version: 1,
  name: "入口测试拒绝",
  unmatched: "abstain",
  rules: [{ id: "deny-bash", tool: "Bash", decision: "deny", comment: "测试用：拒绝 Bash" }],
};

const EMPTY_RULES = {
  version: 1,
  name: "入口测试空规则",
  unmatched: "abstain",
  rules: [],
};

const KEPT_DIRS = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-rules-entry-"));
  KEPT_DIRS.push(dir);
  return dir;
}

after(() => {
  for (const dir of KEPT_DIRS) rmSync(dir, { force: true, recursive: true });
});

function writeRules(dir, rules) {
  const path = join(dir, "rules.json");
  writeFileSync(path, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
  return path;
}

function runEntry(args, { env = {}, input = HOOK_INPUT, timeout = 20000 } = {}) {
  const childEnv = { ...process.env };
  delete childEnv.ZCODE_PLUGIN_DATA;
  delete childEnv.ZCODE_PLUGIN_ROOT;
  Object.assign(childEnv, env);
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: "utf8",
    env: childEnv,
    input,
    timeout,
    windowsHide: true,
  });
  return {
    durationMs: Date.now() - startedAt,
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function payloadOf(result) {
  assert.equal(typeof result.stdout, "string");
  return JSON.parse(result.stdout);
}

function assertAbstain(result) {
  assert.equal(result.status, 0, `abstain 必须 exit 0；stderr=${result.stderr}`);
  const payload = payloadOf(result);
  assert.equal(payload.hookSpecificOutput?.hookEventName, "PermissionRequest");
  assert.equal(
    Object.prototype.hasOwnProperty.call(payload.hookSpecificOutput, "decision"),
    false,
    "abstain 不得含 decision 字段",
  );
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "decision"), false);
  assert.match(payload.systemMessage, /abstain/);
}

test("数据目录无 rules.json → 用内置空规则 abstain（exit 0，无 decision）", () => {
  const dataDir = tempDir();
  const result = runEntry(["--data", dataDir, "--default", DEFAULT_RULES]);
  assertAbstain(result);
});

test("数据规则缺失 + --root 指向含 rules.default.json 的根 → 回退生效（allow）", () => {
  const root = tempDir();
  writeFileSync(join(root, "rules.default.json"), `${JSON.stringify(ALLOW_RULES, null, 2)}\n`, "utf8");
  const result = runEntry(["--data", tempDir(), "--root", root]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"behavior":"allow"/);
  assert.match(payloadOf(result).reason, /allow-bash/);
});

test("数据目录与 default 均不存在 → abstain（不 deny、不静默）", () => {
  const missingDefault = join(tempDir(), "does-not-exist.json");
  const result = runEntry(["--data", tempDir(), "--default", missingDefault]);
  assertAbstain(result);
  assert.match(payloadOf(result).systemMessage, /entry: no rules file/);
});

test("数据 rules 命中 allow → 原样转发 behavior=allow（exit 0）", () => {
  const dataDir = tempDir();
  writeRules(dataDir, ALLOW_RULES);
  const result = runEntry(["--data", dataDir]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"behavior":"allow"/);
  assert.match(payloadOf(result).reason, /allow-bash/);
});

test("数据 rules 命中 deny → 原样转发 behavior=deny（exit 0，2=deny 只用于 fail-closed）", () => {
  const dataDir = tempDir();
  writeRules(dataDir, DENY_RULES);
  const result = runEntry(["--data", dataDir]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"behavior":"deny"/);
  assert.match(payloadOf(result).reason, /deny-bash/);
});

test("数据 rules 未命中 → abstain（数据路径也保持空规则语义）", () => {
  const dataDir = tempDir();
  writeRules(dataDir, EMPTY_RULES);
  assertAbstain(runEntry(["--data", dataDir]));
});

test("非法数据规则 + 短 watchdog → 继承 exit 2（fail-closed 仍有效）", () => {
  const dataDir = tempDir();
  writeFileSync(join(dataDir, "rules.json"), "{ 这不是合法 JSON", "utf8");
  const result = runEntry(["--data", dataDir, "--watchdog-ms", "80"]);
  assert.equal(result.status, 2);
  assert.ok(result.durationMs < 10000, `短 watchdog 不应长等：${result.durationMs}ms`);
});

test("stdin 原文透传：BOM 输入在子进程 JSON.parse 失败 → exit 2；同规则无 BOM → allow", () => {
  const dataDir = tempDir();
  writeRules(dataDir, ALLOW_RULES);

  const withBom = runEntry(["--data", dataDir], { input: `\uFEFF${HOOK_INPUT}` });
  assert.equal(withBom.status, 2, "BOM 未被 launcher 吞掉，说明 stdin 原文透传");

  const normal = runEntry(["--data", dataDir]);
  assert.equal(normal.status, 0);
  assert.match(normal.stdout, /"behavior":"allow"/);
});

test("数据规则优先于内置 default（数据 deny 覆盖 default allow）", () => {
  const defaultRoot = tempDir();
  writeFileSync(join(defaultRoot, "rules.default.json"), `${JSON.stringify(ALLOW_RULES, null, 2)}\n`, "utf8");
  const dataDir = tempDir();
  writeRules(dataDir, DENY_RULES);
  const result = runEntry(["--data", dataDir, "--root", defaultRoot]);
  assert.equal(result.status, 0);
  assert.match(payloadOf(result).reason, /deny-bash/);
});

test("参数缺省时回退 ZCODE_PLUGIN_DATA / ZCODE_PLUGIN_ROOT", () => {
  const root = tempDir();
  writeFileSync(join(root, "rules.default.json"), `${JSON.stringify(ALLOW_RULES, null, 2)}\n`, "utf8");
  const dataDir = tempDir();
  writeRules(dataDir, DENY_RULES);
  const result = runEntry([], {
    env: { ZCODE_PLUGIN_DATA: dataDir, ZCODE_PLUGIN_ROOT: root },
  });
  assert.equal(result.status, 0);
  assert.match(payloadOf(result).reason, /deny-bash/, "数据规则应优先于 default");
});

test("launcher 委托失败（参考 hook 缺失）→ 显式 abstain（exit 0，不 deny、不静默）", () => {
  const brokenDir = tempDir();
  mkdirSync(brokenDir, { recursive: true });
  copyFileSync(ENTRY, join(brokenDir, "permission-rules-entry.mjs"));

  const dataDir = tempDir();
  writeRules(dataDir, ALLOW_RULES);
  const child = spawnSync(
    process.execPath,
    [join(brokenDir, "permission-rules-entry.mjs"), "--data", dataDir],
    { encoding: "utf8", input: HOOK_INPUT, timeout: 20000, windowsHide: true },
  );
  const result = { durationMs: 0, status: child.status, stderr: child.stderr ?? "", stdout: child.stdout ?? "" };

  assertAbstain(result);
  assert.match(result.stderr, /delegate/);
});
