# 开发者参考

以下内容面向维护者，普通用户可跳过。

### 当前状态（v0.4.1）

- **可安装插件壳**：`../.zcode-plugin/plugin.json` 声明 `hooks`（PermissionRequest 判定）、`mcpServers`（零依赖 stdio 数据通道）、`ui.surfaces`（面板入口）与 `userConfig`。
- **hook 入口兜底**：hook 命令指向 `../src/hooks/permission-rules-entry.mjs`；`<data>/rules.json` 存在就用它，缺则用仓库根 `../rules.default.json`（内置空规则），两者皆缺或 launcher 自身异常也输出显式 abstain——首次安装不会因缺少规则而走看门狗 deny。
- **数据面**：`../src/mcp/server.mjs` 是换行分隔 JSON-RPC 2.0 的 stdio MCP server，提供 6 个工具与 1 个 UI 资源；数据目录只认宿主注入的 `ZCODE_RULES_DATA` / `ZCODE_PLUGIN_DATA`，缺失时所有工具调用 fail-closed（不猜路径）。
- **哨兵段投影**：`../src/rules/sections.mjs` 提供通用命名哨兵段引擎；`zcode-rules` 段哨兵**从 `rules-engine.mjs` import**，与既有投影逐字兼容；`zcode-content-policy` 段承载自由文本。
- **写入规范化**：`rules_write` 会规范化后写回（补 `description: ""`、键序按 schema 排序）。因此「恢复空规则」后文件字节与原始不同但**语义等价**——判断恢复成功应用语义等价 + 规则集为空 + `AGENTS.md` 投影字节相等。
- **机制验证与运行期判据**的结论已提炼进 [`VERIFICATION.md`](VERIFICATION.md)；判据的复跑入口见 [`REPRODUCE.md`](REPRODUCE.md)。

### 目录

```
.zcode-plugin/
  plugin.json             # 清单：hooks + mcpServers + ui.surfaces + userConfig
rules.default.json        # 内置空规则（数据目录无 rules.json 时使用，写操作零副作用）
src/
  rules/
    rules-engine.mjs      # 校验 / 判定 / AGENTS.md 段投影 / 一致性自检（参照实现，逐字节保真）
    agents-section.mjs    # 段的定位、幂等 upsert、按 meta 或哨兵摘除（参照实现，逐字节保真）
    export-agents.mjs     # 导出与卸载 CLI（参照实现，逐字节保真）
    sections.mjs          # 命名哨兵双段引擎（locate/upsert/remove/snapshot）
  hooks/
    permission-rules.mjs  # PermissionRequest hook：allow / deny / abstain 三态 + 看门狗（参照实现，逐字节保真）
    permission-rules-entry.mjs # 入口 launcher（数据规则 → 内置空规则 → abstain；委托参考 hook）
  mcp/
    operations.mjs        # 数据面：规则/策略读写校验、哨兵段导出、自检、面板渲染
    server.mjs            # 零依赖 stdio MCP server（JSON-RPC 2.0，换行分隔）
    bridge.mjs            # 面板侧 JSON-RPC over postMessage 最小客户端（零依赖、可单测）
    agents-backfill.mjs   # 从 AGENTS.md 哨兵段无损反解真源（手改提示的「回填」用）
ui/
  panel.html              # 四屏面板（状态 / 规则表 / 内容策略 / 自检与版本）
scripts/
  verify-fidelity.mjs     # 4 个参照实现的 sha256 基线校验（fail-closed）
  check-docs.mjs          # 文档相对链接与仓库内路径引用检查（静态、无网络）
  smoke-upgrade.mjs       # P-8 升级模拟（隔离环境）
tests/                    # node --test 零依赖测试
FIDELITY.json             # 4 个参照实现的 sha256 基线
.github/workflows/ci.yml  # CI：verify-fidelity → check-docs → node --test
```

### 数据结构（由宿主注入的数据目录）

| 文件 | 形态 | 说明 |
| --- | --- | --- |
| `rules.json` | JSON | 规则源（`version` / `name` / `unmatched` / `onTimeout` / `watchdogMs` / `rules[]`）；写入前经 `validateRules`，非法拒绝写入 |
| `content-policy.json` | JSON | `{ "version": 1, "text": "..." }`；`text` 为自由文本，默认空 |
| `AGENTS.md` | 文本 | 用户级 `~/.zcode/AGENTS.md`；只维护两个命名段，段外内容不动 |

hook 入口的规则选择：`<data>/rules.json` 存在 → 用它；否则 `${ZCODE_PLUGIN_ROOT}/rules.default.json`（内置空规则）；两者皆缺 → 直接输出合法 abstain（exit 0，无 decision）。入口不创建/不写任何文件；非法规则仍交给参考 hook 按 `onTimeout=deny` fail-closed。

`userConfig`：`enabled`（boolean，默认 true）、`watchdogSeconds`（number，默认 120；当前 hook 命令固定 `--watchdog-ms 120000`，本项供面板与后续版本读取）。

### MCP 数据面

六个工具：`rules_read` / `rules_write` / `content_policy_read` / `content_policy_write` / `export_agents` / `selfcheck_run`，外加 UI 资源 `ui://zcode-rules/panel.html`。

### 面板与桥接

`../ui/panel.html` 是四屏可用面板，经 `../src/mcp/bridge.mjs` 同一套 JSON-RPC over postMessage 调自家 6 个工具；不含假按钮、假开关、无确认的清空，界面也不承诺规则会即时生效。

### 随仓附带的验证工具（`docs/`）

| 目录 | 内容 |
| --- | --- |
| `VERIFICATION.md` | 已在真实环境验证过的结论汇总（hook 决策生效、面板链路、卸载闭环、契约边界） |
| `selfcheck/` | ZCode 自带验证脚本的**逐字节参照副本** + `selfcheck.mjs`（九项自检的独立实现）；`rules/` 与 `hooks/` 下的文件与 `src/` 内同名文件逐字节相同（`verify-fidelity` 保证） |
| `isolation/` | 隔离配方 `RECIPE.md` 与工具（`run-with-fingerprint.mjs` 指纹包壳、`fingerprint.mjs` 前后对比、`probe-child.mjs` 探针）。**装/卸类验证请在隔离环境跑，不要直接对真实 home 操作** |
### 测试

```pwsh
# 仓库根目录执行；零依赖、离线可跑（只用 node: 内置模块）
node --test tests/
```

### 来源与保真

`../src/rules/rules-engine.mjs`、`../src/rules/agents-section.mjs`、`../src/rules/export-agents.mjs`、`../src/hooks/permission-rules.mjs` 四个文件是**参照实现**（逐字节保真，源自 ZCode 检出自带的 selfcheck 参照）。校验：

```pwsh
node scripts/verify-fidelity.mjs
```

基线在 `../FIDELITY.json`；脚本 fail-closed（基线缺条目 / 多出清单外条目 / 值非法 / 文件缺失，任一即 exit 1）。

### CI 与本地门禁

CI（`../.github/workflows/ci.yml`）：`ubuntu-latest` + Node 24，三步 `run`——`verify-fidelity` → `check-docs` → `node --test tests/`；**无任何依赖安装步骤**（零依赖，只用 `actions/checkout` + `actions/setup-node`）。

本地等价：

```pwsh
node scripts/verify-fidelity.mjs
node scripts/check-docs.mjs
node --test tests/
```

### P-8 升级模拟（`../scripts/smoke-upgrade.mjs`）

隔离环境跑「装 → 写规则与策略 → 换 version 重装 → 断言真源与投影不变 → 卸载」。脚本自带安全门（`HOME` 必须落在隔离目录下，否则 exit 2），且必须经指纹包壳启动。
