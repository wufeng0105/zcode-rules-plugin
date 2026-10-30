#!/usr/bin/env node
// P-8 升级模拟（隔离环境）：装 v0.3.0 → 写 1 条规则 + 非空内容策略 → 换 version 重装 →
// 断言「真源保留、投影幂等、身份不变」→ 卸载清理。
//
// ★ 只能在隔离 home 里跑。请用 ZCode 检出的指纹包壳启动（真实 home 零触碰 + 前后快照对账）：
//   node docs/zcode-mod/isolation/tools/run-with-fingerprint.mjs --label wp33-upgrade \
//     -- node scripts/smoke-upgrade.mjs --proof-log .zhll/rt/wp33/upgrade-proof.log
//   本脚本自带独立安全门：HOME 必须已重定向到 `.zhll/rt/iso-runs/**` 且不等于真实 home，
//   否则 exit 2 拒绝实验（与 .zhll/rt/wp25/verify-smoke-driver.mjs 的门同一口径）。
//
// 为什么「换 version」要改**源副本**而不是缓存里的 manifest（实测，见 # input 段）：
//   ZCode 的 `plugins install` 每次都从市场条目 `source.path` 指向的目录**重新复制**，
//   安装版本用 `iXs()` 读**源**清单的 version。所以：
//     · 改缓存 `cache/<m>/zcode-rules/0.3.0/.zcode-plugin/plugin.json` → 下一次 install 读到
//       的仍是源清单 0.3.0，版本不变（本脚本把这一步当**对照观测**，不当作升级）；
//     · 正确做法：把仓库复制到隔离目录（排除 .git），改副本清单 version → 市场条目指向副本 →
//       `plugins marketplace update` → `plugins install`。全程不碰仓库、不碰 ZCode 检出。
//
// 断言（任一失败 exit 1）：
//   · 升级确实发生：记录 version 0.3.0 → 0.3.1，installPath 含 0.3.1（防「什么都没变」的恒真）
//   · 真源保留：data/rules.json 与 content-policy.json 字节与 sha256 不变
//   · 数据面可读：升级后用插件自己的 loadRules/loadPolicy 读回，仍是那 1 条规则与非空策略
//   · 投影幂等：升级后重新 exportAgents，AGENTS.md 字节不变（changed=false，sha 相同）
//   · 身份不变：插件 id 不变、enabledPlugins[id] 仍为 true
//   · 卸载清理：installed 无记录、cache 无插件文件、enabledPlugins 键清除、data 目录移除，
//                且用户 AGENTS.md 未被卸载动过（产品不还原，也不删除）
//
// 用法：
//   node scripts/smoke-upgrade.mjs [--proof-log <文件>] [--label <名>] [--keep]
//     --proof-log  额外落一份五段头证据日志（默认只打 stdout）
//     --keep       跑完不删除隔离目录（排查用；默认保留隔离 home 供包壳快照，不额外清理）
//   env: ZCODE_CLI_ENTRY（默认 C:\Program Files\ZCode\resources\glm\zcode.cjs）
//        ZCODE_REAL_HOME（默认 C:\Users\Administrator；用于安全门比对）
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exportAgents,
  loadPolicy,
  loadRules,
  resolveDataPaths,
  savePolicy,
  saveRules,
} from "../src/mcp/operations.mjs";

const HERE = resolve(fileURLToPath(import.meta.url), "..", "..");
const REPO_PLUGIN = HERE;
const CLI = process.env.ZCODE_CLI_ENTRY || "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs";
const REAL_HOME = process.env.ZCODE_REAL_HOME || "C:\\Users\\Administrator";
const MARKET = "wp33-upgrade-market";
const PLUGIN_NAME = "zcode-rules";
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKET}`;
const ISO_SEGMENT = join(".zhll", "rt", "iso-runs");

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const PROOF_LOG = argValue("--proof-log");
const LABEL = argValue("--label") || "wp33-upgrade";
const KEEP = process.argv.includes("--keep");
const STAMP = new Date().toISOString();

// ---------------------------------------------------------------- 安全门
const isoHome = process.env.HOME || "";
const isoRoot = isoHome ? resolve(isoHome, "..") : "";
const dataBaseDir = process.env.ZCODE_DATA_BASE_DIR || "";
const logDir = process.env.ZCODE_LOG_DIR || "";

function refuse(detail) {
  process.stderr.write(`SAFETY: ${detail}；拒绝在本机跑 P-8 升级模拟（exit 2）\n`);
  process.exit(2);
}
if (!isoHome) refuse("HOME 未设置（必须由 isolation/RECIPE.md 的隔离配方重定向）");
if (resolve(isoHome).toLowerCase() === resolve(REAL_HOME).toLowerCase()) refuse(`HOME 指向真实 home（${isoHome}）`);
if (!isoHome.toLowerCase().includes(ISO_SEGMENT.toLowerCase())) {
  refuse(`HOME 不在 .zhll\\rt\\iso-runs 下（HOME=${isoHome}）`);
}
if (!dataBaseDir) refuse("ZCODE_DATA_BASE_DIR 未设置（隔离配方缺项）");
for (const dir of [isoHome, dataBaseDir, logDir].filter(Boolean)) {
  if (!resolve(dir).toLowerCase().startsWith(`${isoRoot.toLowerCase()}\\`)) {
    refuse(`拒绝清理 ${dir}（不在隔离根 ${isoRoot} 下）`);
  }
}
if (!existsSync(CLI)) refuse(`ZCode CLI 入口不存在：${CLI}`);
if (!existsSync(join(REPO_PLUGIN, ".zcode-plugin", "plugin.json"))) {
  refuse(`插件清单不存在：${REPO_PLUGIN}`);
}

// 复位隔离目录（保留包壳写在 isoRoot 下的指纹文件）
for (const dir of [isoHome, dataBaseDir, logDir].filter(Boolean)) {
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------- 夹具/路径
const fixtures = join(isoRoot, "fixtures");
const marketDir = join(fixtures, "market");
const upgradeSource = join(isoRoot, "src-0.3.1");
const cliDir = join(isoHome, ".zcode", "cli");
const installedPath = join(cliDir, "plugins", "installed_plugins.json");
const configPath = join(cliDir, "config.json");
const cacheRoot = join(cliDir, "plugins", "cache", MARKET, PLUGIN_NAME);
const agentsPath = join(isoHome, ".zcode", "AGENTS.md");
const dataPaths = resolveDataPaths(join(cliDir, "plugins", "data", PLUGIN_ID));

const sha256 = (filePath) =>
  existsSync(filePath) ? createHash("sha256").update(readFileSync(filePath)).digest("hex") : null;
const readText = (filePath) => (existsSync(filePath) ? readFileSync(filePath, "utf8") : null);
const readJson = (filePath) => {
  try {
    return existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) : null;
  } catch {
    return null;
  }
};
function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return n;
}
function snapshot(tag) {
  const record = (readJson(installedPath)?.plugins ?? []).find((p) => p.id === PLUGIN_ID) ?? null;
  const enabled = readJson(configPath)?.plugins?.enabledPlugins ?? {};
  // 产品行为（WP25 已实测）：uninstall 只删**当前 installPath**，不清父目录，
  // 于是「换 version 装过」的机器上旧版本目录会留着。故这里分开记：
  //   cacheFiles        = 当前 installPath 下的文件数（"插件本体还在吗"）
  //   cacheVersionDirs  = cache 下还躺着哪些版本目录（"残留"是 INFO，不是 FAIL）
  const versionDirs = existsSync(cacheRoot)
    ? readdirSync(cacheRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];
  return {
    tag,
    agentsBytes: agentsPath && existsSync(agentsPath) ? readFileSync(agentsPath).length : 0,
    agentsSha: sha256(agentsPath),
    cacheFiles: record?.installPath ? countFiles(record.installPath) : 0,
    cacheVersionDirs: versionDirs,
    cacheTotalFiles: countFiles(cacheRoot),
    configSha: sha256(configPath),
    dataDirExists: existsSync(dataPaths.dataDir),
    enabledHasKey: Object.prototype.hasOwnProperty.call(enabled, PLUGIN_ID),
    enabledValue: enabled[PLUGIN_ID],
    policyBytes: existsSync(dataPaths.policyPath) ? readFileSync(dataPaths.policyPath).length : 0,
    policySha: sha256(dataPaths.policyPath),
    record,
    rulesBytes: existsSync(dataPaths.rulesPath) ? readFileSync(dataPaths.rulesPath).length : 0,
    rulesSha: sha256(dataPaths.rulesPath),
  };
}

const results = [];
let failed = 0;
function check(cond, label, detail = "") {
  results.push({ cond: Boolean(cond), detail, label });
  if (!cond) failed += 1;
  process.stdout.write(`  [${cond ? "PASS" : "FAIL"}] ${label}${detail ? ` · ${detail}` : ""}\n`);
}

// 实际被调用时的命令形态（写进日志而不是「理想形态」）：
// 包壳 run-with-fingerprint.mjs 把子命令 cwd 固定为 ZCode 检出根，因此 `node scripts/smoke-upgrade.mjs`
// 会 MODULE_NOT_FOUND；必须给**绝对路径**。本文件所在目录即插件仓根，故用 REPO_PLUGIN 拼。
const SELF = fileURLToPath(import.meta.url);
const PROOF_ARG = PROOF_LOG ? ` --proof-log ${PROOF_LOG}` : "";
const WRAPPER_CMD =
  `node docs/zcode-mod/isolation/tools/run-with-fingerprint.mjs --label ${LABEL} ` +
  `-- node "${SELF}"${PROOF_ARG}`;

const cliRuns = [];
function runCli(args, label, timeout = 240000) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  const child = spawnSync(process.execPath, [CLI, ...args], {
    cwd: isoRoot,
    encoding: "utf8",
    env,
    timeout,
    windowsHide: true,
  });
  const rec = {
    argv: args,
    durationMs: Date.now() - started,
    exit: child.status,
    label,
    stderr: (child.stderr ?? "").trim(),
    stdout: (child.stdout ?? "").trim(),
  };
  cliRuns.push(rec);
  process.stdout.write(`\n$ node <CLI> ${args.join(" ")}  → exit=${rec.exit} (${rec.durationMs}ms)\n`);
  if (rec.stdout) process.stdout.write(`${rec.stdout}\n`);
  if (rec.stderr) process.stdout.write(`[stderr] ${rec.stderr.slice(0, 1200)}\n`);
  return rec;
}

/** 写市场清单（每次升级都重写，条目 source 指向当次要装的源目录）。 */
function writeMarketplace({ sourcePath, version }) {
  rmSync(marketDir, { force: true, recursive: true });
  mkdirSync(marketDir, { recursive: true });
  const manifest = {
    name: MARKET,
    plugins: [
      {
        description: "WP33 P-8 upgrade simulation (rules + content-policy survive reinstall)",
        name: PLUGIN_NAME,
        source: { path: sourcePath, source: "directory" },
        version,
      },
    ],
  };
  writeFileSync(join(marketDir, "marketplace.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** 造 0.3.1 源副本：整仓复制（排除 .git / node_modules / .zhll），再改两份清单的 version。 */
function makeUpgradeSource(version) {
  rmSync(upgradeSource, { force: true, recursive: true });
  cpSync(REPO_PLUGIN, upgradeSource, {
    filter: (src) => {
      const rel = relative(REPO_PLUGIN, src).split(/[\\/]/u);
      return !rel.some((seg) => seg === ".git" || seg === "node_modules" || seg === ".zhll");
    },
    recursive: true,
  });
  for (const rel of [".zcode-plugin/plugin.json", "package.json"]) {
    const target = join(upgradeSource, ...rel.split("/"));
    const json = JSON.parse(readFileSync(target, "utf8"));
    json.version = version;
    writeFileSync(target, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  }
  return upgradeSource;
}

function rewriteManifestVersion(manifestPath, version) {
  const json = JSON.parse(readFileSync(manifestPath, "utf8"));
  json.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------- 夹具与联网边界
process.stdout.write(
  `[env] node=${process.version}\n[env] HOME=${isoHome}\n[env] ZCODE_DATA_BASE_DIR=${dataBaseDir}\n` +
    `[env] CLI=${CLI}\n[env] plugin=${REPO_PLUGIN}\n[env] pluginId=${PLUGIN_ID}\n`,
);

writeMarketplace({ sourcePath: REPO_PLUGIN, version: "0.3.0" });
const before = snapshot("before-install");
check(
  !before.record && before.cacheFiles === 0 && !before.enabledHasKey,
  "前置态：installed/cache/enabledPlugins 三处均无该插件",
  `cacheFiles=${before.cacheFiles}`,
);

// ---------------------------------------------------------------- 1) 装 v0.3.0
const add = runCli(["plugins", "marketplace", "add", marketDir], "marketplace-add");
check(add.exit === 0 && /Added marketplace/i.test(add.stdout), "marketplace add 成功", `exit=${add.exit}`);
const validate030 = runCli(["plugins", "validate", REPO_PLUGIN], "validate-0.3.0");
check(
  validate030.exit === 0 && /Plugin manifest is valid/i.test(`${validate030.stdout}${validate030.stderr}`),
  "v0.3.0 清单有效",
  `exit=${validate030.exit}`,
);
const install030 = runCli(["plugins", "install", PLUGIN_ID], "install-0.3.0");
check(install030.exit === 0 && /Installed plugin/i.test(install030.stdout), "v0.3.0 安装成功", `exit=${install030.exit}`);
const afterInstall = snapshot("after-install-0.3.0");
check(afterInstall.record?.version === "0.3.0", "装后记录 version=0.3.0", `version=${afterInstall.record?.version}`);
check(afterInstall.cacheFiles > 0, "装后 cache 已落地", `files=${afterInstall.cacheFiles}`);
check(afterInstall.enabledValue === true, "装后 enabledPlugins[id]=true", `value=${afterInstall.enabledValue}`);

// ---------------------------------------------------------------- 2) 写 1 条规则 + 非空策略（走插件自己的数据面）
const RULE_ID = "wp33-allow-read";
const RULE = {
  version: 1,
  name: "WP33 升级模拟规则集",
  unmatched: "abstain",
  onTimeout: "deny",
  watchdogMs: 120000,
  rules: [
    {
      id: RULE_ID,
      tool: "Read",
      decision: "allow",
      commandPattern: "^README\\.md$",
      comment: "P-8：升级后这条规则必须还在（真源保留）",
    },
  ],
};
const POLICY_TEXT = "P-8 内容策略：升级后这段自由文本必须逐字保留。\n第二行用来确认多行文本不被折叠。";

const savedRules = saveRules(dataPaths.rulesPath, RULE);
check(savedRules.ok && savedRules.ruleCount === 1, "数据面写入 1 条规则", `ruleCount=${savedRules.ruleCount}`);
const savedPolicy = savePolicy(dataPaths.policyPath, POLICY_TEXT);
check(savedPolicy.ok && savedPolicy.textBytes > 0, "数据面写入非空内容策略", `${savedPolicy.textBytes}B`);

const exportBefore = exportAgents({ agentsPath, policy: POLICY_TEXT, rules: RULE });
check(
  exportBefore.ok && exportBefore.created === true,
  "首次投影 AGENTS.md（创建双哨兵段）",
  `rules=${exportBefore.actions?.rules} policy=${exportBefore.actions?.policy}`,
);
const written = snapshot("after-write");
check(
  written.rulesSha !== null && written.rulesBytes > 0 && written.policyBytes > 0,
  "升级前快照：rules.json 与 content-policy.json 已存在且非空",
  `rules=${written.rulesBytes}B policy=${written.policyBytes}B`,
);
check(written.agentsSha !== null && written.agentsBytes > 0, "升级前快照：AGENTS.md 已生成", `${written.agentsBytes}B`);

// 对照观测：改缓存里的 manifest（brief 的第一种方案）——验证它**不能**改变安装版本。
// 观测完把缓存清单**原样还原**，避免给后续断言留下一个被改过的缓存目录。
const cache030Manifest = join(cacheRoot, "0.3.0", ".zcode-plugin", "plugin.json");
let cacheEditObserved = null;
if (existsSync(cache030Manifest)) {
  const pristineManifest = readFileSync(cache030Manifest, "utf8");
  rewriteManifestVersion(cache030Manifest, "0.3.1");
  runCli(["plugins", "marketplace", "update", MARKET], "marketplace-update-inert");
  const probe = runCli(["plugins", "install", PLUGIN_ID], "install-after-cache-edit");
  const afterEditSnap = snapshot("after-cache-edit");
  cacheEditObserved = {
    exit: probe.exit,
    installPath: afterEditSnap.record?.installPath ?? null,
    stdout: probe.stdout,
    version: afterEditSnap.record?.version ?? null,
  };
  writeFileSync(cache030Manifest, pristineManifest, "utf8");
  process.stdout.write(
    `\n[观测] 只改缓存 manifest 后重装：version=${JSON.stringify(cacheEditObserved.version)}` +
      `  installPath=${cacheEditObserved.installPath}\n` +
      "[观测] 结论：install 每次都从市场条目 source.path 重新复制并用**源**清单版本，缓存内改动不生效；\n" +
      "        因此「换 version」必须改源副本（下一步）。缓存清单已还原。\n",
  );
} else {
  process.stdout.write(`\n[观测] 未找到缓存清单 ${cache030Manifest}，跳过对照观测\n`);
}
const afterCacheEdit = snapshot("after-cache-edit");
check(
  afterCacheEdit.rulesSha === written.rulesSha && afterCacheEdit.policySha === written.policySha,
  "同版本重装也不动真源（rules/policy sha 不变）",
  `${afterCacheEdit.rulesSha?.slice(0, 12)}…`,
);

// ---------------------------------------------------------------- 3) 换 version 到 0.3.1 重装（改源副本）
const upgradedSource = makeUpgradeSource("0.3.1");
check(
  readJson(join(upgradedSource, ".zcode-plugin", "plugin.json"))?.version === "0.3.1",
  "源副本清单 version=0.3.1",
  upgradedSource,
);
const validate031 = runCli(["plugins", "validate", upgradedSource], "validate-0.3.1");
check(
  validate031.exit === 0 && /Plugin manifest is valid/i.test(`${validate031.stdout}${validate031.stderr}`),
  "0.3.1 副本清单有效",
  `exit=${validate031.exit}`,
);
writeMarketplace({ sourcePath: upgradedSource, version: "0.3.1" });
const marketUpdate = runCli(["plugins", "marketplace", "update", MARKET], "marketplace-update-0.3.1");
check(marketUpdate.exit === 0 && /Updated marketplace/i.test(marketUpdate.stdout), "市场条目刷新到 0.3.1", `exit=${marketUpdate.exit}`);
const reinstall = runCli(["plugins", "install", PLUGIN_ID], "reinstall-0.3.1");
check(reinstall.exit === 0 && /Installed plugin/i.test(reinstall.stdout), "0.3.1 重装成功", `exit=${reinstall.exit}`);

const upgraded = snapshot("after-upgrade-0.3.1");
check(
  upgraded.record?.version === "0.3.1",
  "★ 升级确实发生：记录 version=0.3.1（否则后面的「不变」都是恒真）",
  `0.3.0 → ${upgraded.record?.version}`,
);
check(
  typeof upgraded.record?.installPath === "string" && upgraded.record.installPath.includes("0.3.1"),
  "★ installPath 指向 0.3.1 缓存目录",
  upgraded.record?.installPath ?? "<null>",
);
check(
  upgraded.cacheFiles > 0,
  "0.3.1 缓存目录有插件文件",
  `${upgraded.cacheFiles} files`,
);
check(
  upgraded.cacheVersionDirs.length >= 1 && upgraded.cacheVersionDirs.includes("0.3.1"),
  "cache 下出现 0.3.1 版本目录（旧版本并存是产品行为）",
  `[${upgraded.cacheVersionDirs.join(", ")}]`,
);

// 真源保留
check(
  upgraded.rulesSha === written.rulesSha && upgraded.rulesBytes === written.rulesBytes,
  "rules.json 字节与 sha256 不变",
  `${written.rulesSha?.slice(0, 12)}… (${written.rulesBytes}B) → ${upgraded.rulesSha?.slice(0, 12)}… (${upgraded.rulesBytes}B)`,
);
check(
  upgraded.policySha === written.policySha && upgraded.policyBytes === written.policyBytes,
  "content-policy.json 字节与 sha256 不变",
  `${written.policySha?.slice(0, 12)}… (${written.policyBytes}B) → ${upgraded.policySha?.slice(0, 12)}… (${upgraded.policyBytes}B)`,
);

// 数据面读回（用插件自己的读取路径，不手解 JSON）
const rulesBack = loadRules(dataPaths.rulesPath);
check(
  rulesBack.ok && rulesBack.exists && rulesBack.rules?.rules?.length === 1 && rulesBack.rules.rules[0].id === RULE_ID,
  "升级后 loadRules 读回那 1 条规则",
  `id=${rulesBack.rules?.rules?.[0]?.id} decision=${rulesBack.rules?.rules?.[0]?.decision}`,
);
const policyBack = loadPolicy(dataPaths.policyPath);
check(
  policyBack.ok && policyBack.text === POLICY_TEXT,
  "升级后 loadPolicy 逐字读回内容策略",
  `${policyBack.bytes}B`,
);

// 投影幂等：用升级后的插件代码再投影一次，字节必须不变
const exportAfter = exportAgents({ agentsPath, policy: policyBack.text, rules: rulesBack.rules });
check(
  exportAfter.ok && exportAfter.changed === false,
  "★ 投影幂等：升级后重新 exportAgents 未改动 AGENTS.md（changed=false）",
  `sha=${exportAfter.sha256?.slice(0, 12)}…`,
);
check(
  exportAfter.sha256 === written.agentsSha,
  "★ AGENTS.md 投影 sha256 与升级前全等",
  `${written.agentsSha?.slice(0, 12)}… → ${exportAfter.sha256?.slice(0, 12)}…`,
);
const agentsText = readText(agentsPath) ?? "";
check(
  agentsText.includes("BEGIN zcode-rules") && agentsText.includes("BEGIN zcode-content-policy"),
  "AGENTS.md 双哨兵段仍在",
  `${Buffer.byteLength(agentsText, "utf8")}B`,
);

// 身份不变
check(upgraded.record?.id === PLUGIN_ID, "插件 id 不变", upgraded.record?.id ?? "<null>");
check(
  upgraded.enabledHasKey && upgraded.enabledValue === true,
  "enabledPlugins[id] 仍为 true",
  `value=${upgraded.enabledValue}`,
);

// ---------------------------------------------------------------- 4) 卸载清理
const uninstall = runCli(["plugins", "uninstall", PLUGIN_ID, "--force"], "uninstall");
check(
  uninstall.exit === 0 && /Uninstalled plugin/i.test(uninstall.stdout),
  "卸载成功",
  `exit=${uninstall.exit}`,
);
const afterUninstall = snapshot("after-uninstall");
check(!afterUninstall.record, "① installed_plugins.json 无该插件记录");
check(afterUninstall.cacheFiles === 0, "② 当前 installPath 无插件文件（0.3.1 目录被删）", `files=${afterUninstall.cacheFiles}`);
check(!afterUninstall.enabledHasKey, "③ enabledPlugins 键已清除");
check(!afterUninstall.dataDirExists, "④ data/<plugin-id> 目录已移除（产品默认不 keepData）");
check(
  afterUninstall.agentsSha === written.agentsSha,
  "⑤ 卸载不碰用户 AGENTS.md（产品不还原也不删除）",
  `${afterUninstall.agentsSha?.slice(0, 12)}…`,
);
const leftoverDirs = afterUninstall.cacheVersionDirs;
process.stdout.write(
  `\n[info] 卸载后 cache 残留版本目录=[${leftoverDirs.join(", ") || "<无>"}]` +
    `（${afterUninstall.cacheTotalFiles} 个文件）—— 产品只删当前 installPath，这是已知行为，不是本脚本的失败项\n`,
);

// ---------------------------------------------------------------- 5) 证据日志（五段头）
function buildLog() {
  const lines = [];
  lines.push("# cmd:");
  lines.push(WRAPPER_CMD);
  lines.push("# exit:");
  lines.push(String(failed === 0 ? 0 : 1));
  lines.push("# env:");
  lines.push(
    `node=${process.version} · recipe=isolated(HOME+USERPROFILE+ZCODE_DESKTOP_HOME_DIR+ZCODE_DATA_BASE_DIR)`,
  );
  lines.push(`HOME=${isoHome}`);
  lines.push(`ZCODE_DATA_BASE_DIR=${dataBaseDir}`);
  lines.push(`ZCODE_LOG_DIR=${logDir}`);
  lines.push(`CLI=${CLI}（产物只读，未改动）`);
  lines.push("# input:");
  lines.push(`插件源（v0.3.0）=${REPO_PLUGIN}（只读，工作树未改）`);
  lines.push(`插件源副本（v0.3.1）=${upgradedSource}（隔离目录内复制，排除 .git/node_modules/.zhll）`);
  lines.push(`市场=${marketDir} · 市场名=${MARKET} · pluginId=${PLUGIN_ID}`);
  lines.push(`规则文件=${dataPaths.rulesPath}（1 条，id=${RULE_ID}）`);
  lines.push(`策略文件=${dataPaths.policyPath}（${Buffer.byteLength(POLICY_TEXT, "utf8")}B）`);
  lines.push(`投影=${agentsPath}（用户级 AGENTS.md，隔离 home 内）`);
  lines.push("# repro:");
  lines.push(WRAPPER_CMD);
  lines.push("（在 ZCode 检出根执行；包壳把子命令 cwd 固定为检出根，故脚本路径必须是绝对路径）");
  lines.push("# date:");
  lines.push(STAMP);
  lines.push("");
  lines.push("--- 原始输出 ---");
  for (const run of cliRuns) {
    lines.push("");
    lines.push(`$ node <CLI> ${run.argv.join(" ")}`);
    lines.push(`exit=${run.exit} durationMs=${run.durationMs}`);
    lines.push("stdout:");
    lines.push(run.stdout || "<empty>");
    lines.push("stderr:");
    lines.push(run.stderr || "<empty>");
  }
  lines.push("");
  lines.push("--- 状态快照（装前 / 写后 / 重装后 / 卸后）---");
  for (const snap of [before, afterInstall, written, upgraded, afterUninstall]) {
    lines.push(
      `[${snap.tag}] id=${PLUGIN_ID} version=${snap.record?.version ?? "<无>"} ` +
        `cacheFiles=${snap.cacheFiles} cacheDirs=[${snap.cacheVersionDirs.join(",")}] ` +
        `enabled=${snap.enabledValue ?? "<无>"} ` +
        `rules=${snap.rulesSha?.slice(0, 16) ?? "<无>"}(${snap.rulesBytes}B) ` +
        `policy=${snap.policySha?.slice(0, 16) ?? "<无>"}(${snap.policyBytes}B) ` +
        `agents=${snap.agentsSha?.slice(0, 16) ?? "<无>"}(${snap.agentsBytes}B) ` +
        `dataDir=${snap.dataDirExists}`,
    );
  }
  lines.push("");
  lines.push("--- 对照观测：只改缓存 manifest 不能升级 ---");
  lines.push(
    cacheEditObserved
      ? `改 ${cache030Manifest} 的 version=0.3.1 后重装 → 实际版本=${JSON.stringify(cacheEditObserved.version)}；installPath=${cacheEditObserved.installPath}`
      : "缓存清单未找到，未做该观测",
  );
  lines.push("说明：install 从市场条目 source.path 重新复制，并用源清单 version 决定安装版本；");
  lines.push("      故本脚本的升级走「源副本改 version」，全程不碰仓库与 ZCode 检出。");
  lines.push("");
  lines.push("--- 断言逐条 ---");
  for (const r of results) lines.push(`[${r.cond ? "PASS" : "FAIL"}] ${r.label}${r.detail ? ` · ${r.detail}` : ""}`);
  lines.push("");
  lines.push(
    `结论：P-8 升级模拟（隔离环境）= ${failed === 0 ? "成立（exit 0）：真源保留、投影幂等、身份不变、卸载清净" : `不成立（${failed} 项失败，exit 1）`}`,
  );
  return lines.join("\n");
}

const logText = buildLog();
if (!KEEP) process.stdout.write("\n[info] 隔离目录保留供包壳后置快照；删 `.zhll/rt/iso-runs/<label>` 即可重来\n");
if (PROOF_LOG) {
  const logPath = resolve(process.env.WP33_PROOF_ROOT || process.cwd(), PROOF_LOG);
  mkdirSync(resolve(logPath, ".."), { recursive: true });
  writeFileSync(logPath, `${logText}\n`, "utf8");
  process.stdout.write(`\n[proof] ${logPath}\n`);
}

process.stdout.write(`\n[result] ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
