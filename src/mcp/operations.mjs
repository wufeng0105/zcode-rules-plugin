// MCP 数据面：纯函数 + 显式路径（不读全局状态、不猜目录），便于单测与 fail-closed。
//
// 职责边界：
//   · 规则文件 rules.json：结构化规则，写入前必须过 rules-engine.validateRules
//   · 内容策略 content-policy.json：自由文本，默认空（空策略 = 零行为变化）
//   · 双哨兵投影：AGENTS.md 里同时维护 zcode-rules 与 zcode-content-policy 两段
//   · 自检：规则合法性 / 策略状态 / 两段投影一致性（手改检测）/ AGENTS.md 尺寸 / 版本号
//
// 所有外部副作用都收敛在这里：文件读写 + 原子替换；MCP server 只做协议与参数校验。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENTS_SECTION_BEGIN,
  RULE_SCHEMA_VERSION,
  renderAgentsSection,
  validateRules,
} from "../rules/rules-engine.mjs";
import {
  SECTION_NAMES,
  composeNamedSection,
  detectLineEnding,
  locateNamedSection,
  removeNamedSection,
  sectionSnapshot,
  upsertNamedSection,
} from "../rules/sections.mjs";
import { readPolicySection, readRulesSection } from "./agents-backfill.mjs";

export const RULES_FILE = "rules.json";
export const POLICY_FILE = "content-policy.json";
export const POLICY_VERSION = 1;
export const AGENTS_SIZE_WARN_BYTES = 90 * 1024;
export const PANEL_RESOURCE_URI = "ui://zcode-rules/panel.html";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(MODULE_DIR, "..", "..");
const PANEL_PATH = join(PLUGIN_ROOT, "ui", "panel.html");

const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** 用户级 AGENTS.md（F6：os.homedir()/.zcode/AGENTS.md）。纯函数，调用时取 homedir。 */
export function defaultAgentsPath() {
  return join(homedir(), ".zcode", "AGENTS.md");
}

/** 用户级 CLI config（R1：检查是否残留手工 PermissionRequest 接线）。 */
export function defaultCliConfigPath() {
  return join(homedir(), ".zcode", "cli", "config.json");
}

/** 本仓库/插件根（模块相对定位，不依赖 cwd）。 */
export function pluginRoot() {
  return PLUGIN_ROOT;
}

/** 数据目录三件套：dataDir / rulesPath / policyPath（显式路径，便于测试）。 */
export function resolveDataPaths(dataDir) {
  if (typeof dataDir !== "string" || dataDir.trim() === "") {
    throw new Error("dataDir 必须是非空路径字符串");
  }
  const root = resolve(dataDir);
  return {
    dataDir: root,
    policyPath: join(root, POLICY_FILE),
    rulesPath: join(root, RULES_FILE),
  };
}

// 原子写：同目录临时文件 + rename。Windows 上 rename 覆盖已存在文件是允许的。
function writeFileAtomic(filePath, text) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, text, "utf8");
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw error;
  }
}

/**
 * 读规则并校验。
 * 返回 `{ ok, exists, path, rules, errors, warnings }`：
 *   · 文件不存在 → ok=true / exists=false（缺省是正常态：空规则 = 零行为变化）
 *   · JSON 坏了或 schema 非法 → ok=false（rules 为 null，绝不返回半成品）
 */
export function loadRules(rulesPath) {
  const target = resolve(rulesPath);
  if (!existsSync(target)) {
    return { ok: true, exists: false, path: target, rules: null, errors: [], warnings: [] };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    return {
      ok: false,
      exists: true,
      path: target,
      rules: null,
      errors: [`规则文件不是合法 JSON：${String(error?.message ?? error)}`],
      warnings: [],
    };
  }
  const verdict = validateRules(raw);
  return {
    ok: verdict.ok,
    exists: true,
    path: target,
    rules: verdict.ok ? verdict.rules : null,
    errors: verdict.errors,
    warnings: verdict.warnings,
  };
}

/**
 * 校验后写规则（非法一律拒绝写入，不产生/不覆盖文件）。
 * 返回 `{ ok, written, path, bytes, sha256, ruleCount, errors, warnings }`。
 */
export function saveRules(rulesPath, raw) {
  const target = resolve(rulesPath);
  const verdict = validateRules(raw);
  if (!verdict.ok) {
    return {
      ok: false,
      written: false,
      path: target,
      errors: verdict.errors,
      warnings: verdict.warnings,
    };
  }
  const text = `${JSON.stringify(verdict.rules, null, 2)}\n`;
  writeFileAtomic(target, text);
  return {
    ok: true,
    written: true,
    path: target,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: sha256(text),
    ruleCount: verdict.rules.rules.length,
    warnings: verdict.warnings,
  };
}

/**
 * 读内容策略（content-policy.json = `{ "version": 1, "text": "..." }`）。
 * 缺省为空文本；坏 JSON / 形状不对一律 ok=false（fail-closed）。
 */
export function loadPolicy(policyPath) {
  const target = resolve(policyPath);
  if (!existsSync(target)) {
    return { ok: true, exists: false, path: target, text: "", bytes: 0, warnings: [], errors: [] };
  }
  const raw = readFileSync(target, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      exists: true,
      path: target,
      text: "",
      bytes: Buffer.byteLength(raw, "utf8"),
      errors: [`内容策略不是合法 JSON：${String(error?.message ?? error)}`],
      warnings: [],
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      exists: true,
      path: target,
      text: "",
      bytes: Buffer.byteLength(raw, "utf8"),
      errors: ['内容策略必须是 JSON 对象：{ "version": 1, "text": "..." }'],
      warnings: [],
    };
  }
  if (typeof parsed.text !== "string") {
    return {
      ok: false,
      exists: true,
      path: target,
      text: "",
      bytes: Buffer.byteLength(raw, "utf8"),
      errors: ["内容策略字段 text 必须是字符串"],
      warnings: [],
    };
  }
  const warnings = [];
  if (parsed.version !== undefined && parsed.version !== POLICY_VERSION) {
    warnings.push(`内容策略 version=${JSON.stringify(parsed.version)}（当前支持 ${POLICY_VERSION}）`);
  }
  return {
    ok: true,
    exists: true,
    path: target,
    text: parsed.text,
    bytes: Buffer.byteLength(parsed.text, "utf8"),
    warnings,
    errors: [],
  };
}

/** 写内容策略（自由文本；确定性序列化，同输入二次写入字节相同）。 */
export function savePolicy(policyPath, text) {
  const target = resolve(policyPath);
  if (typeof text !== "string") {
    return { ok: false, written: false, path: target, errors: ["text 必须是字符串"] };
  }
  const payload = { version: POLICY_VERSION, text };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileAtomic(target, serialized);
  return {
    ok: true,
    written: true,
    path: target,
    bytes: Buffer.byteLength(serialized, "utf8"),
    sha256: sha256(serialized),
    textBytes: Buffer.byteLength(text, "utf8"),
    textChars: text.length,
  };
}

/**
 * 双哨兵投影：把规则与内容策略写进 AGENTS.md 的两个命名段。
 *   · 文件不存在 → 创建只含两个哨兵段的文件（不伪造头部/默认指令）
 *   · 文件已存在 → 只替换段内，段外字节原样
 *   · 幂等：同输入二次导出字节不变
 * 返回动作摘要（不含全文），供 MCP 工具回传。
 *
 * T68（v0.4.2）：新增 `projectRules`。只有显式 `false` 才改变行为——
 *   · 不投影规则段：只写 zcode-content-policy；
 *   · 已有 zcode-rules 段会被**摘除**（removeNamedSection 外科式删段）：留着旧规则文本
 *     会继续注入模型上下文，看起来像"当前规则"，比没有更糟；摘除只动段本身，段外字节原样。
 *   · 该模式下 `rules` 既不读也不校验——本次导出的语义就是"不投影规则"，再要求一份合法
 *     rules.json 属于自相矛盾的摩擦；hook 判定仍读 rules.json，与本函数无关。
 *   · 规则段哨兵残缺/乱序/重复 → 拒绝写入并 ok=false（绝不盲删）。
 */
export function exportAgents({ agentsPath, rules, policy, projectRules } = {}) {
  if (typeof agentsPath !== "string" || agentsPath.trim() === "") {
    return { ok: false, errors: ["agentsPath 必须是非空路径字符串"] };
  }
  const target = resolve(agentsPath);

  // 判定式按约定写成 `!== false`：undefined / true / 其它值都保持原行为。
  const projectRuleSection = projectRules !== false;

  let verdict = null;
  if (projectRuleSection) {
    verdict = validateRules(rules);
    if (!verdict.ok) {
      return {
        ok: false,
        agentsPath: target,
        errors: [`规则校验失败：${verdict.errors.join(" ; ")}`],
        warnings: verdict.warnings,
      };
    }
  }
  if (policy !== undefined && policy !== null && typeof policy !== "string") {
    return { ok: false, agentsPath: target, errors: ["policy 必须是字符串"] };
  }
  const policyText = policy ?? "";

  const exists = existsSync(target);
  const before = exists ? readFileSync(target, "utf8") : "";

  let rulesStep;
  let policyStep;
  let removedRulesSection = null;
  try {
    let working = before;
    if (projectRuleSection) {
      // 规则段直接采用 rules-engine 的投影（逐字兼容），引擎识别为完整段后原样写入。
      rulesStep = upsertNamedSection(before, SECTION_NAMES.RULES, renderAgentsSection(verdict.rules));
      working = rulesStep.content;
    } else {
      const removed = removeNamedSection(before, SECTION_NAMES.RULES);
      if (removed.action === "refused") {
        // 与 upsert 的 fail-closed 同口径：段边界不唯一时不写任何字。
        throw new Error(
          `段 ${SECTION_NAMES.RULES} 的哨兵结构异常（${removed.reason}），拒绝摘除；请先人工核对段边界`,
        );
      }
      rulesStep = { action: removed.action };
      if (removed.action === "removed") {
        removedRulesSection = { bytes: removed.removedBytes, sha256: removed.removedSha256 };
      }
      working = removed.content;
    }
    policyStep = upsertNamedSection(working, SECTION_NAMES.CONTENT_POLICY, policyText);
  } catch (error) {
    return {
      ok: false,
      agentsPath: target,
      changed: false,
      errors: [String(error?.message ?? error)],
    };
  }

  const content = policyStep.content;
  const changed = content !== before;
  if (changed) writeFileAtomic(target, content);

  return {
    ok: true,
    agentsPath: target,
    created: !exists,
    changed,
    projectRules: projectRuleSection,
    actions: { policy: policyStep.action, rules: rulesStep.action },
    ...(removedRulesSection === null ? {} : { removedRulesSection }),
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: sha256(content),
    policyBytes: Buffer.byteLength(policyText, "utf8"),
    ruleCount: projectRuleSection ? verdict.rules.rules.length : 0,
    sections: {
      policy: projectSnapshot(content, SECTION_NAMES.CONTENT_POLICY),
      rules: projectSnapshot(content, SECTION_NAMES.RULES),
    },
    warnings: projectRuleSection ? verdict.warnings : [],
  };
}

function projectSnapshot(text, name) {
  const snapshot = sectionSnapshot(text, name);
  return {
    bytes: snapshot.bytes ?? 0,
    malformed: snapshot.malformed,
    present: snapshot.present,
    sha256: snapshot.sha256 ?? null,
  };
}

function resolvePluginVersionInfo() {
  const root = process.env.ZCODE_RULES_ROOT?.trim() || PLUGIN_ROOT;
  const readJson = (filePath) => {
    try {
      return JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  };
  const manifest = readJson(join(root, ".zcode-plugin", "plugin.json"));
  const pkg = readJson(join(root, "package.json"));
  return {
    root,
    manifestVersion: typeof manifest?.version === "string" ? manifest.version : null,
    manifestName: typeof manifest?.name === "string" ? manifest.name : null,
    packageVersion: typeof pkg?.version === "string" ? pkg.version : null,
  };
}

/**
 * R1：「config 无手工接线」检查。
 * 真实 home 的 A 路线安装态会在 `hooks.events.PermissionRequest` 留数组；插件装上后
 * 同一事件双 hook 行为叠加不可判，所以 selfcheck 只做 warning，不阻断。
 * 返回 `{ level, message, detail }`；文件缺失/无该键 = 通过。
 */
function inspectManualPermissionHooks(configPath) {
  if (!existsSync(configPath)) {
    return { level: "ok", message: "config 不存在，无手工 PermissionRequest 接线", detail: configPath };
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    return {
      level: "warn",
      message: `config 不是合法 JSON，未能确认无手工 PermissionRequest 接线：${String(error?.message ?? error)}`,
      detail: configPath,
    };
  }
  const matchers = config?.hooks?.events?.PermissionRequest;
  if (Array.isArray(matchers) && matchers.length > 0) {
    return {
      level: "warn",
      message: "config 含手工 PermissionRequest 接线（A 路线残留？）",
      detail: `${configPath} · ${matchers.length} 组 matcher`,
    };
  }
  return { level: "ok", message: "config 无手工 PermissionRequest 接线", detail: configPath };
}

/**
 * 自检（只读，不写任何文件）。
 * 检查项：规则合法、内容策略空/非空、两段投影是否与实际渲染一致（手改提示）、
 *        AGENTS.md 尺寸 >90KiB 预警、版本号、config 无手工接线（R1）。
 * 返回 `{ ok, checks, summary }`；ok 只由 error 级检查决定（warn/info 不阻断）。
 */
export function runSelfcheck({ agentsPath, dataDir, configPath } = {}) {
  const checks = [];
  const add = (id, level, message, detail, extra) => {
    checks.push({
      id,
      level,
      message,
      ...(detail === undefined ? {} : { detail }),
      ...(extra ?? {}),
    });
  };

  let paths;
  try {
    paths = resolveDataPaths(dataDir);
  } catch (error) {
    add("data-dir", "error", String(error?.message ?? error));
    return {
      ok: false,
      backfill: null,
      checks,
      summary: {
        agentsBytes: 0,
        agentsPath: null,
        dataDir: null,
        errors: 1,
        policyBytes: 0,
        rulesCount: 0,
        version: null,
        warnings: 0,
      },
    };
  }

  const target = typeof agentsPath === "string" && agentsPath.trim() !== ""
    ? resolve(agentsPath)
    : defaultAgentsPath();

  // 0) 数据目录可见性（v0.4.1 新增）
  // 为什么要它：插件可能以不同 id / 不同市场源安装（目录市场 vs GitHub 源），
  // 数据目录名随之不同。用户判断「我的规则到底存在哪」只能靠猜。
  // 这里把宿主注入的数据目录与其中的真源文件显式报出来，让「规则不生效」
  // 的第一排查动作（确认目录）不必靠猜路径。
  {
    const rulesExists = existsSync(paths.rulesPath);
    const policyExists = existsSync(paths.policyPath);
    add(
      "data-dir",
      "ok",
      `数据目录：${paths.dataDir}（规则源${rulesExists ? "已存在" : "尚未创建"}，内容策略${policyExists ? "已存在" : "尚未创建"}）`,
      paths.dataDir,
    );
  }

  // 1) 规则
  const rulesLoaded = loadRules(paths.rulesPath);
  let rulesCount = 0;
  if (!rulesLoaded.ok) {
    add("rules-valid", "error", `规则文件不可用：${rulesLoaded.errors.join(" ; ")}`, rulesLoaded.path);
  } else if (!rulesLoaded.exists) {
    add("rules-valid", "warn", "规则文件尚未创建（空规则 = 产品原行为）", rulesLoaded.path);
    add(
      "rules-default",
      "info",
      "rules.json 缺失：hook 使用插件内置空规则（rules.default.json，unmatched=abstain，零行为变化）",
      rulesLoaded.path,
    );
  } else {
    rulesCount = rulesLoaded.rules.rules.length;
    add(
      "rules-valid",
      "ok",
      `规则合法：${rulesCount} 条（schema v${rulesLoaded.rules.version}，未命中 ${rulesLoaded.rules.unmatched}）`,
      rulesLoaded.path,
    );
    for (const warning of rulesLoaded.warnings) add("rules-warning", "warn", warning);
  }

  // 2) 内容策略
  const policyLoaded = loadPolicy(paths.policyPath);
  if (!policyLoaded.ok) {
    add("policy-state", "error", `内容策略不可用：${policyLoaded.errors.join(" ; ")}`, paths.policyPath);
  } else if (policyLoaded.text.trim() === "") {
    add("policy-state", "ok", "内容策略为空（零行为变化）", paths.policyPath);
  } else {
    add(
      "policy-state",
      "ok",
      `内容策略非空：${Buffer.byteLength(policyLoaded.text, "utf8")} B / ${policyLoaded.text.length} 字符`,
      paths.policyPath,
    );
  }
  for (const warning of policyLoaded.warnings) add("policy-warning", "warn", warning);

  // 2.5) config 无手工接线（R1：A→B 迁移双 hook 窗口）
  const cliConfigPath = typeof configPath === "string" && configPath.trim() !== ""
    ? resolve(configPath)
    : defaultCliConfigPath();
  const manualHooks = inspectManualPermissionHooks(cliConfigPath);
  add("config-no-manual-hooks", manualHooks.level, manualHooks.message, manualHooks.detail);

  // 3) AGENTS.md 与两段投影
  const agentsExists = existsSync(target);
  let agentsText = "";
  let agentsBytes = 0;
  // P-6 用户路径需要的「从 AGENTS.md 回填」候选：只有能无损还原成真源时才给（否则 ok=false）。
  let backfill = null;
  if (!agentsExists) {
    add("agents-exists", "warn", "AGENTS.md 不存在（尚未导出规则段）", target);
  } else {
    agentsText = readFileSync(target, "utf8");
    agentsBytes = Buffer.byteLength(agentsText, "utf8");
    add("agents-exists", "ok", `AGENTS.md 存在：${agentsBytes} B`, target);
    if (agentsBytes > AGENTS_SIZE_WARN_BYTES) {
      add(
        "agents-size",
        "warn",
        `AGENTS.md 尺寸 ${agentsBytes} B 超过 90 KiB 预警线（全文注入会挤占上下文）`,
        `${AGENTS_SIZE_WARN_BYTES} B`,
      );
    } else {
      add("agents-size", "ok", `AGENTS.md 尺寸 ${agentsBytes} B（≤ 90 KiB）`);
    }

    if (rulesLoaded.ok && rulesLoaded.exists) {
      const snapshot = sectionSnapshot(agentsText, SECTION_NAMES.RULES);
      if (!snapshot.present) {
        // T68：缺规则段可能是 export_agents 的 projectRules:false 有意为之（v0.4.2 新增）。
        // 自检无法从磁盘区分"有意不投影"与"还没导出"，故保留 warn，并给出 absent 标记
        // 让面板不再把它当成"被手改"。hook 判定读 rules.json，不受投影开关影响。
        add(
          "rules-section",
          "warn",
          snapshot.malformed
            ? `zcode-rules 段哨兵结构异常：${snapshot.reason}`
            : "AGENTS.md 里没有 zcode-rules 段（可能是 projectRules:false 的有意选择，或尚未导出；hook 判定不受影响）",
          undefined,
          snapshot.malformed ? {} : { absent: true },
        );
      } else {
        const actual = agentsText.slice(snapshot.begin, snapshot.end);
        const expected = renderAgentsSection(rulesLoaded.rules);
        if (actual !== expected) {
          add(
            "rules-section",
            "warn",
            "zcode-rules 段与规则投影不一致：可能被手改，或规则改了没重新导出",
            `实际 ${snapshot.bytes} B / sha ${String(snapshot.sha256).slice(0, 12)}…`,
          );
        } else {
          add("rules-section", "ok", "zcode-rules 段与规则投影一致", `${snapshot.bytes} B`);
        }
      }
    } else if (rulesLoaded.ok) {
      add("rules-section", "warn", "规则文件缺省，跳过规则段一致性检查");
    }

    if (policyLoaded.ok) {
      const snapshot = sectionSnapshot(agentsText, SECTION_NAMES.CONTENT_POLICY);
      if (!snapshot.present) {
        add(
          "policy-section",
          "warn",
          snapshot.malformed
            ? `zcode-content-policy 段哨兵结构异常：${snapshot.reason}`
            : "AGENTS.md 里没有 zcode-content-policy 段（尚未导出）",
          undefined,
          snapshot.malformed ? {} : { absent: true },
        );
      } else {
        const actual = agentsText.slice(snapshot.begin, snapshot.end);
        const expected = composeNamedSection(
          SECTION_NAMES.CONTENT_POLICY,
          policyLoaded.text,
          detectLineEnding(agentsText),
        );
        if (actual !== expected) {
          add(
            "policy-section",
            "warn",
            "zcode-content-policy 段与内容策略投影不一致：可能被手改，或策略改了没重新导出",
            `实际 ${snapshot.bytes} B / sha ${String(snapshot.sha256).slice(0, 12)}…`,
          );
        } else {
          add("policy-section", "ok", "zcode-content-policy 段与内容策略投影一致", `${snapshot.bytes} B`);
        }
      }
    }

    // 3.5) 手改提示（P-6）的两个真实动作所需的候选：
    //   · overwrite：export_agents（真源 → AGENTS.md），无需服务端额外数据
    //   · backfill ：读 AGENTS.md 的段内容并反解成真源，面板二次确认后走 rules_write / content_policy_write
    const rulesSection = readRulesSection(agentsText, rulesLoaded.ok ? rulesLoaded.rules : null);
    const policySection = readPolicySection(agentsText);
    backfill = {
      policy: {
        malformed: policySection.malformed,
        ok: policySection.ok,
        present: policySection.present,
        reason: policySection.reason ?? null,
        roundTrip: policySection.roundTrip,
        text: policySection.ok ? policySection.text : null,
      },
      rules: {
        appendedIds: rulesSection.suggested?.appendedIds ?? [],
        droppedIds: rulesSection.suggested?.droppedIds ?? [],
        errors: rulesSection.errors,
        malformed: rulesSection.malformed,
        ok: rulesSection.ok,
        orderChanged: rulesSection.suggested?.orderChanged ?? false,
        present: rulesSection.present,
        reason: rulesSection.reason ?? null,
        roundTrip: rulesSection.roundTrip,
        // 段内解析出的原始次序（展示用）；真正写回时用 suggested（保真源次序）
        rules: rulesSection.ok ? rulesSection.rules : null,
        suggested: rulesSection.suggested?.rules ?? null,
        suggestedErrors: rulesSection.suggested?.errors ?? [],
      },
      warnings: rulesSection.warnings,
    };
  }

  // 4) 版本号
  const versionInfo = resolvePluginVersionInfo();
  const version = versionInfo.manifestVersion ?? versionInfo.packageVersion;
  if (!versionInfo.manifestVersion) {
    add("version", "error", "插件 manifest 缺少 version 字段", versionInfo.root);
  } else if (!versionInfo.packageVersion) {
    add("version", "warn", `插件 package.json 缺少 version（manifest ${versionInfo.manifestVersion}）`);
  } else if (versionInfo.packageVersion !== versionInfo.manifestVersion) {
    add(
      "version",
      "warn",
      `版本号不一致：manifest ${versionInfo.manifestVersion} ≠ package.json ${versionInfo.packageVersion}`,
    );
  } else {
    add("version", "ok", `版本一致：v${versionInfo.manifestVersion}`);
  }

  const errors = checks.filter((check) => check.level === "error").length;
  const warnings = checks.filter((check) => check.level === "warn").length;
  return {
    ok: errors === 0,
    // 屏 4「手改提示」用：段不一致（非 ok）时的两个真实动作所需数据；AGENTS.md 不存在时为 null。
    backfill,
    checks,
    summary: {
      agentsBytes,
      agentsPath: target,
      dataDir: paths.dataDir,
      errors,
      policyBytes: policyLoaded.ok ? Buffer.byteLength(policyLoaded.text, "utf8") : 0,
      rulesCount,
      rulesSchemaVersion: RULE_SCHEMA_VERSION,
      version,
      warnings,
    },
  };
}

/** 面板 HTML：直接返回 `ui/panel.html` 的静态内容（占位，无假按钮）。 */
export function renderPanelHtml() {
  return readFileSync(PANEL_PATH, "utf8");
}

/** 面板资源路径（测试与诊断用）。 */
export function panelPath() {
  return PANEL_PATH;
}

export { AGENTS_SECTION_BEGIN, SECTION_NAMES, locateNamedSection };
