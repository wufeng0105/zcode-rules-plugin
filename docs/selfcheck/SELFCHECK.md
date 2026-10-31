# 件 3 方案：规则外置 + 一条命令自检（SELFCHECK）

> ## ⚠️ 性质声明：本目录全部是「验证用参考实现」，不是交付实现
>
> 边界与件 1（`watchdog/WATCHDOG.md`）统一，用同一张表：
>
> | 维度 | 验证用参考实现（本目录） | 交付实现（未开始，见 `plan/DELIVERY-PLAN.md`） |
> | --- | --- | --- |
> | 目的 | 证明机制成立、判据可判 | 让用户装上就用 |
> | 安装 | 无（实验时手工写隔离 home 的 config.json） | 需 install/uninstall 脚本 |
> | 默认开启 | **否**（模板空规则集；示例无 enabled 字段） | 需用户决定 |
> | 写用户真实配置 | **从不**（只写隔离副本与 `.zhll/` 草稿区） | 会写，需用户授权 |
> | 稳定性承诺 | 无，随判据调整 | 需要 |
> | 升级后维护 | 靠 `selfcheck.mjs` 一条命令自检 | 需写进交付 README 并要求升级后重跑 |
>
> 具体到文件：
> - `rules/rules-engine.mjs`、`rules/export-agents.mjs`、`rules/agents-section.mjs`、`hooks/permission-rules.mjs`、`selfcheck.mjs` → **参考实现**
> - `rules/template-empty.json`（空模板）、`rules/example-lowrisk.json`（语法示例） → **参考数据**，安装时不写入
> - 真正的交付形态（安装路径 / 状态归属 / 卸载还原 / 升级复核）见 `plan/DELIVERY-PLAN.md`
>
> 用户 2026-10-30：「件 3 的产物性质也要标：rules-engine / export-agents / permission-rules 属"参考实现"，界线按件 1 那张表统一写。」

> 阶段三第三份产物（顺序 2 → 1 → 3 的第 3 件）｜执行：Lead｜日期：2026-10-30
> 判据：`plan/STAGE3-BREAKDOWN.md` 件 3 的 J3-1..J3-5 + 用户 2026-10-30 追加的 **J3-6 / J3-7**
> **性质：验证用参考实现 + 方案，不是交付实现**（无安装、无默认开启、不写用户真实配置）

---

## 一、要解决的两件事

1. **规则外置**：hook 判据从"写死在脚本里"抽成可读可改的 JSON 规则源
2. **一条命令自检**：同时回答"上游是否漂移"与"规则投影是否一致"，三态退出码

## 二、规则源单一性（J3-6，用户 Q-14 裁定）

**一份规则源、两个出口**：

```
rules/<name>.json   ← 唯一权威
   ├── 出口 1：hook 判据        → selfcheck/hooks/permission-rules.mjs 读它做 allow/deny/abstain
   └── 出口 2：AGENTS.md 规则段 → rules/export-agents.mjs 投影成人可读文本
                                   （upsert 幂等，带 BEGIN/END 哨兵）
```

**为什么必须这样**（不是设计偏好，是产品事实）：

| 事实 | 位置 | 含义 |
| --- | --- | --- |
| `AGENTS.md` 是**纯文本全文注入** | `adapters/src/context/index.ts:131` `readFirstTextBytes` → `:167` | 产品**不解析**其结构，只把全文塞进提示词。所以 AGENTS.md 段只能是"给模型看的投影"，**不能当配置源** |
| hook 的判据是**代码执行** | `core/src/hooks/configured-runner*.ts` | 真正拦截发生在 hook，不在提示词 |
| 提示词只影响"该怎么做"，不影响"能不能做" | R-22 结论（阶段二） | 两者职责不同，但**规则内容应当同源** |

**冲突处理（用户的裁定）**：
- **规则源是权威**，AGENTS.md 段是它的投影
- **不允许手改两份**：手改投影会被 `selfcheck.mjs` 判红（已实测，见 §五 J3-6）
- 改了规则忘记重新导出也会被判红（已实测）

**导出方式**：
```powershell
# 导出（幂等：有段就替换，无段就追加）
node docs/zcode-mod/selfcheck/rules/export-agents.mjs --rules <rules.json> --agents-md <AGENTS.md>
# 只看将写入什么
node docs/zcode-mod/selfcheck/rules/export-agents.mjs --rules <rules.json> --agents-md <AGENTS.md> --dry-run
```

## 三、规则 schema（用户 Q-13 / Q-15 裁定）

### 关键设计：`unmatched` 与 `onTimeout` 是正交两件事

用户在审阅件 1 时指出：W2 的实际语义是"规则不命中 → 2s → deny"，等于**白名单外的请求自动拒绝**，还改了产品原行为。因此拆成两个字段：

| 字段 | 取值 | 默认 | 语义 |
| --- | --- | --- | --- |
| `unmatched` | `"abstain"` \| `"deny"` | **`"abstain"`** | 规则不命中时怎么办。`abstain` = 显式弃权，**产品行为完全不变**（用户自己决定怎么做） |
| `onTimeout` | `"deny"`（**唯一可选**） | `"deny"` | **已介入但没能及时裁决**时怎么办 |
| `watchdogMs` | 正整数毫秒 | **`120000`（产品值 2 分钟）** | 看门狗期限。件 1 实验用的 2000ms 只是实验值，不是默认 |

**为什么 `onTimeout` 只有 `deny`**：其它语义（如"退回问人"）依赖 broker 自己超时/明确失败，而实测 broker 弃权后**仍会无限等**（`permissionTimeoutMs` 全仓无 setter）。**把不可实现的选项写进 schema 比不写更糟**（用户原话）。等备选 B 或上游补 host 超时后再开。

### 三种输出的显式形态（可区分，不能混淆）

| 判定 | 输出 | 产品侧解释 |
| --- | --- | --- |
| **allow** | `{hookSpecificOutput:{hookEventName, decision:{behavior:"allow"}}}` | 放行 |
| **deny** | `{continue:false, reason, hookSpecificOutput:{..., decision:{behavior:"deny", message}}}` | 拒绝 |
| **abstain** | `{hookSpecificOutput:{hookEventName}, systemMessage:"zcode-rules: abstain (<原因>)"}` | **合法 JSON 但无 decision** → `processHookOutput`（`hooks/output.ts:18-70`）得到 `permissionRequestResult=undefined` → 该 hook 视为"无决定" → 竞速 `return undefined` → broker 继续单边等 ⇒ **产品原行为** |
| **超时** | `process.exit(2)` | `configured-runner-callback.ts:195-224` → `behavior:"deny"` |

**为什么 abstain 必须显式输出而不是"不输出"/"输出非法"**：
- 空 stdout → `parseHookStdout` 返回 `undefined`（`:166-167`）
- 非法 stdout → 返回 `undefined` 或抛错
- 两者的日志形态与"**静默失效**"无法区分（阶段二复核反证①实证：`exit 0` + 非法输出 = 无 `hook.run.failed`、无 warn、`outcome="success"`）

⇒ 只有"**合法 JSON + 无 decision + 带 systemMessage 标记**"能让人从日志上区分"作者主动 abstain"与"故障静默失效"。

### 完整字段

```json
{
  "version": 1,
  "name": "规则集名字（用于日志与 AGENTS.md 段标题）",
  "description": "可选说明",
  "unmatched": "abstain",          // 默认；"deny" 表示不命中即拒
  "onTimeout": "deny",             // 唯一可选值
  "watchdogMs": 120000,            // 默认 2 分钟
  "rules": [
    {
      "id": "唯一标识（审计用，必填且唯一）",
      "tool": "Bash",              // 工具名，或 "*" 任意
      "commandPattern": "^git status$",  // 可选；正则，匹配 toolInput.command
      "decision": "allow",         // allow | deny | ask
      "comment": "为什么这条规则存在（allow 时强烈建议写，审计用）"
    }
  ]
}
```

**求值规则**：`rules` 是**有序数组，first-match-wins**（先命中先用）。`id` 必须唯一，否则校验失败。

**校验**：`validateRules()` 会拦下：version 不对、name 空、unmatched/onTimeout 非法、watchdogMs 非法、rules 非数组、id 重复/空、decision 非法、commandPattern 非法正则、allow 无 comment（警告，不阻断）。

## 四、安全边界交给用户（用户 Q-15 裁定）

**本件只交 schema + 空模板 + 2-3 条示例，不自拟默认放行策略。**

- `rules/template-empty.json`：**空规则集**（`rules: []`），默认不放行任何东西
- `rules/example-lowrisk.json`：4 条示例（2 allow / 1 deny / 1 ask），**明确标注"示例，不是默认策略，请按自己的判断增删"**

**哪些工具默认放行、哪些必须问 = 安全边界 = 只有用户能定。** 本方案不预设。

## 五、一条命令自检（三态 + 单一性）

```powershell
node docs/zcode-mod/selfcheck/selfcheck.mjs
node docs/zcode-mod/selfcheck/selfcheck.mjs --rules <rules.json> --agents-md <AGENTS.md>
```

### 退出码语义

| exit | 含义 | 触发条件 |
| --- | --- | --- |
| **0** | 无漂移 | 7 条锚点全部命中且行号一致；若给了 rules+agents-md，投影也一致 |
| **1** | **漂移 / 投影不一致** | 锚点未命中、行号移位、AGENTS.md 段被手改、改了规则没重新导出 |
| **2** | **环境不可用** | 源码根不存在、node < 20、锚点文件缺失、规则文件不存在/非法 JSON/校验失败、AGENTS.md 不存在 |

**为什么 1 和 2 必须分开**（用户 J3-3 要求）：exit 1 意味着"上游改了，我要重验"，exit 2 意味着"这台机器/这份检出根本没法验"。**混在一起会把人引向错误的处置动作。**

### 7 条锚点（漂移检测）

| id | 文件:行 | 为什么敏感 |
| --- | --- | --- |
| A1-hook-event-names | `contracts/src/hooks/index.ts:7` | 7 个事件名枚举；改名/增删会让 config 里 `PermissionRequest` 失效 |
| A2-runHooks-switch | `core/src/tool/executor/permission-flow.ts:205` | hook 是否参与竞速的**总开关** |
| A3-race-broker-first | `core/src/tool/executor/permission-responder-race.ts:62` | broker 先启动 + claimResponse 语义；决定 hook 有没有窗口 |
| A4-user-once | `core/src/permission/service.ts:144` | `user-once` 范围；决定哪些请求跳过 hook |
| A5-runner-gate | `core/src/runtime/helpers/runtime-tools.ts:95` | runner 启用门；"配了却不跑/没配却在跑"都在这里 |
| A6-permission-timeout-field | `core/src/runtime/types.ts:139` | 无 host 超时的证据锚点；**上游若补了 setter，看门狗策略需重议** |
| A7-no-decision-passthrough | `core/src/hooks/output.ts:18`（只要求存在） | 显式 abstain 的语义基础（无决定 → 空结果） |

> 锚点不是随便挑的：每条都对应一个"变了就会让 R-01 结论失效"的机制点。A6 尤其重要——它是"看门狗为什么必须自己实现"的证据。

## 六、实测结果

见 `evidence/rt-sc-report.md`。摘要：

| 判据 | 结果 |
| --- | --- |
| J3-1 exit 0 无漂移 + 空转不误报 | ✅ |
| J3-2 exit 1 人为漂移必红 | ✅ |
| J3-3 exit 2 环境不可用不误判 | ✅ |
| J3-4 外置版与硬编码版行为等价 | ✅（A/B 组同形） |
| J3-5 规则写错 → exit 2 → deny，不静默放行 | ✅（D 组） |
| **J3-6 规则源单一性** | ✅（导出前红、导出后绿、手改红、改规则不导出红） |
| **J3-7 三态各一份日志** | ✅（exit0 / exit1-red / exit2-envbroken） |

## 七、不变式（从件 1 继承，不可破）

1. **任何异常路径必须 `exit 2`（deny），绝不 `exit 0`**
2. **不要 `unref` 定时器**（否则 exit 0 + 空输出 = 静默丢弃）
3. 规则文件坏了 → 立即 `exit 2` → deny
4. 模块加载失败也必须 `exit 2`（已加 `uncaughtException`/`unhandledRejection` 兜底）
5. abstain 必须是**显式合法 JSON + 无 decision + 带标记**，不能靠"不输出"

## 八、回滚

```powershell
Remove-Item docs\zcode-mod\selfcheck -Recurse -Force
Remove-Item docs\zcode-mod\evidence\rt-sc-* -Force
Remove-Item docs\zcode-mod\evidence\tools\rt-selfcheck -Recurse -Force
Remove-Item .zhll\rt\selfcheck -Recurse -Force
Remove-Item .zhll\rt\selfcheck-behavior -Recurse -Force
```
- 全部新增文件；不安装、不默认开启、不写用户真实配置
- 四组行为实验 + 三态自检均只读真实目录或写隔离副本
