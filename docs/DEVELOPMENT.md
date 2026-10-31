# 开发者参考

给要改这个插件的人看的。只想装上用，看 [README.md](../README.md) 与 [QUICKSTART.md](../QUICKSTART.md) 就够了。

这份文档回答三个问题：**代码分成哪几块、数据怎么流动、哪些地方动了会出问题。**

## 一、先理解数据流

整个插件只做一件事：**把一份规则源，同时供给两个消费者。**

```
                      ┌──────────────────────────┐
                      │   rules.json（规则源）    │  ← 唯一权威
                      │   content-policy.json     │
                      └───────────┬──────────────┘
                                  │
                ┌─────────────────┴─────────────────┐
                │                                   │
        ① hook 直接读                       ② 投影写进 AGENTS.md
                │                                   │
                ▼                                   ▼
      ZCode 判权限那一刻                  <!-- BEGIN zcode-rules … -->
      hook 被调用，返回                   <!-- BEGIN zcode-content-policy … -->
      allow / deny / abstain              模型读会话上下文时看到
                │
                ▼
        命令执行 or 被拦
```

两个消费者走的是**同一个数据源**，这是整个设计的核心。改动时守住这条：**不要让任何一方拥有第二份数据。**

## 二、代码分成哪几块

| 块 | 文件 | 干什么 |
| --- | --- | --- |
| 插件清单 | `../.zcode-plugin/plugin.json` | 声明四样东西：`hooks`（挂 PermissionRequest）、`mcpServers`（stdio 数据通道）、`ui.surfaces`（面板入口）、`userConfig`（那两个原生设置项） |
| hook 入口 | `../src/hooks/permission-rules-entry.mjs` | 启动器。优先读 `<data>/rules.json`；没有就用 `../rules.default.json`（内置空规则）；两者都没有、或启动器自己出错，也输出显式 abstain |
| hook 实现 | `../src/hooks/permission-rules.mjs` | 三态判定 + 看门狗。**参照实现，逐字节保真** |
| 规则引擎 | `../src/rules/rules-engine.mjs` | 校验、判定、`AGENTS.md` 段渲染、一致性自检。**参照实现，逐字节保真** |
| 段引擎 | `../src/rules/agents-section.mjs`、`../src/rules/sections.mjs` | 哨兵段的定位、幂等 upsert、按标记摘除。前者**参照实现，逐字节保真** |
| 导出 CLI | `../src/rules/export-agents.mjs` | 导出与卸载（`--uninstall` 必须带 `--state`）。**参照实现，逐字节保真** |
| MCP 数据面 | `../src/mcp/operations.mjs`、`../src/mcp/server.mjs` | 6 个工具 + 1 个 UI 资源。数据目录只认宿主注入的 `ZCODE_RULES_DATA` / `ZCODE_PLUGIN_DATA`，缺失时**全部 fail-closed**，不猜路径 |
| 面板桥 | `../src/mcp/bridge.mjs` | 面板侧的 JSON-RPC over postMessage 最小客户端。零依赖，可单测 |
| 回填 | `../src/mcp/agents-backfill.mjs` | 从 `AGENTS.md` 的段里反解出规则（手改提示的「从 AGENTS.md 回填真源」用它） |
| 面板 | `../ui/panel.html` | 四屏：状态 / 规则表 / 内容策略 / 自检与版本 |

**「参照实现」是什么意思**：这 4 个文件是从 ZCode 自带的验证脚本原样复制的，**一个字节都不许改**。`../scripts/verify-fidelity.mjs` 会校验它们的 sha256，而且额外校验 `selfcheck/` 下的副本与 `../src/` 下的原件逐字节相同——副本漂移同样会被抓出来。

## 三、目录结构

```
.zcode-plugin/
  plugin.json             # 清单：hooks + mcpServers + ui.surfaces + userConfig
rules.default.json        # 内置空规则（数据目录无 rules.json 时用，写操作零副作用）
src/
  rules/
    rules-engine.mjs      # 校验 / 判定 / 段渲染 / 自检（参照实现）
    agents-section.mjs    # 哨兵段定位、幂等 upsert、摘除（参照实现）
    export-agents.mjs     # 导出与卸载 CLI（参照实现）
    sections.mjs          # 通用命名哨兵段引擎（locate / upsert / remove / snapshot）
  hooks/
    permission-rules.mjs  # 三态判定 + 看门狗（参照实现）
    permission-rules-entry.mjs  # 启动器（数据规则 → 内置空规则 → abstain）
  mcp/
    operations.mjs        # 数据面：读写校验、段导出、自检、面板渲染
    server.mjs            # 零依赖 stdio MCP server（JSON-RPC 2.0，换行分隔）
    bridge.mjs            # 面板侧 postMessage JSON-RPC 客户端
    agents-backfill.mjs   # 从 AGENTS.md 段反解真源
ui/
  panel.html              # 四屏面板
scripts/
  verify-fidelity.mjs     # 4 个参照实现 + 副本一致性（fail-closed）
  check-docs.mjs          # 文档相对链接与仓库内路径检查
  smoke-upgrade.mjs       # 升级冒烟（隔离环境）
  probe-selfcheck.mjs     # 自检探针：打印每项 level/id/message
  proof/                  # 四份判据驱动（路径全环境变量化）
  tools-list-probe.mjs    # stdio MCP server 的可靠探针
tests/                    # 197 例，零依赖
docs/                     # VERIFICATION / DOD / REPRODUCE / DEVELOPMENT / selfcheck / isolation
FIDELITY.json             # 4 个参照实现的 sha256 基线
.github/workflows/ci.yml  # CI：三平台 × 三步
```

## 四、数据结构

数据目录由宿主注入，插件不猜。里面三个文件：

| 文件 | 形态 | 说明 |
| --- | --- | --- |
| `rules.json` | JSON | 规则源。顶层：`version` / `name` / `unmatched` / `onTimeout` / `watchdogMs` / `rules[]`。写入前过 `validateRules`，非法**拒绝写入** |
| `content-policy.json` | JSON | `{ "version": 1, "text": "..." }`。`text` 是自由文本，默认为空 |
| `AGENTS.md` | 文本 | **不在数据目录**，在 `~/.zcode/AGENTS.md`。插件只维护其中两个哨兵段，段外内容不动 |

### 两个字段的语义不能混

这两个是**正交的两件事**，改动时特别容易搞错：

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `unmatched` | `abstain`（默认）/ `deny` | **规则没有命中**时怎么办 |
| `onTimeout` | `deny`（唯一可选） | **已经介入但没能在期限内裁决**时怎么办 |

第一个是「判定完了，没匹配上」，第二个是「还没判定完，超时了」。混淆这两个会导致空规则时行为异常。

### 写入规范化（判断「恢复成功」时别用字节相等）

`rules_write` 会规范化后写回：补 `description: ""`、键序按 schema 排序。

**后果**：「恢复空规则」之后，文件字节与原始**不同**，但语义等价。

**所以判断恢复成功要看三条**：语义等价 + 规则集为空 + `AGENTS.md` 投影字节相等。用字节相等去比 `rules.json` 会一直失败。

### 投影模式归产品配置，不是插件状态（v0.4.3）

「规则段要不要投影进 `AGENTS.md`」是**用户设置**，所以它不落在插件数据目录里，而是走产品自己的配置通道：

```
manifest.userConfig.projectRules      # 声明（产品详情页「配置」里的原生布尔开关）
  → config.json 的 plugins.options["<pluginId>"]
  → 产品按 manifest 的 ${user_config.projectRules} 注入 MCP server 的 env
  → src/mcp/server.mjs 的 resolveProjectRules() 解析成 boolean
  → 作为显式参数传给 exportAgents() / runSelfcheck()
```

两条纪律（改这块时别破坏）：

- **纯函数不读配置**：`operations.mjs` 的 `exportAgents` / `runSelfcheck` 只吃显式参数；env/配置解析只发生在 `server.mjs` 这一层。
- **插件不自建第二份状态**：不要在数据目录造 `projection.json` 之类的文件——那会和产品配置打架（谁是权威说不清）。

默认值是 `true`：不配置时行为与 0.4.2 完全一致；只有注入值明确为 `false` 才关闭（旧版产品不展开 `${user_config.*}` 时会把模板原样传下来，同样退化成 `true`，属安全侧）。

## 五、MCP 数据面

六个工具，面板上每个按钮最终都落到其中一个：

| 工具 | 作用 |
| --- | --- |
| `rules_read` / `rules_write` | 读 / 写规则源（写会规范化） |
| `content_policy_read` / `content_policy_write` | 读 / 写内容策略 |
| `export_agents` | 把两段投影进 `AGENTS.md`。`projectRules:false` 时只投影策略段并摘除规则段；不传时用产品配置 `userConfig.projectRules`（v0.4.3），显式传参只覆盖本次调用。**策略段只能由它投影**——CLI 脚本只管规则段 |
| `selfcheck_run` | 九项自检，只读 |

**数据目录缺失时全部 fail-closed**：不猜路径、不用默认值，直接报错。这是有意的——猜错路径写到别处，比报错更糟。

## 六、面板怎么跟插件通信

`../ui/panel.html` 通过 `../src/mcp/bridge.mjs`，用同一套 JSON-RPC over postMessage 调上面那六个工具。

界面纪律（改动时守住）：

- **不放假按钮**——每个按钮必须落到真实工具调用
- **不放做不到的承诺**——比如不承诺「立即生效」（`AGENTS.md` 是会话开始时的上下文，改了当前会话看不到）
- **「启用开关」不放在面板里**——那个开关由产品的 `userConfig.enabled` 管，MCP 工具没暴露读它，面板也不该替产品猜状态
- **不提供一键清空**——删规则要求改 JSON 空数组再保存，让人看见内容再确认

## 七、本地跑门禁

```pwsh
# 在仓库根目录执行。零依赖、离线可跑，只用 Node 内置模块
node ../scripts/verify-fidelity.mjs     # 注意：本文件在 docs/ 下，路径要带 ../
node ../scripts/check-docs.mjs
node --test ../tests/
```

实际上你在**仓库根**跑更省事（相对路径按仓库根算）：

```pwsh
node scripts/verify-fidelity.mjs
node scripts/check-docs.mjs
node --test tests/
```

CI（`../.github/workflows/ci.yml`）跑的就是这三步，**三平台矩阵**（ubuntu / macos / windows）各 Node 24，**没有任何依赖安装步骤**。

## 八、保真体系

四个「参照实现」的基线存在 [`../FIDELITY.json`](../FIDELITY.json)。校验命令：

```pwsh
node scripts/verify-fidelity.mjs
```

这个脚本 **fail-closed**：基线缺条目、多出清单外条目、值不是合法 sha256、文件缺失或读失败——任一情况都 exit 1。它还额外校验 `docs/selfcheck/` 下的四份副本与 `src/` 原件逐字节相同（副本不在基线里，没有这道检查就会悄悄漂移）。

**不要为了让校验通过而删基线条目**——那等于让校验静默失效。确需更新基线时用 `node scripts/verify-fidelity.mjs --list` 重新生成，并在 PR 里说明原因。

## 九、升级冒烟测试

`../scripts/smoke-upgrade.mjs` 在隔离环境跑一整套：装 → 写规则与策略 → 换 version 重装 → 断言真源与投影都没变 → 卸载。

自带安全门：`HOME` 必须落在隔离目录下，否则 `exit 2`。而且必须经指纹包壳启动：

```pwsh
node docs/isolation/tools/run-with-fingerprint.mjs --label <label> -- node scripts/smoke-upgrade.mjs
```

## 十、改代码前必须知道的四件事

1. **4 个参照实现不许改**。要改行为，改别的地方；这 4 个是保真的基准。
2. **不要造第二份数据源**。规则只能有一份（`rules.json`），策略只能有一份（`content-policy.json`）。投影是视图，不是数据。
3. **`unmatched` 与 `onTimeout` 不能混**。前者管「没命中」，后者管「超时」。混了会让空规则时的行为出错。
4. **判断「恢复成功」用语义等价，不用字节相等**。`rules_write` 会规范化，字节一定变。

## 十一、改动之后

贡献流程与三条红线见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)；安全边界与漏洞报告渠道见 [`../SECURITY.md`](../SECURITY.md)。

改动涉及行为时，记得同步更新 [`VERIFICATION.md`](VERIFICATION.md)（结论）与 [`DOD.md`](DOD.md)（判据）——这两份说的是「验过了什么」，行为变了它们就可能失真。
