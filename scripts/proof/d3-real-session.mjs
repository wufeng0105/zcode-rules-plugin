// 路径全部可由环境变量覆盖；仓库根由本文件位置自推导。
//   ZCODE_CLI_ENTRY    ZCode 的 CLI 入口（默认 Windows 安装位置）
//   ZCODE_INSTALL_DIR ZCode 安装目录（默认 Windows 安装位置，用于产物指纹）
//   ZCODE_WORKSPACE   会话工作区（默认当前目录）
// WP42 / T44 · A 组：D-3 真实会话证据
// 判据：面板写第一条 allow 规则 → **新会话**命中该命令 → 不弹窗且执行（permission.resolved 证据）
//
// 方法：协议客户端（app-server）驱动真实会话；客户端对 interaction/requestPermission **延迟 8s 后答 deny**
//       （若 hook 的 allow 决策生效，命令仍会执行 ⇒ 不弹窗且执行）
// 证据：ZCode 日志里的 tool.permission.resolved 事件（hook 决策被采纳的记录）
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path, { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = process.env.ZCODE_CLI_ENTRY ?? "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs";
const REPO = process.env.ZCODE_WORKSPACE ?? process.cwd();
const HOME = process.env.USERPROFILE;
const PLUGIN_ID = "zcode-rules@zcode-rules-github";
const DATA = path.join(HOME, ".zcode", "cli", "plugins", "data", PLUGIN_ID);
const AGENTS = path.join(HOME, ".zcode", "AGENTS.md");
const RT = process.env.ZCODE_PROOF_OUT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".proof-runs", "d3-real-session");
const CANARY = path.join(RT, "d3-canary");
const LOG_DIR = path.join(RT, "logs");
mkdirSync(RT, { recursive: true });

const lines = [];
const say = (s) => {
  lines.push(s);
  console.log(s);
};
let failed = 0;
const ok = (c, l, d = "") => {
  say(`  [${c ? "PASS" : "FAIL"}] ${l}${d ? ` · ${d}` : ""}`);
  if (!c) failed++;
};

// 写一条 allow 规则（等价「面板写第一条 allow 规则」后的真源）
const rules = {
  version: 1,
  name: "D-3 真实会话验证",
  description: "面板等价写入",
  unmatched: "abstain",
  onTimeout: "deny",
  watchdogMs: 120000,
  rules: [
    {
      id: "d3-allow-echo",
      tool: "Bash",
      commandPattern: "^touch .*d3-canary",
      decision: "allow",
      comment: "D-3 验证：allow 命中应不弹窗且执行",
    },
  ],
};
mkdirSync(DATA, { recursive: true });
writeFileSync(path.join(DATA, "rules.json"), `${JSON.stringify(rules, null, 2)}\n`, "utf8");
writeFileSync(path.join(DATA, "content-policy.json"), `${JSON.stringify({ version: 1, text: "" }, null, 2)}\n`, "utf8");
say("[D-3] 已写入 1 条 allow 规则（d3-allow-echo，匹配 `echo d3-canary-marker`）");

// 投影（让 AGENTS.md 与真源一致，避免 rules-section warn 干扰）
const exp = spawnSync(
  process.execPath,
  [path.join(PLUGIN_ROOT, "src", "rules", "export-agents.mjs"), "--rules", path.join(DATA, "rules.json"), "--agents-md", AGENTS, "--state", path.join(RT, "install-state.json")],
  { encoding: "utf8" },
);
say(`[D-3] export exit=${exp.status}`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = "C:\\Program Files\\ZCode\\resources\\config\\provider\\zcode-builtin.json";
env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
env.ZCODE_LOG_DIR = LOG_DIR;
mkdirSync(LOG_DIR, { recursive: true });

const child = spawn(process.execPath, [CLI, "app-server"], { cwd: REPO, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let buf = "";
let id = 0;
const pending = new Map();
const permissionRequests = [];
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id !== undefined && m.method === undefined) {
      const w = pending.get(m.id);
      if (w) {
        pending.delete(m.id);
        w(m);
      }
      continue;
    }
    if (!m.method) continue;
    const reply = (result) => child.stdin.write(`${JSON.stringify({ id: m.id, result })}\n`);
    if (m.method === "session/requestRuntimePreferences") {
      reply({ nativeSearchEnhancementsEnabled: false, toolSearchMode: "off", memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false });
    } else if (m.method === "interaction/requestPermission") {
      permissionRequests.push({ tool: m.params?.toolName, at: Date.now() });
      say(`  [PERMISSION-REQUEST] 客户端被询问权限（tool=${m.params?.toolName}）→ 故意延迟 8s 后答 deny`);
      setTimeout(() => reply({ decision: "deny", reason: "wp42-d3-client-slow-deny" }), 8000);
    } else if (m.method === "interaction/requestUserInput") {
      setTimeout(() => reply({ answers: [], cancelled: true }), 1000);
    } else if (m.method === "startup/storageState") {
      // 通知
    } else {
      child.stdin.write(`${JSON.stringify({ id: m.id, error: { code: -32601, message: "wp42 stub" } })}\n`);
    }
  }
});
const rpc = (method, params, timeoutMs = 180000) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    child.stdin.write(`${JSON.stringify({ id: mid, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(mid)) {
        pending.delete(mid);
        resolve({ __timeout: true, method });
      }
    }, timeoutMs);
  });

try {
  await rpc("runtime/capabilities", {});
  // **新会话**（D-3 要求新会话）
  const created = await rpc("session/create", { workspace: { workspacePath: REPO, workspaceKey: REPO }, mode: "build" });
  const sessionId = created?.result?.session?.sessionId;
  ok(Boolean(sessionId), "D-3a 新会话创建成功", String(sessionId ?? ""));

  rmSync(CANARY, { recursive: true, force: true });
  mkdirSync(CANARY, { recursive: true });
  // 注意：命令**不能带重定向**（`>`）—— 带重定向会被判为高风险（mode.build.highRisk），
  // approvalMode 变 user-once ⇒ runHooks=false ⇒ hook 被跳过（产品既有语义，非缺陷）。
  // 因此用 `touch` 写 canary 标记文件，不经 shell 重定向。
  const cmd = `touch "${CANARY.replaceAll("\\", "/")}/marker.txt"`;
  const sent = await rpc("session/send", { sessionId, content: `Run exactly this Bash command and report the result: ${cmd}` });
  ok(sent?.result?.accepted === true, "D-3b prompt 已提交", JSON.stringify(sent?.error ?? "").slice(0, 120));

  // 等命令执行（hook allow → 立即执行；hook 不生效 → 客户端 8s 后 deny → 不执行）
  const t0 = Date.now();
  let marker = false;
  while (Date.now() - t0 < 120000) {
    await new Promise((r) => setTimeout(r, 2000));
    if (existsSync(path.join(CANARY, "marker.txt"))) {
      marker = true;
      break;
    }
  }
  ok(marker, "D-3c 命令**实际执行**（canary 文件已生成）", `elapsed=${Math.round((Date.now() - t0) / 1000)}s`);

  // 「不弹窗」的精确判据：目标命令的那次 permission 决策**来自 hook**（reason 含
  // permission.resolved 证据（从本轮日志里找）
  const logFile = readdirSafe(LOG_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(LOG_DIR, f)).sort();
  let resolved = [];
  for (const f of logFile) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.event === "tool.permission.resolved") resolved.push(j);
    }
  }
  const resolvedForSession = resolved.filter((r) => r.sessionId === sessionId);
  say(`  [日志] tool.permission.resolved 命中 ${resolved.length} 条（本会话 ${resolvedForSession.length} 条）`);
  for (const r of resolvedForSession.slice(-3)) {
    say(`    ${JSON.stringify(r.context ?? r).slice(0, 300)}`);
  }
  ok(resolvedForSession.length > 0, "D-3e 存在 permission.resolved 证据（hook 决策被采纳）", `本会话 ${resolvedForSession.length} 条`);

  // "Allowed by PermissionRequest hook"）⇒ 用户没有被询问就放行了。
  // 注意：模型可能在同一 turn 里发起**其它**工具调用，那些询问与目标命令无关，
  // 不能用「客户端全程零询问」当判据（会因模型行为波动而假红）。
  const targetResolved = resolvedForSession.find(
    (r) => r.context?.reason === "Allowed by PermissionRequest hook" && r.context?.decision === "allow",
  );
  ok(Boolean(targetResolved), "D-3d 目标命令的权限决策**来自 hook**（用户未被询问即放行）", targetResolved ? `reason=${targetResolved.context.reason}` : `客户端询问次数=${permissionRequests.length}`);
  const allowHit = resolvedForSession.some((r) => r.context?.decision === "allow");
  ok(allowHit, "D-3f permission.resolved 记录了 allow 决策");
} catch (error) {
  say(`  [ERROR] ${error?.message ?? error}`);
  failed++;
} finally {
  // 恢复空规则（零行为基线）
  const empty = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, "rules.default.json"), "utf8"));
  writeFileSync(path.join(DATA, "rules.json"), `${JSON.stringify(empty, null, 2)}\n`, "utf8");
  writeFileSync(path.join(DATA, "content-policy.json"), `${JSON.stringify({ version: 1, text: "" }, null, 2)}\n`, "utf8");
  spawnSync(process.execPath, [path.join(PLUGIN_ROOT, "src", "rules", "export-agents.mjs"), "--rules", path.join(DATA, "rules.json"), "--agents-md", AGENTS, "--state", path.join(RT, "install-state.json")], { encoding: "utf8" });
  rmSync(CANARY, { recursive: true, force: true });
  child.stdin.end();
  child.kill();
  const out = path.join(RT, "d3-real-session.log");
  writeFileSync(out, lines.join("\n") + "\n", "utf8");
  say(`\n[log] ${out}`);
  say(`[result] ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
