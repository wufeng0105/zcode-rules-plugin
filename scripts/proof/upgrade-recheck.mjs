#!/usr/bin/env node
// ZCode 本体升级后的插件复查（v0.4.3 起随仓附带）。
//
// 为什么需要它：插件依赖 ZCode 的四个契约面——插件注册（hooks/mcp 声明）、hook 事件调用、
// MCP stdio 握手、userConfig 注入（${user_config.*}）。产品升级后这四处任何一处变了，
// 插件都会"看起来还在、其实不工作"。这个脚本按依赖顺序逐层验，一层不过就停在那层。
//
// 它验什么（与文档 docs/QUICKSTART.md「升级 ZCode 本体之后」一一对应）：
//   1. 注册面：installed_plugins.json 有记录 + enabledPlugins 开 + 缓存目录在
//   2. 产品识别面：`plugins list --verbose` 本插件行含 hooks: N + mcp: plugin:<id>；`plugins validate` 通过
//   3. 数据面：数据目录两个真源文件存在；AGENTS.md 存在且两个哨兵段符合当前投影模式
//   4. hook 面：直接用装后缓存里的 hook 入口跑 allow / deny / abstain 三个样本
//   5. MCP 面：用装后缓存的 server 走真实 JSON-RPC（initialize / tools/list / rules_read /
//      selfcheck_run / export_agents 幂等），并按 config.json 的 plugins.options 注入 projectRules
//
// 不验什么：真实会话里 hook 是否被**产品**调用。那需要一次模型调用，见文档里的人工步骤。
//
// 用法：
//   node scripts/proof/upgrade-recheck.mjs
//   env 覆盖：ZCODE_REAL_HOME（默认 C:\Users\Administrator）、ZCODE_PLUGIN_ID（默认 zcode-rules@zcode-rules-plugin）、
//             ZCODE_CLI_ENTRY（默认 Windows 安装位置）
// 退出码：0 全过 / 1 有失败项 / 2 环境不可用（找不到安装记录或插件文件）
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.ZCODE_REAL_HOME || "C:\\Users\\Administrator";
const PLUGIN_ID = process.env.ZCODE_PLUGIN_ID || "zcode-rules@zcode-rules-plugin";
const CLI = process.env.ZCODE_CLI_ENTRY || "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs";
const Z = join(HOME, ".zcode");
const INSTALLED = join(Z, "cli", "plugins", "installed_plugins.json");
const CONFIG = join(Z, "cli", "config.json");
const AGENTS = join(Z, "AGENTS.md");

const results = [];
function check(cond, label, detail = "") {
  results.push({ ok: Boolean(cond), label, detail });
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${detail ? " · " + detail : ""}`);
}

const readJson = (p) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  } catch {
    return null;
  }
};

// ---------- 0) 环境 ----------
if (!existsSync(INSTALLED)) {
  console.error(`环境不可用：找不到 ${INSTALLED}`);
  process.exit(2);
}
const installed = readJson(INSTALLED);
const record = (installed?.plugins ?? []).find((p) => p.id === PLUGIN_ID);
if (!record) {
  console.error(`环境不可用：installed_plugins.json 里没有 ${PLUGIN_ID}`);
  process.exit(2);
}
const installPath = record.installPath;
const dataDir = join(Z, "cli", "plugins", "data", PLUGIN_ID);
const serverPath = join(installPath, "src", "mcp", "server.mjs");
const hookPath = join(installPath, "src", "hooks", "permission-rules-entry.mjs");
if (!existsSync(serverPath) || !existsSync(hookPath)) {
  console.error(`环境不可用：安装目录缺少 server/hook 入口（${installPath}）`);
  process.exit(2);
}
console.log(`[env] HOME=${HOME}\n[env] plugin=${PLUGIN_ID} version=${record.version}\n[env] installPath=${installPath}\n[env] CLI=${CLI}`);

// ---------- 1) 注册面 ----------
const config = readJson(CONFIG) ?? {};
const enabled = config.plugins?.enabledPlugins?.[PLUGIN_ID] === true;
const optionValues = config.plugins?.options?.[PLUGIN_ID] ?? {};
check(record.version !== undefined, "注册：installed 有记录", `version=${record.version}`);
check(enabled, "注册：enabledPlugins 为 true");
check(existsSync(join(installPath, ".zcode-plugin", "plugin.json")), "注册：缓存目录含 manifest");

// ---------- 2) 产品识别面 ----------
const runCli = (args) => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 180000, windowsHide: true });
};
if (existsSync(CLI)) {
  const list = runCli(["plugins", "list", "--verbose"]);
  const lines = `${list.stdout ?? ""}`.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trimStart().startsWith(`- ${PLUGIN_ID} `));
  const block = at >= 0 ? lines.slice(at, at + 3).join("\n") : "";
  check(at >= 0, "产品识别：plugins list 里有本插件", at >= 0 ? "" : `exit=${list.status}`);
  check(/hooks:\s*[1-9]\d*/.test(block), "产品识别：该插件声明了 hook", block.match(/hooks:\s*\d+/)?.[0] ?? "");
  check(/mcp:\s*plugin:/.test(block), "产品识别：该插件挂了 MCP server", block.match(/mcp:\s*[^,\s]+/)?.[0] ?? "");
  const validate = runCli(["plugins", "validate", installPath]);
  check(/Plugin manifest is valid/.test(`${validate.stdout}${validate.stderr}`), "产品识别：manifest 仍通过校验", `exit=${validate.status}`);
} else {
  check(false, "产品识别：CLI 入口存在", CLI);
}

// ---------- 3) 数据面 ----------
const rulesPath = join(dataDir, "rules.json");
const policyPath = join(dataDir, "content-policy.json");
check(existsSync(rulesPath), "数据面：rules.json 存在");
check(existsSync(policyPath), "数据面：content-policy.json 存在");
check(existsSync(AGENTS), "数据面：AGENTS.md 存在");
const agentsText = existsSync(AGENTS) ? readFileSync(AGENTS, "utf8") : "";
const projectRules = optionValues.projectRules;
const wantRulesSection = projectRules === undefined ? true : projectRules !== false;
check(
  agentsText.includes("<!-- BEGIN zcode-content-policy") === true,
  "数据面：AGENTS.md 有内容策略段",
);
check(
  agentsText.includes("<!-- BEGIN zcode-rules") === wantRulesSection,
  `数据面：规则段与投影模式一致（projectRules=${String(projectRules ?? "未配置→true")}）`,
);

// ---------- 4) hook 面（直接调用装后入口） ----------
const HOOK_CASES = [
  ["git status --short", "allow"],
  ["rm -rf /tmp/upgrade-recheck", "deny"],
  ["npm --version", null],
];
for (const [command, expected] of HOOK_CASES) {
  const payload = JSON.stringify({ hookEventName: "PermissionRequest", toolName: "Bash", toolInput: { command } });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(process.execPath, [hookPath, "--data", dataDir, "--root", installPath, "--watchdog-ms", "5000"], {
    encoding: "utf8",
    env,
    input: payload,
    timeout: 30000,
    windowsHide: true,
  });
  let behavior = null;
  try {
    behavior = JSON.parse((run.stdout ?? "").trim())?.hookSpecificOutput?.decision?.behavior ?? null;
  } catch {
    behavior = null;
  }
  const pass = expected === null ? run.status === 0 && behavior === null : run.status === 0 && behavior === expected;
  check(pass, `hook：${command} → ${expected ?? "abstain"}`, `behavior=${behavior ?? "<abstain>"} exit=${run.status}`);
}

// ---------- 5) MCP 面（装后 server 的真实 JSON-RPC） ----------
function startSession(env) {
  const proc = spawn(process.execPath, [serverPath], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buffer = "";
  let stderrText = "";
  let seq = 0;
  const pending = new Map();
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c) => (stderrText += c));
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const deliver = pending.get(msg.id);
      if (deliver) {
        pending.delete(msg.id);
        deliver(msg);
      }
    }
  });
  return {
    request(method, params, timeoutMs = 15000) {
      const id = ++seq;
      proc.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout ${method}; stderr=${stderrText.slice(-200)}`));
        }, timeoutMs);
        pending.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
    },
    close() {
      try {
        proc.stdin.end();
      } catch {
        /* ignore */
      }
      proc.kill();
    },
  };
}

const envForServer = {
  ZCODE_RULES_DATA: dataDir,
  ZCODE_RULES_ROOT: installPath,
  ...(projectRules === undefined ? {} : { ZCODE_RULES_PROJECT_RULES: String(projectRules) }),
};
const session = startSession(envForServer);
try {
  const init = await session.request("initialize", { capabilities: {}, clientInfo: { name: "upgrade-recheck", version: "1" }, protocolVersion: "2024-11-05" });
  check(init?.result?.serverInfo?.name === "zcode-rules", "MCP：initialize 握手", `version=${init?.result?.serverInfo?.version}`);
  const tools = await session.request("tools/list", {});
  const names = (tools?.result?.tools ?? []).map((t) => t.name);
  check(names.length === 6, "MCP：6 个工具齐全", names.join(","));
  const rules = JSON.parse((await session.request("tools/call", { arguments: {}, name: "rules_read" })).result.content[0].text);
  check(rules.ok === true, "MCP：rules_read", `exists=${rules.exists} rules=${rules.rules?.rules?.length ?? 0}`);
  const sc = JSON.parse(
    (await session.request("tools/call", { arguments: { agentsPath: AGENTS, configPath: CONFIG }, name: "selfcheck_run" })).result.content[0].text,
  );
  check(sc.ok === true && sc.summary?.errors === 0, "MCP：selfcheck 无 error", `warnings=${sc.summary?.warnings} rulesCount=${sc.summary?.rulesCount}`);
  const before = readFileSync(AGENTS, "utf8");
  const exp = JSON.parse((await session.request("tools/call", { arguments: { agentsPath: AGENTS }, name: "export_agents" })).result.content[0].text);
  check(exp.ok === true && exp.changed === false && readFileSync(AGENTS, "utf8") === before, "MCP：export_agents 幂等（AGENTS.md 未变）", `actions=${JSON.stringify(exp.actions)}`);
} catch (error) {
  check(false, "MCP：往返异常", String(error?.message ?? error).slice(0, 160));
} finally {
  session.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n[result] ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}（${results.length} 项）`);
console.log("[note] 真实会话里 hook 是否被产品调用，需要一次模型调用：开新会话发一条会被询问的命令（如 `touch check.tmp`），再看日志 tool.permission.resolved 的 reason 是否为 `Allowed by PermissionRequest hook`。");
process.exit(failed === 0 ? 0 : 1);

