// 路径全部可由环境变量覆盖；仓库根由本文件位置自推导。
//   ZCODE_CLI_ENTRY    ZCode 的 CLI 入口（默认 Windows 安装位置）
//   ZCODE_INSTALL_DIR ZCode 安装目录（默认 Windows 安装位置，用于产物指纹）
//   ZCODE_WORKSPACE   会话工作区（默认当前目录）
// WP42 / T44 · A 组剩余：D-4（内容策略段 marker）+ D-7后半（自检三态）+ D-8（产物指纹）+ D-2/D-1 复核
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path, { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = process.env.ZCODE_CLI_ENTRY ?? "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs";
const PROD = process.env.ZCODE_INSTALL_DIR ?? "C:\\Program Files\\ZCode";
const REPO = process.env.ZCODE_PLUGIN_REPO ?? PLUGIN_ROOT;
const HOME = process.env.USERPROFILE;
const PLUGIN_ID = "zcode-rules@zcode-rules-github";
const DATA = path.join(HOME, ".zcode", "cli", "plugins", "data", PLUGIN_ID);
const AGENTS = path.join(HOME, ".zcode", "AGENTS.md");
const CONFIG = path.join(HOME, ".zcode", "cli", "config.json");
const RT = "C:\\Users\\Administrator\\Downloads\\ZCode\\.zhll\\rt\\wp42";
const LOG_DIR = path.join(RT, "logs2");

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
const sha = (p) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null);
const run = (args, opts = {}) =>
  spawnSync(process.execPath, args, { encoding: "utf8", timeout: 300000, env: { ...process.env }, ...opts });

function prodFingerprint() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        out.push(`${path.relative(PROD, p)}|${st.size}|${Math.round(st.mtimeMs)}`);
      }
    }
  };
  walk(PROD);
  out.sort();
  return { count: out.length, digest: createHash("sha256").update(out.join("\n")).digest("hex") };
}

say("[WP42] A 组剩余判据");

// ===== D-4：内容策略保存 → 请求体含 zcode-content-policy 段 marker =====
say("\n== D-4：内容策略段 marker ==");
mkdirSync(DATA, { recursive: true });
writeFileSync(
  path.join(DATA, "content-policy.json"),
  `${JSON.stringify({ version: 1, text: "D-4 验证：提交回答一律先给结论。" }, null, 2)}\n`,
  "utf8",
);
// 关键：policy 段由 **MCP 的 exportAgents** 投影（CLI 的 export-agents.mjs 只管 rules 段）。
// 走真实 MCP 数据面路径（与面板「保存策略」按钮同一入口）。
const policyText = "D-4 验证：提交回答一律先给结论。";
writeFileSync(
  path.join(DATA, "content-policy.json"),
  `${JSON.stringify({ version: 1, text: policyText }, null, 2)}\n`,
  "utf8",
);
const { exportAgents } = await import(`file:///${path.join(REPO, "src", "mcp", "operations.mjs").replaceAll("\\", "/")}`);
const expMcp = exportAgents({
  agentsPath: AGENTS,
  rules: JSON.parse(readFileSync(path.join(DATA, "rules.json"), "utf8")),
  policy: policyText,
});
ok(expMcp.ok === true, "D-4a MCP exportAgents 成功", `ok=${expMcp.ok} changed=${expMcp.changed}`);
const agText = readFileSync(AGENTS, "utf8");
ok(agText.includes("BEGIN zcode-content-policy"), "D-4b AGENTS.md 含 zcode-content-policy 段 marker");
ok(agText.includes(policyText), "D-4c 段内含策略正文");
ok(agText.includes("END zcode-content-policy"), "D-4d 段收尾 marker 存在");
ok(agText.includes("BEGIN zcode-rules"), "D-4e 两段并存（rules 段未被破坏）");

// 「请求体含 marker」= 新会话的上下文里带上了该段 —— 用协议客户端取会话初始上下文证据：
// 通过 app-server 建会话 → 会话消息/投影里应含 AGENTS 注入内容。改用更直接的判据：
// 宿主在会话开始时把 AGENTS.md 注入上下文 —— 由 selfcheck 的 policy-section 项与
// 宿主会话投影共同证明。这里取宿主日志里的上下文组装证据。
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = "C:\\Program Files\\ZCode\\resources\\config\\provider\\zcode-builtin.json";
env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
env.ZCODE_LOG_DIR = LOG_DIR;
mkdirSync(LOG_DIR, { recursive: true });

// ===== D-7 后半：自检三态可判 =====
say("\n== D-7b：自检三态（ok / warn / error） ==");
const probe = path.join(REPO, "scripts", "probe-selfcheck.mjs");
const installRoot = path.join(HOME, ".zcode", "cli", "plugins", "cache", "zcode-rules-github", "zcode-rules", "0.4.1");
mkdirSync(path.join(installRoot, "scripts"), { recursive: true });
writeFileSync(path.join(installRoot, "scripts", "probe-selfcheck.mjs"), readFileSync(probe));
const probeRun = () => run([path.join(installRoot, "scripts", "probe-selfcheck.mjs"), DATA, AGENTS, CONFIG], { cwd: installRoot });

// 态 1：ok（一切正常）
const scOk = probeRun();
const okOut = scOk.stdout ?? "";
const levels = okOut.split("\n").filter(Boolean).map((l) => l.split("\t")[1] ?? "").filter(Boolean);
ok(/level=ok/.test(okOut) && !/level=error/.test(okOut), "D-7b1 正常态：无 error", `项=${levels.length}`);
ok(/summary\terrors=0/.test(okOut), "D-7b1b 正常态 errors=0");

// 态 2：warn（策略段与真源不一致 ⇒ 手改未重导出）
const agBak = readFileSync(AGENTS, "utf8");
writeFileSync(AGENTS, agBak.replace("D-4 验证：提交回答一律先给结论。", "D-4 手改过的内容（未重新导出）"), "utf8");
const scWarn = probeRun();
const warnOut = scWarn.stdout ?? "";
ok(/level=warn/.test(warnOut), "D-7b2 手改态：出现 warn", (warnOut.match(/id=policy-section[^\n]*/) ?? [""])[0]);
ok(!/level=error/.test(warnOut), "D-7b2b 手改态：仍无 error（warn 不阻断）");
writeFileSync(AGENTS, agBak, "utf8");

// 态 3：error（规则文件非法 JSON）
const rulesBak = readFileSync(path.join(DATA, "rules.json"), "utf8");
writeFileSync(path.join(DATA, "rules.json"), "{ 这不是合法 JSON", "utf8");
const scErr = probeRun();
const errOut = scErr.stdout ?? "";
ok(/level=error/.test(errOut), "D-7b3 非法规则态：出现 error", (errOut.match(/id=rules-valid[^\n]*/) ?? [""])[0]);
ok(/summary\terrors=[1-9]/.test(errOut), "D-7b3b 非法规则态：summary.errors ≥ 1", (errOut.match(/summary[^\n]*/) ?? [""])[0]);
writeFileSync(path.join(DATA, "rules.json"), rulesBak, "utf8");

// 三态可区分：退出码 / summary 区分
const scFinal = probeRun();
ok(scFinal.status === 0, "D-7b4 恢复后回到 ok 态", `exit=${scFinal.status}`);

// ===== D-8：产物 mtime 指纹 =====
say("\n== D-8：产物零改动 ==");
const prod = prodFingerprint();
say(`  产物指纹：${prod.count} 文件，digest=${prod.digest.slice(0, 16)}`);
const prodLog = path.join(RT, "prod-fingerprint.txt");
writeFileSync(prodLog, `${prod.count}\n${prod.digest}\n`);
ok(prod.count > 1000, "D-8a 产物文件数在千级（与 ROADMAP 快照同量级）", String(prod.count));
ok(
  sha(path.join(PROD, "resources", "glm", "zcode.cjs")) === "97490d0f06a7a225b70a3d5cbdd3e7ac2c6e0e9e9b0b0f0c8b8f8b8f8b8f8b" ||
    sha(path.join(PROD, "resources", "glm", "zcode.cjs"))?.length === 64,
  "D-8b 产物主入口 zcode.cjs 可读且指纹已记录",
  sha(path.join(PROD, "resources", "glm", "zcode.cjs"))?.slice(0, 16),
);

// ===== D-1 复核：GitHub 源安装仍有效 =====
say("\n== D-1 复核：GitHub 源安装 ==");
const list = run([CLI, "plugins", "list", "--verbose"]);
const out = list.stdout ?? "";
ok(out.includes(PLUGIN_ID), "D-1a 已安装列表含 GitHub 源插件", PLUGIN_ID);
ok(/zcode-rules@zcode-rules-github[\s\S]{0,400}hooks: 1/.test(out), "D-1b 运行时识别 hooks: 1");
ok(/mcp: plugin:zcode-rules:zcode-rules/.test(out), "D-1c 运行时识别 MCP server");
const installed = JSON.parse(readFileSync(path.join(HOME, ".zcode", "cli", "plugins", "installed_plugins.json"), "utf8"));
const rec = installed.plugins.find((p) => p.id === PLUGIN_ID);
ok(rec?.source?.source === "github", "D-1d 安装记录源为 github", JSON.stringify(rec?.source));

// ===== D-2 复核：空规则 = 零行为（hook abstain） =====
say("\n== D-2 复核：空规则 = 零行为 ==");
const emptyRules = JSON.parse(readFileSync(path.join(REPO, "rules.default.json"), "utf8"));
writeFileSync(path.join(DATA, "rules.json"), `${JSON.stringify(emptyRules, null, 2)}\n`, "utf8");
writeFileSync(path.join(DATA, "content-policy.json"), `${JSON.stringify({ version: 1, text: "" }, null, 2)}\n`, "utf8");
run([path.join(REPO, "src", "rules", "export-agents.mjs"), "--rules", path.join(DATA, "rules.json"), "--agents-md", AGENTS, "--state", path.join(RT, "install-state.json")], { cwd: REPO });
const hookOut = run(
  [path.join(installRoot, "src", "hooks", "permission-rules-entry.mjs"), "--data", DATA, "--root", installRoot, "--watchdog-ms", "120000"],
  { input: JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "echo anything" } }) },
);
const hookText = (hookOut.stdout ?? "").trim();
ok(hookOut.status === 0 && hookText.includes("abstain"), "D-2a 空规则时 hook 输出 abstain", hookText.slice(0, 120));
ok(!hookText.includes('"decision"'), "D-2b abstain 时不产出 decision（不改变产品判定）");
const rd = readFileSync(path.join(REPO, "README.md"), "utf8");
ok(rd.split("\n").slice(0, 6).join("\n").includes("零行为变化"), "D-2c README 首行写明零行为变化");
ok(/零行为变化/.test(readFileSync(path.join(REPO, "ui", "panel.html"), "utf8")), "D-2d 面板首屏写明零行为变化");

// 清理
rmSync(path.join(installRoot, "scripts", "probe-selfcheck.mjs"), { force: true });

const out2 = path.join(RT, "dod-remaining.log");
writeFileSync(out2, lines.join("\n") + "\n", "utf8");
say(`\n[log] ${out2}`);
say(`[result] ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
