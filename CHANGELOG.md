# CHANGELOG

## 0.2.1（2026-10-30）

hook 入口兜底 + selfcheck「config 无手工接线」（M2 · R1）：

- `rules.default.json`（仓根）：内置空规则（`version:1` / `unmatched:"abstain"` / `onTimeout:"deny"` / `watchdogMs:120000` / `rules:[]`），作为数据目录还没有 `rules.json` 时的兜底内容基线，过 `validateRules`。
- `src/hooks/permission-rules-entry.mjs`：PermissionRequest hook 入口 launcher——同步读全量 stdin；`<data>/rules.json` 存在则用，否则用 `${ZCODE_PLUGIN_ROOT}/rules.default.json`（`--default` 可覆盖，`--data`/`--root` 缺省回退 `ZCODE_PLUGIN_DATA`/`ZCODE_PLUGIN_ROOT`）；两者皆缺 → 输出合法 abstain（无 decision + systemMessage）exit 0；委托参考 hook 时 stdin 原文透传、原样转发 stdout/stderr、继承 0/2 退出码；launcher 自身异常（含委托失败/输出非法 JSON）→ 显式 abstain + stderr + exit 0，不创建/不写任何文件、不持有定时器。
- `.zcode-plugin/plugin.json` v0.2.1：hooks 命令改为 `permission-rules-entry.mjs --data "${ZCODE_PLUGIN_DATA}" --root "${ZCODE_PLUGIN_ROOT}" --watchdog-ms 120000`。
- `src/mcp/operations.mjs`：`runSelfcheck` 新增 `config-no-manual-hooks` 检查——`hooks.events.PermissionRequest` 为非空数组时给 warning（「config 含手工 PermissionRequest 接线（A 路线残留？）」），config 缺失/该键缺省/空数组通过，非法 JSON 给 warning（无法确认）；`rules.json` 缺失时新增 `rules-default` info（使用内置空规则）；新增 `configPath` 参数与 `defaultCliConfigPath()`。
- `src/mcp/server.mjs`：`selfcheck_run` 接受可选 `configPath`（测试/诊断用），默认仍读 `os.homedir()/.zcode/cli/config.json`。
- `ui/panel.html`：版本号更新为 v0.2.1。
- 测试：新增 `tests/entry.test.mjs`（11 例，spawn 真进程覆盖缺规则 abstain / allow / deny 转发 / 非法规则短 watchdog exit 2 / stdin 原文透传 / default 回退与优先级 / 委托失败 fail-safe）；`tests/operations.test.mjs` 追加 5 例（config 有/无手工接线、空数组、非法 JSON、内置空规则 info）；`node --test tests/` 共 86 例全绿。
- 隔离安装冒烟（directory 市场 → validate → install → list --verbose（hooks: 1）→ uninstall --force → 三处清净）通过，真实 home 指纹零差异；证据 `.zhll\rt\wp26\hook-entry-matrix.{mjs,log}`、`.zhll\rt\wp26\smoke-plugin-v0.2.1.log`（ZCode 检出，gitignored）。
- 四个参照实现（`rules-engine.mjs` / `agents-section.mjs` / `export-agents.mjs` / `permission-rules.mjs`）**未改一行**，sha256 与 ZCode 检出全等。

## 0.2.0（2026-10-30）

插件壳与数据面（M2）：

- `.zcode-plugin/plugin.json` v0.2.0 清单：`hooks`（PermissionRequest 判定，命令含 `${ZCODE_PLUGIN_ROOT}` / `${ZCODE_PLUGIN_DATA}` 展开）、`mcpServers`（stdio，零依赖）、`ui.surfaces`（`ui://zcode-rules/panel.html`，session 级）、`userConfig`（`enabled` / `watchdogSeconds`）。
- `src/rules/sections.mjs`：通用命名哨兵双段引擎（`locateNamedSection` / `upsertNamedSection` / `removeNamedSection` / `sectionSnapshot`）。`zcode-rules` 段哨兵从 `rules-engine.mjs` import，与既有投影逐字兼容；`zcode-content-policy` 段承载自由文本；段外字节不动、幂等、保留 CRLF/LF、残缺哨兵 refused。
- `src/mcp/operations.mjs`：数据面（全部显式传路径）——`loadRules` / `saveRules`（`validateRules` 校验，非法拒绝写入）、`loadPolicy` / `savePolicy`、`exportAgents`（双哨兵投影，缺文件创建只含两段的文件）、`runSelfcheck`（规则合法 / 策略空非空 / 两段手改检测 / AGENTS.md >90 KiB 预警 / 版本号）、`renderPanelHtml`。
- `src/mcp/server.mjs`：零依赖换行分隔 JSON-RPC 2.0 stdio MCP server；支持 `initialize`、通知、`ping`、`tools/list`、`tools/call`、`resources/list`、`resources/read`；6 个工具（`rules_read` / `rules_write` / `content_policy_read` / `content_policy_write` / `export_agents` / `selfcheck_run`）+ 1 个 UI 资源；数据目录缺失时工具调用 fail-closed（-32002）。
- `ui/panel.html`：静态占位面板（标题、版本、数据目录与状态说明、「面板四屏在 M3 实现」），无假按钮、无脚本。
- 新增测试 `tests/sections.test.mjs`、`tests/operations.test.mjs`、`tests/mcp-server.test.mjs`（共 41 例，含 spawn server 的协议往返）；`node --test tests/` 共 70 例全绿。
- 更新 `package.json`（0.2.0、`start:mcp` 脚本）、`README.md`（结构/安装/空规则=零行为变化/MCP 数据面/双哨兵）、`CHANGELOG.md`。
- 隔离安装冒烟（directory 市场 → install → list --verbose → uninstall → 三处清净）通过，真实 home 指纹零差异；证据 `.zhll\rt\wp25\smoke-plugin-v0.2.0.log`（ZCode 检出，gitignored）。
- 四个参照实现（`rules-engine.mjs` / `agents-section.mjs` / `export-agents.mjs` / `permission-rules.mjs`）**未改一行**，sha256 与 ZCode 检出全等。

## 0.1.0（2026-10-30）

初始骨架：

- 参照实现逐字节迁入（sha256 与 ZCode 检出 `docs/zcode-mod/selfcheck/` 对应文件全等）：
  - `src/rules/rules-engine.mjs`（规则校验 `validateRules`、hook 判定 `evaluate`、AGENTS.md 段投影 `renderAgentsSection`、单一性自检 `consistencyCheck`、指纹 `fingerprintRules`）
  - `src/rules/agents-section.mjs`（`locateSection` / `upsert` / `removeSection` / `removeSectionBySentinels`，含 UTF-8 字节 vs UTF-16 码元与 `sep` 回退）
  - `src/rules/export-agents.mjs`（导出/卸载 CLI）
  - `src/hooks/permission-rules.mjs`（PermissionRequest hook，三态输出 + 看门狗）
- 首批单元测试（`node:test` + `node:assert/strict`，夹具全部内联，零依赖、离线可跑）：
  - `tests/rules-engine.test.mjs`
  - `tests/agents-section.test.mjs`
- 工程骨架：`package.json`（零运行时依赖）、`README.md`、`LICENSE`（MIT）、`.gitignore`。
- 测试入口 `tests/index.js`：`node --test tests/`（Node 21–24.20 存在目录参数回归 nodejs/node#64555）的兼容入口，仅导入全部 `*.test.mjs`，不改变测试内容。
- 不含：插件壳（`.zcode-plugin/plugin.json`）、面板 UI、MCP 数据通道、内容策略段。机制验证与运行期判据仍留在 ZCode 检出 `docs/zcode-mod/`，按路线图 M2 起迁入本仓库。
