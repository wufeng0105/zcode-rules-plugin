// 面板（ui/panel.html）静态断言：四屏存在、界面纪律、桥接与手改提示分支。
//
// 这个测试**不启动浏览器**：面板必须在沙箱 iframe 里跑，单元测试只做「源码层面能证明的事」：
//   · 四屏标题与分区 id 都在
//   · 禁项不存在（「立即生效」、假开关、清空类按钮、无确认清空）
//   · 每个 data-action 都能在动作表里找到实现（这就是「假按钮」的判定）
//   · 桥接函数、六个工具名、手改提示的两个真实动作与二次确认都在
// 界面行为（点击后的效果）由隔离冒烟与人工验收覆盖，不在这里假装验证。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PANEL_PATH = join(REPO_ROOT, "ui", "panel.html");
const PANEL = readFileSync(PANEL_PATH, "utf8");
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, ".zcode-plugin", "plugin.json"), "utf8"));

/** 取出页面里那段内联脚本的源码。 */
function inlineScript() {
  const match = PANEL.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "面板应有一段内联 <script>");
  return match[1];
}

/** 取出所有 `data-action="..."` 的值（去重）。 */
function actionNames(html) {
  return [...new Set([...html.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]))].sort();
}

/** 取出动作表里已实现的键（`"name": async (...) => {` 形式）。 */
function implementedActions(html) {
  return [
    ...new Set([...html.matchAll(/^\s*"([a-z][a-z0-9-]*)":\s*async\s*\(/gm)].map((match) => match[1])),
  ].sort();
}

test("面板版本字样与清单/package.json 一致（版本从清单读取，不硬编码）", () => {
  // 版本号不写死：以后升版本不必改这里，但清单/面板/包三处必须始终同源。
  assert.equal(PKG.version, MANIFEST.version, "package.json 与 manifest 版本不一致");
  const v = PKG.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(PANEL, new RegExp(`<strong id="panel-version">v${v}</strong>`), "面板版本字样与清单不一致");
  assert.match(PANEL, new RegExp(`const PANEL_VERSION = "${v}";`), "面板 PANEL_VERSION 常量与清单不一致");
});

test("四屏标题齐全：状态 / 规则表 / 内容策略 / 自检", () => {
  for (const heading of ["状态", "规则表", "内容策略", "自检与版本"]) {
    assert.ok(PANEL.includes(`>${heading}<`), `缺少屏标题：${heading}`);
  }
  for (const id of ["screen-status", "screen-rules", "screen-policy", "screen-check"]) {
    assert.ok(PANEL.includes(`id="${id}"`), `缺少分区：${id}`);
  }
  // 一屏一职责：四个分区各自 aria-labelledby 到自己的标题。
  for (const [id, label] of [
    ["screen-status", "status-heading"],
    ["screen-rules", "rules-heading"],
    ["screen-policy", "policy-heading"],
    ["screen-check", "check-heading"],
  ]) {
    assert.ok(
      new RegExp(`id="${id}" aria-labelledby="${label}"`).test(PANEL),
      `${id} 应 aria-labelledby="${label}"`,
    );
  }
});

test("界面纪律：不出现「立即生效」", () => {
  assert.equal(PANEL.includes("立即生效"), false, "面板不得出现「立即生效」");
  assert.equal(PANEL.includes("立即"), false, "面板不得出现「立即」字样（避免误导）");
});

test("界面纪律：不伪造总开关（没有 input/checkbox/switch，改为说明由产品设置页控制）", () => {
  assert.equal(/<input\b/i.test(PANEL), false, "面板不得有 input 控件（避免假开关）");
  assert.equal(/role="switch"/.test(PANEL), false, "面板不得声明 switch 角色");
  assert.equal(/type="checkbox"/.test(PANEL), false, "面板不得有 checkbox");
  assert.match(PANEL, /产品设置页/);
  assert.match(PANEL, /不提供开关/);
  assert.match(PANEL, /<code>userConfig\.enabled<\/code>/, "应指出开关来自清单的 userConfig.enabled");
});

test("界面纪律：没有「清空规则」类按钮，也不做无确认的清空", () => {
  assert.equal(/清空规则|clearRules|清空所有/.test(PANEL), false, "不得有清空规则类按钮");
  // 删规则只能通过编辑 JSON（看得见内容）完成。
  assert.match(PANEL, /不提供「一键删除全部规则」的按钮/);
  // 策略清空必须有二次确认：保存为空且真源非空 → 先显示确认框。
  assert.match(PANEL, /id="confirm-empty-policy"/);
  assert.match(PANEL, /if \(text === "" && current\.trim\(\) !== ""\)/, "空策略保存前必须先确认");
  assert.match(PANEL, /data-action="confirm-empty-policy"/);
});

test("每个 data-action 都有实现（不存在假按钮）", () => {
  const declared = actionNames(PANEL);
  const implemented = implementedActions(PANEL);
  const missing = declared.filter((name) => !implemented.includes(name));
  assert.deepEqual(missing, [], `这些 data-action 没有实现：${missing.join(", ")}`);
  // 反向：实现了却没有任何按钮/控件使用 → 说明是死代码，也要报出来。
  const unused = implemented.filter((name) => !declared.includes(name));
  assert.deepEqual(unused, [], `这些动作没有任何 data-action 使用：${unused.join(", ")}`);
  // 至少覆盖四屏的核心动作（防止动作表被掏空后测试仍然绿）。
  for (const required of [
    "refresh-all",
    "save-rules",
    "save-policy",
    "run-selfcheck",
    "overwrite-agents",
    "request-backfill",
    "confirm-backfill",
  ]) {
    assert.ok(declared.includes(required), `缺少核心动作：${required}`);
  }
});

test("没有内联事件处理器与外部脚本（零依赖、CSP 友好）", () => {
  assert.equal(/\son[a-z]+="/i.test(PANEL), false, "不得使用内联 on* 事件属性");
  assert.equal(/<script[^>]+src=/.test(PANEL), false, "不得引用外部脚本");
  assert.equal(/<link[^>]+href=/.test(PANEL), false, "不得引用外部样式/字体");
  assert.equal(/\bfetch\s*\(/.test(PANEL), false, "面板不得直接 fetch（只能走宿主桥）");
  assert.equal(/XMLHttpRequest/.test(PANEL), false, "面板不得用 XHR");
  assert.equal(/^\s*import\s/m.test(PANEL), false, "面板不得用 ES import（沙箱内无法解析仓库模块）");
});

test("桥接：有 callTool / initialize / resources/read，且用 postMessage + JSON-RPC 2.0", () => {
  assert.match(PANEL, /function callTool\(name, args\)/);
  assert.match(PANEL, /function initialize\(appInfo\)/);
  assert.match(PANEL, /function readResource\(uri\)/);
  assert.match(PANEL, /window\.parent\.postMessage/);
  assert.match(PANEL, /jsonrpc: "2\.0"/);
  assert.match(PANEL, /"ui\/initialize"/);
  assert.match(PANEL, /"ui\/notifications\/initialized"/);
  assert.match(PANEL, /"tools\/call"/);
  assert.match(PANEL, /"resources\/read"/);
  // tools/call 的参数形状必须是 { name, arguments }。
  assert.match(PANEL, /request\("tools\/call", \{ name, arguments: args \|\| \{\} \}\)/);
  // 必须只接受来自宿主窗口的帧。
  assert.match(PANEL, /event\.source !== window\.parent/);
});

test("六个 MCP 工具都在面板里被真实调用", () => {
  for (const tool of [
    "rules_read",
    "rules_write",
    "content_policy_read",
    "content_policy_write",
    "export_agents",
    "selfcheck_run",
  ]) {
    assert.match(PANEL, new RegExp(`callToolData\\("${tool}"`), `面板没有调用 ${tool}`);
  }
});

test("屏 2：规则表五列 + 保存后自动导出与自检", () => {
  for (const column of ["id", "工具", "匹配", "decision", "说明"]) {
    assert.ok(PANEL.includes(`>${column}</th>`), `规则表缺少列：${column}`);
  }
  // 整行说明用专门函数（`td.colSpan = 5` + textContent），不许把 "5" 当单元格文本塞进去。
  // 这条是 v0.3.0 面板真跑抓到的真实 bug（占位行渲染成一个内容为 "5" 的单元格）的回归断言。
  assert.match(PANEL, /function noticeRow\(body, text\)/);
  assert.match(PANEL, /td\.colSpan = 5;/);
  assert.equal(/\["colspan", "5",/.test(PANEL), false, "不许再用 [\"colspan\",\"5\",…] 形式塞说明行");
  const save = PANEL.slice(PANEL.indexOf('"save-rules": async'));
  const body = save.slice(0, save.indexOf('"reload-policy"'));
  assert.match(body, /callToolData\("rules_write"/);
  assert.match(body, /callToolData\("export_agents"/);
  assert.match(body, /callToolData\("selfcheck_run"/);
  // 保存顺序：写入 → 导出 → 自检
  assert.ok(
    body.indexOf('"rules_write"') < body.indexOf('"export_agents"') &&
      body.indexOf('"export_agents"') < body.indexOf('"selfcheck_run"'),
    "保存后应先 rules_write，再 export_agents，再 selfcheck_run",
  );
});

test("屏 3：内容策略默认空，且写「对新会话生效」与用户级范围说明", () => {
  assert.match(PANEL, /<textarea id="policy-editor"[^>]*>/, "策略输入框必须是多行文本域");
  assert.match(PANEL, /<textarea id="policy-editor"[^>]*placeholder="留空表示不写内容策略"/, "默认空");
  assert.match(PANEL, /<strong>保存后对新会话生效<\/strong>/);
  assert.match(PANEL, /<strong>用户级 = 所有工作区、每个会话<\/strong>/);
  assert.match(PANEL, /想让某个项目不同，去那个项目的/);
  const savePolicy = PANEL.slice(PANEL.indexOf('"save-policy": async'));
  assert.match(savePolicy, /content_policy_write/);
  assert.match(savePolicy, /writePolicy\(/);
  const writePolicy = PANEL.slice(PANEL.indexOf("async function writePolicy"));
  assert.match(writePolicy, /callToolData\("content_policy_write"/);
  assert.match(writePolicy, /callToolData\("export_agents"/);
  assert.match(writePolicy, /这次保存对新会话生效/);
});

test("屏 4：自检结果表 + 版本对 + 备份说明", () => {
  for (const column of ["id", "level", "message"]) {
    assert.ok(PANEL.includes(`>${column}</th>`), `自检表缺少列：${column}`);
  }
  assert.match(PANEL, /<tbody id="checks-tbody">/);
  // 版本对三行
  assert.match(PANEL, /面板内置版本/);
  assert.match(PANEL, /自检报告里的插件版本/);
  assert.match(PANEL, /ZCode 版本/);
  assert.match(PANEL, /取不到数字版本时这里明确显示「未知」，不拿它冒充/);
  // 版本对必须说清 hostInfo 不是产品版本号（否则「ZCode 版本」这一行会变成猜测）。
  assert.match(PANEL, /<strong>不是<\/strong>\s*\n?\s*产品版本号|不是[\s\S]{0,20}产品版本号/);
  // 备份说明
  assert.match(PANEL, /卸载本插件<strong>不会还原也不会删除<\/strong> AGENTS\.md/);
  assert.match(PANEL, /要清理请<strong>手动删<\/strong>/);
});

test("手改提示：段不一致时显示醒目提示与两个真实动作 + 二次确认", () => {
  assert.match(PANEL, /id="handedit-banner"/);
  assert.match(PANEL, /AGENTS\.md 段被你手动改过，本次不覆盖；以哪边为准由你决定/);
  // 两个动作都是真实实现（不是占位按钮）
  assert.match(PANEL, /data-action="overwrite-agents"[^>]*>用真源覆盖 AGENTS\.md</);
  assert.match(PANEL, /data-action="request-backfill"[^>]*>从 AGENTS\.md 回填真源</);
  const overwrite = PANEL.slice(PANEL.indexOf('"overwrite-agents": async'));
  assert.match(overwrite.slice(0, 1200), /callToolData\("export_agents"/);
  const backfill = PANEL.slice(PANEL.indexOf('"confirm-backfill": async'));
  assert.match(backfill.slice(0, 1600), /callToolData\("rules_write"/);
  assert.match(backfill.slice(0, 1600), /callToolData\("content_policy_write"/);
  // 二次确认文案：必须说清楚会覆盖真源，且指出次序不可从段里还原
  assert.match(PANEL, /id="confirm-backfill"/);
  assert.match(PANEL, /用 AGENTS\.md 段里的文字覆盖真源/);
  assert.match(PANEL, /原始次序无法从段里还原/);
  // 分支条件：只看 rules-section / policy-section 非 ok
  assert.match(PANEL, /sectionCheck\("rules-section"\)/);
  assert.match(PANEL, /sectionCheck\("policy-section"\)/);
  assert.match(PANEL, /\.filter\(\(check\) => check && check\.level !== "ok"\)/);
  // 无法无损回填时按钮必须禁用（不给半成品）
  assert.match(PANEL, /backfillButton\.disabled = !canBackfill/);
});

test("手改提示：projectRules:false 的「规则段干净缺失」不弹手改横幅", () => {
  // T68（v0.4.2）：export_agents 带 projectRules:false 导出后，AGENTS.md 里没有规则段是预期态。
  // 自检仍如实报 warn（这样"完全没导出"不会被吞掉），但面板不能把它说成"被你手动改过"。
  const source = PANEL.slice(PANEL.indexOf("function renderHandedit"));
  assert.match(source.slice(0, 1200), /rulesCheck\?\.absent === true/);
  assert.match(source.slice(0, 1200), /projectRulesOff/);
  assert.match(source.slice(0, 1400), /if \(hit\.length === 0 \|\| projectRulesOff\)/);
});

test("屏 1：状态徽标显示 规则 N 条 / 策略 空|非空 / 自检 ok|warn|error", () => {
  assert.match(PANEL, /id="badge-rules"/);
  assert.match(PANEL, /id="badge-policy"/);
  assert.match(PANEL, /id="badge-selfcheck"/);
  assert.match(PANEL, /规则：" \+ count \+ " 条"/);
  assert.match(PANEL, /策略：空/);
  assert.match(PANEL, /策略：非空/);
  assert.match(PANEL, /自检：ok/);
  assert.match(PANEL, /自检：warn/);
  assert.match(PANEL, /自检：error/);
});

test("内联脚本语法合法（静态断言抓不到语法错误，这里真解析一遍）", () => {
  const source = inlineScript();
  // 只做编译，不执行：`new vm.Script` 会在语法错误时抛 SyntaxError。
  assert.doesNotThrow(() => new vm.Script(source, { filename: "ui/panel.html#inline" }));
  // 脚本必须声明严格模式与动作表（防止有人把实现搬走但留下按钮）。
  assert.match(source, /^\s*"use strict";/m);
  assert.match(source, /const ACTIONS = \{/);
});

test("内联脚本里的动作表键集与 HTML 的 data-action 集一致（编译后仍一致）", () => {
  const source = inlineScript();
  const scriptActions = [
    ...new Set([...source.matchAll(/^\s*"([a-z][a-z0-9-]*)":\s*async\s*\(/gm)].map((match) => match[1])),
  ].sort();
  const declared = actionNames(PANEL);
  assert.deepEqual(scriptActions, declared);
});

test("内联桥与 src/mcp/bridge.mjs 的关键常量一致（两份实现不许漂移）", () => {
  const source = inlineScript();
  const bridge = readFileSync(join(REPO_ROOT, "src", "mcp", "bridge.mjs"), "utf8");
  for (const [label, pattern] of [
    ["协议版本", /PROTOCOL_VERSION = "([^"]+)"/],
    ["握手方法", /"ui\/initialize"/],
    ["握手通知", /"ui\/notifications\/initialized"/],
    ["工具方法", /"tools\/call"/],
    ["资源方法", /"resources\/read"/],
    ["帧版本", /jsonrpc: "2\.0"/],
  ]) {
    const inBridge = bridge.match(pattern);
    const inPanel = source.match(pattern);
    assert.ok(inBridge, `bridge.mjs 缺少 ${label}`);
    assert.ok(inPanel, `面板缺少 ${label}`);
    assert.equal(inPanel[1] ?? inPanel[0], inBridge[1] ?? inBridge[0], `${label} 两份实现不一致`);
  }
  // 版本号的一致性由「面板版本字样」与 bridge 的默认 appInfo 各自断言：面板必须把 PANEL_VERSION 传进去。
  assert.match(source, /Bridge\.initialize\(\{ name: "zcode-rules-panel", version: PANEL_VERSION \}\)/);
});

test("未连接时不展示任何示例数据（不伪造状态）", () => {
  assert.match(PANEL, /id="connect-error"/);
  assert.match(PANEL, /没有收到宿主（ZCode）的握手回包/);
  assert.match(PANEL, /"规则：未连接"/, "未连接时徽标必须写未连接，而不是编一个状态");
  assert.match(PANEL, /function disabledWhenOffline\(\)/);
  assert.match(PANEL, /button\.disabled = !state\.connected/);
});

test("工具被拒绝时徽标写「读取被拒绝」并显示原因（不留在「待读取」）", () => {
  assert.match(PANEL, /state\.errors\.rules_read/);
  assert.match(PANEL, /"规则：读取被拒绝"/);
  assert.match(PANEL, /"策略：读取被拒绝"/);
  assert.match(PANEL, /"自检：无法运行"/);
  assert.match(PANEL, /id="read-errors"/);
  assert.match(PANEL, /tool \+ " 被拒绝：" \+ state\.errors\[tool\]/);
  // 成功读取时必须把错误清掉，否则旧错误会永远挂在屏 1。
  assert.match(PANEL, /state\.errors = \{\};/);
});
