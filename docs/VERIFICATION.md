# 验证记录

这份文档回答一个问题：**凭什么信这个插件真的在拦截？**

每条结论都给了验证方式。标「运行期」的，是在真实 ZCode 桌面版上跑出来的，不是在模拟环境里。想自己复跑，按 [`REPRODUCE.md`](REPRODUCE.md) 的入口走；判据是否逐条满足，见 [`DOD.md`](DOD.md)。

## 怎么读这份文档

三条线分开看，别混：

- **机制事实** —— 产品本来就怎么工作。可复现，不依赖本插件。
- **契约边界** —— 产品**不会**替你做什么。这是使用时的注意事项，不是 bug。
- **本项目做了什么验证** —— 验证方式 + 结论 + 哪里没覆盖。

## 一、核心结论：hook 的判定真的生效

这是整份文档唯一重要的结论。其余都是它的支撑材料。

### 怎么证明的

难点在于：光看「命令执行了」证明不了什么，因为客户端本来也可能放行。所以必须做**对照组**。

做法是故意让客户端**延迟 8 秒**再回答 `deny`。如果命令仍然执行了，那这个执行决定只可能来自 hook。

| 场景 | 客户端怎么答 | 命令结果 | 说明 |
| --- | --- | --- | --- |
| 规则 = `allow` | 延迟 8 秒后答 `deny` | **执行了** | 决策来自 hook |
| 规则 = `deny` | 延迟 8 秒后答 `deny` | 被拦截 | 两边都拒，不构成证明 |
| 规则为空（`abstain`） | 延迟 8 秒后答 `deny` | 按 ZCode 原逻辑，最终被拒 | hook 交回决定权 |
| **对照组**：规则 = `allow`，但**禁用插件** | 延迟 8 秒后答 `deny` | **不执行**（19 次权限请求全走客户端） | 差异只能由 hook 造成 |

**结论**：同样是 `allow` 配置，插件启用时命令执行、插件禁用时不执行。这个差异只能归因于 hook——不是相关，是因果。

日志里能看到归因：`tool.permission.resolved` 事件的 `reason` 字段为 `Allowed by PermissionRequest hook`。

## 二、支撑这个结论的三条产品机制

### 1. `PermissionRequest` 事件在运行期真实存在

在协议面（`zcode app-server`）能稳定触发 `interaction/requestPermission` 反请求，实测每次会话 1–4 次。这是 hook 的竞速点——只有这个事件发生，hook 才会被调用。

**为什么重要**：如果产品根本不发这个事件，hook 写得再对也不会被调用。

### 2. hook 与客户端应答是并行竞速，先给出决定者胜

产品在判权限时，**同时**等两件事：客户端应答，和 hook 的裁决。谁先给出决定就用谁。

**为什么重要**：这解释了三件事——
- 为什么 hook 快就能抢在客户端前面（延迟 8 秒的实验正是利用这一点）
- 为什么空规则时行为与未装一致（hook 弃权，没有参与竞速）
- 为什么 `-p` 无人值守面不覆盖（没有客户端应答，竞速规则不同）

### 3. 空规则 = 零行为变化

规则集为空时，hook 输出显式 abstain：

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest"},
 "systemMessage":"zcode-rules: abstain (no rule matched, unmatched=abstain (产品原行为))"}
```

注意输出里**没有 `decision` 字段**——这是有意设计：合法 JSON、但不表态。产品侧解析后得到「无决定」，于是继续按原逻辑走。

**为什么不干脆输出空**：空 stdout 或非法 JSON 与「静默失效」无法区分。显式 abstain 让日志上能分清「作者主动弃权」和「故障了」。

## 三、面板链路在真实宿主里验证过

> 验证方式：用户在真实 ZCode 桌面上操作 + 5 张截图留档。

面板四屏（状态 / 规则表 / 内容策略 / 自检与版本）在真实宿主中全部渲染正常，且：

- 状态屏的「本次操作」列出了三条**真实 MCP 调用**：`rules_read`、`content_policy_read`、`selfcheck_run`。说明面板不是静态页面，数据真从插件来。
- 面板**没有假开关**：总开关区域明确写「本面板不提供开关，也读不到它当前是开还是关（MCP 工具没有暴露这一项），所以这里不显示任何开关控件，也不替产品猜一个状态」。
- 面板**不提供一键清空**：删规则要求改 JSON 空数组再保存，让你看见内容再确认一次。
- 面板**如实说明卸载行为**：「卸载本插件不会还原也不会删除 `AGENTS.md`」。
- 宿主版本取不到时显示「未知」并解释原因，不拿字符串冒充版本号。

**覆盖缺口**：这次验证依赖人工操作截图，**没有自动化驱动**。`mcp/uiOpenInstance` 需要 `ownerWebContentsId`，只有真 GUI 渲染进程能提供，自动化路径没打通。

## 四、手改 `AGENTS.md` 不会被静默覆盖

> 验证方式：手工改段内文字 → 跑自检 → 观察文件是否被改。

产品行为：自检报 `policy-section = warn`（提示「可能被手改，或策略改了没重新导出」），但**文件字节没变**。

面板顶部因此出现两个按钮，由用户决定以哪边为准：「用真源覆盖 `AGENTS.md`」或「从 `AGENTS.md` 回填真源」。点前者后，文件逐字节回到基线，自检转 `ok`。

**为什么这个设计重要**：如果插件自动覆盖，用户手写的内容会无声消失。宁可不作为，也不静默破坏。

## 五、卸载闭环

> 验证方式：装 v0.3.0 → 写规则与策略 → 执行卸载 → 检查四处是否清净。

| 检查点 | 结果 |
| --- | --- |
| cache 目录下该插件的文件 | 清空 |
| `installed_plugins.json` | 无该 id |
| `enabledPlugins` | 无该 id |
| `export-agents --uninstall` 回退 | 逐字节回到装前状态 |

**两条边界必须知道**：

1. **产品卸载不摘 `AGENTS.md` 的段**。卸载只清插件自身注册，两段文字还留着，继续注入模型上下文。要清得自己删。
2. **`export-agents --uninstall` 必须带 `--state`**。它需要知道原始状态才能精确回退；不带就 `exit 2`（fail-closed，不静默做半套还原）。

## 六、升级语义

> 验证方式：v0.4.0 → v0.4.1 真实升级（带实质代码变更：新增第九项自检 `data-dir`）。

| 检查点 | 结果 |
| --- | --- |
| 真源保留 | `rules.json` 与 `content-policy.json` **字节不变** |
| 投影幂等 | 重投影后 `AGENTS.md` 的 sha 不变 |
| 产物零改动 | 1433 个文件逐个（相对路径 + size + mtimeMs）聚合摘要，升级前后完全一致 |
| hook 仍工作 | 升级后 hook 入口照常输出 |

**关键语义**：`plugins install` 对已装的同 id 插件是**原地升级**，数据目录不动。「卸载会删数据」是 **uninstall** 的语义——两者不能混。

## 七、四条使用时的契约边界

这四条**不是 bug**，是产品本来的设计。用之前必须知道。

| # | 边界 | 含义 |
| --- | --- | --- |
| 1 | **产品卸载不摘 `AGENTS.md` 的段** | 卸载只清三处注册。段还留着，内容继续注入模型上下文 ⇒ 需手工删 |
| 2 | **`--uninstall` 必须带 `--state`** | 首次导出要带 `--state install-state.json`（记录原始 sha）。不带则 `exit 2` |
| 3 | **`rules_write` 会规范化写回** | 补 `description: ""`、键序按 schema 排序 ⇒「恢复空规则」是**语义等价**，不是字节相等 |
| 4 | **内容策略对新会话生效** | `AGENTS.md` 是会话开始时的上下文，当前会话已加载的文字不会因此改变 |

## 八、自检十项

面板「自检与版本」→「运行检查」跑的就是这十项。全部只读，不写任何文件。

| 项 | 查什么 |
| --- | --- |
| `data-dir` | 数据目录存在、可读 |
| `projection-mode` | 当前投影模式（配置关闭时，`AGENTS.md` 没有规则段属于预期态） |
| `rules-valid` | 规则源合法（schema 校验通过） |
| `policy-state` | 内容策略是空还是非空 |
| `config-no-manual-hooks` | 没有手工接线 `PermissionRequest`（避免与插件冲突） |
| `agents-exists` | `AGENTS.md` 存在 |
| `agents-size` | 尺寸 ≤ 90 KiB |
| `rules-section` | `zcode-rules` 段与规则源投影一致 |
| `policy-section` | `zcode-content-policy` 段与内容策略投影一致 |
| `version` | 插件版本一致 |

**三态可区分**：正常时 `errors=0`；手改了段内内容会出 `warn`；规则源非法会出 `error` 且 `summary.errors ≥ 1`。`projection-mode` 永远是 `info`；配置关闭投影时 `rules-section` 降级为 `info`（预期态），配置开启却没导出时仍是 `warn`。

## 九、CI 是回归防线，不是运行期证据

CI（GitHub Actions，**三平台矩阵**：ubuntu / macos / windows，各 Node 24）跑三步：

```pwsh
node scripts/verify-fidelity.mjs   # 4 个参照实现逐字节 + 副本 ≡ 原件
node scripts/check-docs.mjs        # 文档相对链接与仓库内路径
node --test tests/                 # 197 例
```

三步都 exit 0。**没有一个 `npm install` 步骤**——这是刻意的，装了反而引入供应链面和失败源。

**CI 能证明什么、不能证明什么**：它能证明「代码没退化、文档没断链、参照实现没被改」。它**不能**证明 hook 在真实环境生效——那需要真的 ZCode 桌面版和真的会话，只能在本地跑。

## 十、v0.4.3：投影规则段的真实 GUI 验证

「投影规则段」这个开关（产品 `userConfig.projectRules`，控制规则段要不要投影进 `AGENTS.md`）在发布后做过一次**真实 GUI 端到端**验证——不是在 CI 里跑，也不是在隔离环境里模拟 env，而是走产品自己的配置链路。

**操作（人工，真实 ZCode 桌面 3.16.3 + 插件 0.4.3）**：设置 → 插件 → 已安装 → ZCode 规则 → 配置 → 关闭「投影规则段」→ 保存配置 → 重启 ZCode → 在面板里保存 7 条规则与内容策略。

**结果**：

| 检查点 | 观测值 |
| --- | --- |
| 开关落盘位置 | `config.json` 的 `plugins.options` 中该插件 = `{ "projectRules": false }` |
| `AGENTS.md` | 4203 B |
| 规则段 | `BEGIN zcode-rules` **不存在** |
| 内容策略段 | `BEGIN zcode-content-policy` 存在 |
| 规则 id 残留 | 0 处 |
| 自检 | `ok=true`、`errors=0`、`warnings=0`；`projection-mode`=关闭（info）、`rules-section`=info（预期态）、`policy-section`=ok、`version`=v0.4.3 |
| hook 判定（读 `rules.json`） | `git status` → allow；`rm -rf` → deny；未命中 → abstain |

**这条链路为什么可信**：值不是插件自己存的，而是 ① manifest 的 `userConfig.projectRules`（详情页「配置」里的原生开关）→ ② 产品写 `config.json` 的 `plugins.options` → ③ 产品按 manifest 的 `${user_config.projectRules}` 注入 MCP server 的 `env` → ④ `../src/mcp/server.mjs` 解析成 boolean，并作为**显式参数**传给纯函数（`exportAgents` / `runSelfcheck`）。发布前另在隔离环境做过同类验证（模拟产品注入的 env）：51 条断言全过、真实 home 指纹零差异。

**局限**：需要人工在 GUI 里关开关并重启，无法进 CI 自动化——与下面「面板验证无法自动重跑」属于同一类缺口。

## 十一、这个插件没覆盖的范围

分两类，别混。第一类是**产品能力所不及**（不是插件缺陷），第二类是**本项目没做到的**（验证缺口）。

### 能力所不及（产品边界）

- **`guarded` 档位**：该档位下危险命令绕过 hook，规则不生效。
- **`-p` 无人值守面**：没有权限客户端时，hook 会被竞速取消。
- **GUI 弹窗路径**：本结论在 Host↔CLI 协议面成立。GUI 是另一种客户端实现，走同一套竞速路径，但没有单独验证。
- **内容策略不是沙箱**：它只是给模型读的提示文本。真正强制拦截的是 hook 的 allow/deny。想让某类命令绝对跑不了，写规则，别指望提示词。

### 本项目没做到（验证缺口）

- **macOS / Linux 的完整安装剧本只在 Windows 实机跑过**。其他两平台靠 CI 间接验证（CI 跑的是保真 + 文档 + 单测，不是安装剧本）。
- **面板验证无法自动重跑**。靠人工操作截图，CDP 自动化路径没打通。
- **只有中文界面**，没测过非中文环境下的显示。

要自己复跑上面这些判据，按 [`REPRODUCE.md`](REPRODUCE.md) 的入口走；判据是否满足的逐条核销见 [`DOD.md`](DOD.md)。
