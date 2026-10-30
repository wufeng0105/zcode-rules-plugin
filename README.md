> **空规则 + 空策略 = 零行为变化**：不写任何规则、不写任何内容策略时，本插件不改变 ZCode 的默认行为——未命中一律 abstain（退赛），权限判定仍由产品原逻辑完成，AGENTS.md 里只有两个空段。
>
> **缺规则时使用内置空规则（abstain）**：数据目录还没有 `rules.json` 时，hook 入口使用插件内置的 `rules.default.json`（unmatched=abstain），不会 deny，也不创建/写任何文件；非法规则仍按 `onTimeout=deny` fail-closed。

# zcode-rules-plugin

一句话定位：把「一份规则源、两个出口」做成 ZCode 插件——同一个规则 JSON 既供 `PermissionRequest` hook 判 allow/deny/退赛，又投影成 `AGENTS.md` 里给人读的规则段；内容策略以自由文本形式走同一套双哨兵投影。

## 当前状态（v0.3.0，面板四屏 + 手改提示）

- **可安装插件壳**：`.zcode-plugin/plugin.json` 声明 `hooks`（PermissionRequest 判定）、`mcpServers`（零依赖 stdio 数据通道）、`ui.surfaces`（面板入口）与 `userConfig`。
- **hook 入口兜底**：hook 命令指向 `src/hooks/permission-rules-entry.mjs`；`<data>/rules.json` 存在就用它，缺则用仓库根 `rules.default.json`（内置空规则），两者皆缺或 launcher 自身异常也输出显式 abstain——首次安装不会因缺少规则而走看门狗 deny（v0.2.1）。
- **数据面**：`src/mcp/server.mjs` 是换行分隔 JSON-RPC 2.0 的 stdio MCP server，提供 6 个工具与 1 个 UI 资源；数据目录只认宿主注入的 `ZCODE_RULES_DATA` / `ZCODE_PLUGIN_DATA`，缺失时所有工具调用 fail-closed（不猜路径）。
- **双哨兵投影**：`src/rules/sections.mjs` 提供通用命名哨兵段引擎；`zcode-rules` 段哨兵**从 `rules-engine.mjs` import**，与既有投影逐字兼容；`zcode-content-policy` 段承载自由文本。
- **自检**：规则合法性、策略空/非空、两段投影是否被手改、AGENTS.md 尺寸 >90 KiB 预警、版本号一致性、config 无手工 `PermissionRequest` 接线（A 路线残留检查）。
- **面板（v0.3.0）**：`ui/panel.html` 是**四屏可用面板**（状态 / 规则表 / 内容策略 / 自检与版本），经 `src/mcp/bridge.mjs` 同一套 JSON-RPC over postMessage 调自家 6 个工具；不含假按钮、假开关、无确认的清空，也不写「立即生效」。
- 机制验证、运行期判据与证据仍以 ZCode 检出 `docs/zcode-mod/` 为准（selfcheck、gates、evidence、plan 均在那里）；ZCode 检出对本仓库而言**只读**，本仓库不回改它。

## 目录

```
.zcode-plugin/
  plugin.json             # v0.3.0 清单：hooks + mcpServers + ui.surfaces + userConfig
rules.default.json        # v0.2.1：内置空规则（数据目录无 rules.json 时使用，写操作零副作用）
src/
  rules/
    rules-engine.mjs      # 校验 / 判定 / AGENTS.md 段投影 / 一致性自检（参照实现，逐字节保真）
    agents-section.mjs    # 段的定位、幂等 upsert、按 meta 或哨兵摘除（参照实现，逐字节保真）
    export-agents.mjs     # 导出与卸载 CLI（参照实现，逐字节保真）
    sections.mjs          # 命名哨兵双段引擎（v0.2.0 新增：locate/upsert/remove/snapshot）
  hooks/
    permission-rules.mjs  # PermissionRequest hook：allow / deny / abstain 三态 + 看门狗（参照实现，逐字节保真）
    permission-rules-entry.mjs # v0.2.1：入口 launcher（数据规则 → 内置空规则 → abstain；委托参考 hook）
  mcp/
    operations.mjs        # 数据面：规则/策略读写校验、双哨兵导出、自检、面板渲染
    server.mjs            # 零依赖 stdio MCP server（JSON-RPC 2.0，换行分隔）
    bridge.mjs            # v0.3.0：面板侧 JSON-RPC over postMessage 最小客户端（零依赖、可单测）
    agents-backfill.mjs   # v0.3.0：从 AGENTS.md 哨兵段无损反解真源（手改提示的「回填」用）
ui/
  panel.html              # v0.3.0：四屏面板（状态 / 规则表 / 内容策略 / 自检与版本）
tests/
  rules-engine.test.mjs
  agents-section.test.mjs
  sections.test.mjs       # v0.2.0 新增
  operations.test.mjs     # v0.2.0 新增；v0.2.1 追加 config 接线/内置空规则用例；v0.3.0 改 renderPanelHtml 口径
  mcp-server.test.mjs     # v0.2.0 新增（spawn 真进程跑协议往返）
  entry.test.mjs          # v0.2.1 新增（hook 入口 launcher 端到端）
  panel.test.mjs          # v0.3.0 新增（面板静态断言：四屏/禁项/桥接/手改提示）
  bridge.test.mjs         # v0.3.0 新增（JSON-RPC 帧序列化与解析，假 postMessage target）
  agents-backfill.test.mjs # v0.3.0 新增（段 → 真源无损反解）
  index.js                # 目录参数兼容入口（Node 21–24.20）
```

## 安装与验证

插件以目录市场（directory source）安装；安装会复制到 ZCode 的插件缓存，并用 `ZCODE_PLUGIN_DATA` 指向持久数据目录。实验一律在隔离 home 中进行（见 ZCode 检出 `docs/zcode-mod/isolation/RECIPE.md`），不要直接对真实 home 跑装/卸。

```pwsh
# <CLI> = C:\Program Files\ZCode\resources\glm\zcode.cjs
node <CLI> plugins validate <本仓库路径>       # 期望：Plugin manifest is valid（exit 0）
node <CLI> plugins marketplace add <市场目录>   # marketplace.json 条目 source 用 directory 源
node <CLI> plugins install zcode-rules@<市场名>
node <CLI> plugins list --verbose               # 期望含 hooks: 1 与 mcp: plugin:zcode-rules:zcode-rules
node <CLI> plugins uninstall zcode-rules@<市场名> --force
```

数据结构（由宿主注入的数据目录）：

| 文件 | 形态 | 说明 |
| --- | --- | --- |
| `rules.json` | JSON | 规则源（`version` / `name` / `unmatched` / `onTimeout` / `watchdogMs` / `rules[]`）；写入前经 `validateRules`，非法拒绝写入 |
| `content-policy.json` | JSON | `{ "version": 1, "text": "..." }`；`text` 为自由文本，默认空 |
| `AGENTS.md` | 文本 | 用户级 `~/.zcode/AGENTS.md`；只维护两个命名段，段外内容不动 |

hook 入口的规则选择：`<data>/rules.json` 存在 → 用它；否则 `${ZCODE_PLUGIN_ROOT}/rules.default.json`（内置空规则）；两者皆缺 → 直接输出合法 abstain（exit 0，无 decision）。入口不创建/不写任何文件；非法规则仍交给参考 hook 按 `onTimeout=deny` fail-closed。

`userConfig`：`enabled`（boolean，默认 true）、`watchdogSeconds`（number，默认 120；当前 hook 命令固定 `--watchdog-ms 120000`，本项供面板与后续版本读取）。

## MCP 数据面

工具（每个写操作只回动作摘要，不回传全文大对象）：

| 工具 | 作用 |
| --- | --- |
| `rules_read` | 读规则；缺省返回 `exists=false`，不是错误 |
| `rules_write` | 校验并写规则；非法规则 `isError=true` 且不产生/不覆盖文件 |
| `content_policy_read` | 读自由文本内容策略（缺省空串） |
| `content_policy_write` | 写自由文本内容策略（空串 = 无策略） |
| `export_agents` | 双哨兵投影到 `AGENTS.md`；缺文件则创建只含两段的文件；返回动作/尺寸/哈希摘要 |
| `selfcheck_run` | 只读自检：规则、策略、两段一致性（手改提示）、>90 KiB 预警、版本号、config 无手工 `PermissionRequest` 接线；`rules.json` 缺失时给出「使用内置空规则」info |

资源：`ui://zcode-rules/panel.html`（`text/html;profile=mcp-app`，返回 `ui/panel.html` 原文）。

**fail-closed**：`ZCODE_RULES_DATA`（或等价 `ZCODE_PLUGIN_DATA`）缺失时，任何工具调用返回 JSON-RPC error（-32002），不猜目录、不落盘；`AGENTS.md` 默认 `os.homedir()/.zcode/AGENTS.md`（用户级），工具支持 `agentsPath` 覆盖（测试用）。

## 双哨兵投影

`AGENTS.md` 里只有两个由本插件维护的段：

```text
<!-- BEGIN zcode-rules (generated from JSON, DO NOT EDIT) -->   ← 哨兵 import 自 rules-engine.mjs
...
<!-- END zcode-rules -->

<!-- BEGIN zcode-content-policy (free text, DO NOT EDIT) -->
...
<!-- END zcode-content-policy -->
```

- **段外字节不动**：追加/替换只影响段内；替换保留段后原行尾形态（CRLF/LF）。
- **幂等**：同输入二次导出字节完全相同。
- **删除只摘段**：哨兵残缺/乱序/重复一律 `refused`，绝不盲删。
- **不伪造内容**：文件不存在时只生成两个哨兵段，不写任何头部或默认指令。
- `zcode-rules` 段与 `renderAgentsSection()` 输出逐字符一致（单测断言），因此 `rules-engine.consistencyCheck` 仍然成立。

## 面板（v0.3.0）

`ui/panel.html` 是四屏面板，单文件、零依赖、纯内联 JS（沙箱 iframe 里无法 import 仓库模块）。四个分区各有单一职责，用顶部 tab 切换：

| 屏 | 内容 | 用到的工具 |
| --- | --- | --- |
| 状态 | 启用态说明（开关归产品设置页，**面板不提供开关**）+ 徽标「规则 N 条 / 策略 空\|非空 / 自检 ok\|warn\|error」 | `rules_read` / `content_policy_read` / `selfcheck_run` |
| 规则表 | 表格（id / 工具 / 匹配 / decision / 说明）+ 编辑 JSON 文本域 | `rules_read` / `rules_write` → `export_agents` → `selfcheck_run` |
| 内容策略 | 多行文本域（默认空）；写「**对新会话生效**」与「用户级 = 所有工作区、每个会话」 | `content_policy_write` + `export_agents` |
| 自检与版本 | 结果表（id / level / message）+ 版本对 + 备份说明 | `selfcheck_run` |

**手改提示（P-6 用户路径）**：自检的 `rules-section` / `policy-section` 任一条不是 `ok` 时，屏 4 顶部出现提示「AGENTS.md 段被你手动改过，本次不覆盖；以哪边为准由你决定」，并给两个**真实**动作：

- **用真源覆盖 AGENTS.md** → `export_agents`（真源赢）。
- **从 AGENTS.md 回填真源** → `src/mcp/agents-backfill.mjs` 反解段内容 → `rules_write` / `content_policy_write` → 重新 `export_agents`（段赢）。必须先过二次确认文案；任一段无法**无损**还原时该按钮禁用，面板不给半成品。

**界面纪律（有测试守）**：只画真实能力、一控件一后果、做不了只给说明。具体禁项与验收点：

- 不出现「立即生效」（`tests/panel.test.mjs` 连「立即」二字一起禁）；策略保存后只写「对新会话生效」。
- 不伪造总开关：面板没有 `input` / `checkbox` / `role="switch"`，只说明开关由产品设置页的 `userConfig.enabled` 控制。
- 不提供「一键清空规则」；删规则只能改 JSON 文本域再保存。清空已有内容策略必须过二次确认框。
- 每个 `data-action` 都必须在动作表里有实现，且动作表里没有无人使用的动作（这条同时防假按钮和死代码）。
- 未收到宿主 `ui/initialize` 回包时，页面不显示任何数值，所有读写按钮禁用。

**回填为什么不重排次序**：`renderAgentsSection` 的投影按 decision 分组渲染（允许 → 询问 → 禁止），组内保序但**跨组次序不可还原**；而 hook 判定是 first-match-wins，次序有语义。所以回填保留当前 `rules.json` 里已有规则的次序，段里新增的 id 追加到末尾，并在确认框里点名「将消失」和「新增」的 id。

### 桥接（`src/mcp/bridge.mjs`）

面板与宿主之间是 JSON-RPC 2.0 over postMessage（与官方 `@modelcontextprotocol/ext-apps` 的 `App` 同形）：

```text
握手   { jsonrpc:"2.0", id, method:"ui/initialize",          params:{ appInfo, appCapabilities, protocolVersion } }
       { jsonrpc:"2.0",             method:"ui/notifications/initialized", params:{} }
工具   { jsonrpc:"2.0", id, method:"tools/call",              params:{ name, arguments } }
资源   { jsonrpc:"2.0", id, method:"resources/read",          params:{ uri } }
```

`bridge.mjs` 是同一份逻辑的**可单测**实现（面板里内联的是它，沙箱内没有 import 通路）：id 配对、超时（`BridgeTimeoutError`）、JSON-RPC 错误（`BridgeError`，保留 code/data）、非法帧忽略、`source` 过滤、`dispose` 作废未完成请求。它不缓存业务、不猜数据目录、不重试。

> 握手方法名是 `ui/initialize`（MCP Apps 的扩展方法），**不是** MCP 协议本身的 `initialize`；宿主侧由官方 `AppBridge` 处理（ZCode 检出 `packages/ui/src/plugin-ui/app/pluginUiHostController.ts`），官方 pdf 面板 0.2.2 的打包产物同样发 `ui/initialize`。

## 测试

```pwsh
# 仓库根目录执行；零依赖、离线可跑（只用 node: 内置模块）
node --test tests/
```

v0.3.0 共 146 个用例：v0.2.1 既有 86 + 新增 60（面板静态断言 19、桥接 21、段反解 20）。新增测试的夹具全部内联或落在 `os.tmpdir()` 临时目录，不读取 ZCode 检出、不读取真实 home、不写临时目录之外的位置。

`tests/panel.test.mjs` 的「每个 `data-action` 都有实现」与「动作表里没有无人使用的动作」是一对反向断言：前者防假按钮，后者防死代码。想加一个按钮就必须同时写实现，否则测试红。同一文件还会把面板的内联脚本**真编译一遍**（`vm.Script`）——正则断言看不出语法错误，编译能。另外它逐项比对面板内联桥与 `src/mcp/bridge.mjs` 的协议常量，防止两份实现悄悄漂移。

> 静态断言证明不了「点了会怎样」。面板的行为面由 ZCode 检出里的独立脚本验证（不随仓库分发，证据见 `.zhll\rt\wp30\panel-live.mjs` 与 `panel-proof.log` §四·B）：headless Chrome 里放一个按 MCP Apps wire 形状回包的假宿主，加载真面板，断言四屏渲染、徽标、规则表、清空确认、手改提示与回填二次确认、切屏、按钮可用性，外加一个 fail-closed 场景（工具回 -32002 时徽标必须写「读取被拒绝」并显示原因），共 37 项。这条在 v0.3.0 里真抓到一个渲染 bug（占位行渲染成内容为 `5` 的单元格）。

> `tests/index.js` 是 Node 21–24.20 的目录参数兼容入口：上游回归（[nodejs/node#64555](https://github.com/nodejs/node/issues/64555)）里 `node --test <目录>` 会把目录当中单个文件执行并 `MODULE_NOT_FOUND`；该文件只按文件名导入全部 `*.test.mjs`，不改变任何测试内容。上游修复后（或 Node 20）它不会被测试发现机制匹配到。

## 来源与保真

`src/` 下四个参照实现是从 ZCode 检出 `docs/zcode-mod/selfcheck/` 原样复制的（**不改一行**，v0.3.0 仍然逐字节一致）：

| 本仓库文件 | 来源（ZCode 检出，只读） | sha256 |
| --- | --- | --- |
| `src/rules/rules-engine.mjs` | `docs/zcode-mod/selfcheck/rules/rules-engine.mjs` | `8d28407ec7feecfefc93975d0be5446c59ef64cf4921040acc5556ee293980bb` |
| `src/rules/agents-section.mjs` | `docs/zcode-mod/selfcheck/rules/agents-section.mjs` | `3088e7d0692b5703dc8ee77107f6c4eb32a5c01569c076992b417ae1ca4d599f` |
| `src/rules/export-agents.mjs` | `docs/zcode-mod/selfcheck/rules/export-agents.mjs` | `22f4a0c0a71e8cdbe912b614da0c286a0a3e3f0973dbfdf9ea068a017781b51a` |
| `src/hooks/permission-rules.mjs` | `docs/zcode-mod/selfcheck/hooks/permission-rules.mjs` | `a8c2121e6e6118cb506faa3e3842527df50fb866f74aa4f7c12c62fb7e464b23` |

`src/rules/sections.mjs`、`src/mcp/operations.mjs`、`src/mcp/server.mjs`、`src/hooks/permission-rules-entry.mjs`、`src/mcp/bridge.mjs`、`src/mcp/agents-backfill.mjs`、`ui/panel.html` 是 v0.2.0–v0.3.0 新增实现，不属于参照实现，不受上述保真约束。

保真校验（在仓库根执行）：

```pwsh
Get-FileHash -Algorithm SHA256 src\rules\rules-engine.mjs, src\rules\agents-section.mjs, src\rules\export-agents.mjs, src\hooks\permission-rules.mjs
```

## 许可

MIT，见 [LICENSE](LICENSE)。
