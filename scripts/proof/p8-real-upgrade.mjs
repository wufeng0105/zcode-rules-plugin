// 路径全部可由环境变量覆盖；仓库根由本文件位置自推导。
//   ZCODE_CLI_ENTRY    ZCode 的 CLI 入口（默认 Windows 安装位置）
//   ZCODE_INSTALL_DIR ZCode 安装目录（默认 Windows 安装位置，用于产物指纹）
//   ZCODE_WORKSPACE   会话工作区（默认当前目录）
// WP42 / T44 · B 组：P-8 真实升级闭环（v0.4.0 → v0.4.1，真实 home）
//
// 判据要点：
//   · 升级 = 同 id 直接 `plugins install`（**不先 uninstall**，那会删真源）
//   · 升级前先写真源（1 条规则 + 非空策略），升级后证**字节不变**（真源保留）
//   · 升级后重投影**幂等**（AGENTS.md sha 不变、changed=false）
//   · 升级后自检含新项 `data-dir`、version=v0.4.1、无 error
//   · 升级前后 `C:\Program Files\ZCode` 产物指纹一致（零产物改动）
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path, { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = process.env.ZCODE_CLI_ENTRY ?? "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs";
const PROD = process.env.ZCODE_INSTALL_DIR ?? "C:\\Program Files\\ZCode";
const HOME = process.env.USERPROFILE;
const PLUGIN_ID = "zcode-rules@zcode-rules-github";
const DATA = path.join(HOME, ".zcode", "cli", "plugins", "data", PLUGIN_ID);
const AGENTS = path.join(HOME, ".zcode", "AGENTS.md");
const CONFIG = path.join(HOME, ".zcode", "cli", "config.json");
const { exportAgents } = await import(`file:///${path.join(PLUGIN_ROOT, "src", "mcp", "operations.mjs").replaceAll("\\", "/")}`);
// 证据与临时产物的落盘目录：默认在仓库根的 .proof-runs 下（可由 ZCODE_PROOF_OUT 覆盖）
const RT = process.env.ZCODE_PROOF_OUT ?? path.join(PLUGIN_ROOT, ".proof-runs", "p8-real-upgrade");

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
const bytes = (p) => (existsSync(p) ? readFileSync(p).length : -1);

const run = (args, opts = {}) =>
  spawnSync(process.execPath, args, { encoding: "utf8", timeout: 300000, env: { ...process.env }, ...opts });

/** 产物指纹：递归文件路径 + size + mtimeMs（1410 文件量级） */
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

say(`[P-8 真实升级] ${PLUGIN_ID}  v0.4.0 → v0.4.1`);

// ===== 步骤 0：升级前基线 =====
say("\n== 步骤 0：升级前基线 ==");
const prodBefore = prodFingerprint();
say(`  产物指纹：${prodBefore.count} 文件，digest=${prodBefore.digest.slice(0, 16)}`);
const installed0 = JSON.parse(readFileSync(path.join(HOME, ".zcode", "cli", "plugins", "installed_plugins.json"), "utf8"));
const rec0 = installed0.plugins.find((p) => p.id === PLUGIN_ID);
say(`  已装版本：${rec0?.version}`);
ok(rec0?.version === "0.4.0", "升级前版本是 0.4.0", rec0?.version);

// 写真源（1 条规则 + 非空策略）—— 升级后必须**字节不变**
mkdirSync(DATA, { recursive: true });
const testRule = {
  version: 1,
  name: "P-8 真实升级验证",
  description: "升级前写入，升级后应字节不变",
  unmatched: "abstain",
  onTimeout: "deny",
  watchdogMs: 120000,
  rules: [{ id: "p8-real-upgrade-allow", tool: "Bash", commandPattern: "^echo p8-real-upgrade$", decision: "allow" }],
};
writeFileSync(path.join(DATA, "rules.json"), `${JSON.stringify(testRule, null, 2)}\n`, "utf8");
writeFileSync(path.join(DATA, "content-policy.json"), `${JSON.stringify({ version: 1, text: "P-8 真实升级验证策略" }, null, 2)}\n`, "utf8");
const rulesSha0 = sha(path.join(DATA, "rules.json"));
const policySha0 = sha(path.join(DATA, "content-policy.json"));
say(`  写入真源：rules sha=${rulesSha0.slice(0, 12)} · policy sha=${policySha0.slice(0, 12)}`);

// 投影到 AGENTS.md（升级前的基线投影）
const repoRoot = process.env.ZCODE_PLUGIN_REPO ?? PLUGIN_ROOT;
const exp = run([path.join(repoRoot, "src", "rules", "export-agents.mjs"), "--rules", path.join(DATA, "rules.json"), "--agents-md", AGENTS, "--state", path.join(RT, "install-state.json")], { cwd: repoRoot });
// policy 段由 MCP exportAgents 管：CLI 脚本只管 rules 段，必须补这一支才能清掉策略正文
exportAgents({ agentsPath: AGENTS, rules: JSON.parse(readFileSync(path.join(DATA, "rules.json"), "utf8")), policy: "" });
ok(exp.status === 0, "升级前投影成功", `exit=${exp.status}`);
const agentsSha0 = sha(AGENTS);
const agentsBytes0 = bytes(AGENTS);
say(`  AGENTS.md ${agentsBytes0}B sha=${agentsSha0.slice(0, 12)}`);

// 升级前自检基线（v0.4.0 应有 8 项，无 data-dir）
// 探针跑**安装目录**里的代码（而不是仓库工作树），才能对比升级前后的实际安装态。
const installedRoot0 = path.join(HOME, ".zcode", "cli", "plugins", "cache", "zcode-rules-github", "zcode-rules", "0.4.0");
const installedRoot1 = path.join(HOME, ".zcode", "cli", "plugins", "cache", "zcode-rules-github", "zcode-rules", "0.4.1");
const probeScript = path.join(repoRoot, "scripts", "probe-selfcheck.mjs");
// 探针是仓库工具、不随插件发布 —— 临时复制进安装目录（跑完即弃）。
const installProbe = (root) => {
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "probe-selfcheck.mjs"), readFileSync(probeScript));
};
installProbe(installedRoot0);
const sc0 = run([path.join(installedRoot0, "scripts", "probe-selfcheck.mjs"), DATA, AGENTS, CONFIG], { cwd: installedRoot0 });
say(`  升级前自检项：${(sc0.stdout ?? "").trim().split("\n").filter(Boolean).map((l) => l.split("\t")[1]).join(", ")}`);

// ===== 步骤 1：真实升级（同 id 直接 install，不先 uninstall） =====
say("\n== 步骤 1：同 id 直接 install（原地升级） ==");
// 真实机制：市场清单里的 `source.ref` 锁定了版本 —— 上游发新 tag 后，
// **必须先更新市场清单的 ref/version**，否则 install 装到的还是旧版本。
// 这不是本插件的问题，是「目录/GitHub 源市场」的工作方式，必须写进用户文档。
const MKT = path.join(HOME, ".zcode", "cli", "plugins", "marketplaces", "zcode-rules-github", "marketplace.json");
const mktBefore = readFileSync(MKT, "utf8");
say(`  市场清单 ref：${(mktBefore.match(/"ref":\s*"([^"]+)"/) ?? [])[1]} → v0.4.1`);
writeFileSync(MKT, mktBefore.split('"ref": "v0.4.0"').join('"ref": "v0.4.1"').split('"version": "0.4.0"').join('"version": "0.4.1"'), "utf8");
const up = run([CLI, "plugins", "install", PLUGIN_ID]);
say(`  install exit=${up.status} ${(up.stdout ?? "").trim().split("\n").slice(-1)[0]}`);
ok(up.status === 0, "升级命令成功");

// ===== 步骤 2：升级后状态 =====
say("\n== 步骤 2：升级后状态 ==");
const installed1 = JSON.parse(readFileSync(path.join(HOME, ".zcode", "cli", "plugins", "installed_plugins.json"), "utf8"));
const rec1 = installed1.plugins.find((p) => p.id === PLUGIN_ID);
say(`  已装版本：${rec1?.version} · installPath=${rec1?.installPath?.split("\\").slice(-2).join("\\")}`);
ok(rec1?.version === "0.4.1", "C-B3a 版本已升到 0.4.1", rec1?.version);
ok(rec1?.id === PLUGIN_ID, "插件 id 未变（原地升级）", rec1?.id);

// 真源字节不变
const rulesSha1 = sha(path.join(DATA, "rules.json"));
const policySha1 = sha(path.join(DATA, "content-policy.json"));
say(`  真源：rules ${rulesSha0.slice(0, 12)} → ${rulesSha1.slice(0, 12)} · policy ${policySha0.slice(0, 12)} → ${policySha1.slice(0, 12)}`);
ok(rulesSha1 === rulesSha0, "C-B3b rules.json 字节不变（真源保留）");
ok(policySha1 === policySha0, "C-B3c content-policy.json 字节不变（真源保留）");

// ===== 步骤 3：投影幂等 =====
say("\n== 步骤 3：升级后重投影应幂等 ==");
const exp2 = run([path.join(repoRoot, "src", "rules", "export-agents.mjs"), "--rules", path.join(DATA, "rules.json"), "--agents-md", AGENTS, "--state", path.join(RT, "install-state.json")], { cwd: repoRoot });
exportAgents({ agentsPath: AGENTS, rules: JSON.parse(readFileSync(path.join(DATA, "rules.json"), "utf8")), policy: "" });
say(`  export exit=${exp2.status} · 输出：${(exp2.stdout ?? "").trim().split("\n").filter(Boolean).slice(-1)[0]}`);
const agentsSha1 = sha(AGENTS);
ok(agentsSha1 === agentsSha0, "C-B4 AGENTS.md 投影 sha 不变（幂等）", `${agentsSha0.slice(0, 10)} → ${agentsSha1.slice(0, 10)}`);

// ===== 步骤 4：升级后自检（含新项 data-dir + version=v0.4.1） =====
say("\n== 步骤 4：升级后自检 ==");
installProbe(installedRoot1);
const sc1 = run([path.join(installedRoot1, "scripts", "probe-selfcheck.mjs"), DATA, AGENTS, CONFIG], { cwd: installedRoot1 });
const scOut = (sc1.stdout ?? "").trim();
say(`  ${scOut.split("\n").slice(0, 14).join("\n  ")}`);
ok(scOut.includes("data-dir"), "C-B5a 自检含新项 data-dir（v0.4.1 新能力生效）");
ok(/版本一致：v0\.4\.1/.test(scOut), "C-B5b version 项显示 v0.4.1");
ok(!/level=error|\berror\b/.test(scOut), "C-B5c 自检无 error");

// ===== 步骤 5：产物指纹一致 =====
say("\n== 步骤 5：产物零改动 ==");
const prodAfter = prodFingerprint();
say(`  产物指纹：${prodAfter.count} 文件，digest=${prodAfter.digest.slice(0, 16)}`);
ok(prodAfter.count === prodBefore.count, "C-B6a 产物文件数不变", `${prodBefore.count} → ${prodAfter.count}`);
ok(prodAfter.digest === prodBefore.digest, "C-B6b 产物指纹完全一致（size+mtime 逐文件）");

// ===== 步骤 6：新装插件的 hook 入口仍可用 =====
say("\n== 步骤 6：升级后 hook 入口 ==");
const root = path.join(HOME, ".zcode", "cli", "plugins", "cache", "zcode-rules-github", "zcode-rules", "0.4.1");
const payload = JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "echo p8-real-upgrade" }, cwd: HOME });
const hook = spawnSync(process.execPath, [path.join(root, "src", "hooks", "permission-rules-entry.mjs"), "--data", DATA, "--root", root, "--watchdog-ms", "120000"], { input: payload, encoding: "utf8", timeout: 60000 });
const hookOut = (hook.stdout ?? "").trim();
say(`  hook 输出：${hookOut}`);
ok(hook.status === 0, "C-B7a hook 入口 exit 0");
ok(hookOut.includes("PermissionRequest"), "C-B7b hook 输出合法（PermissionRequest 形状）");

// ===== 清理：恢复空规则（零行为基线） =====
say("\n== 清理：恢复空规则 ==");
const emptyRules = JSON.parse(readFileSync(path.join(repoRoot, "rules.default.json"), "utf8"));
writeFileSync(path.join(DATA, "rules.json"), `${JSON.stringify(emptyRules, null, 2)}\n`, "utf8");
writeFileSync(path.join(DATA, "content-policy.json"), `${JSON.stringify({ version: 1, text: "" }, null, 2)}\n`, "utf8");
run([path.join(repoRoot, "src", "rules", "export-agents.mjs"), "--rules", path.join(DATA, "rules.json"), "--agents-md", AGENTS, "--state", path.join(RT, "install-state.json")], { cwd: repoRoot });
exportAgents({ agentsPath: AGENTS, rules: JSON.parse(readFileSync(path.join(DATA, "rules.json"), "utf8")), policy: "" });
say(`  恢复后 rules 条数=${JSON.parse(readFileSync(path.join(DATA, "rules.json"), "utf8")).rules.length}`);
for (const r of [installedRoot0, installedRoot1]) {
  rmSync(path.join(r, "scripts", "probe-selfcheck.mjs"), { force: true });
}
say("  已移除安装目录里的临时探针（安装态不留痕）");

const out = path.join(RT, "p8-real-upgrade.log");
mkdirSync(RT, { recursive: true });
writeFileSync(out, lines.join("\n") + "\n", "utf8");
say(`\n[log] ${out}`);
say(`[result] ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
