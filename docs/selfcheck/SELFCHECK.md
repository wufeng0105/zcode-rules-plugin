# 参照实现与自检脚本

这个目录放的是**参照实现**：一套能独立运行的规则引擎、段引擎、hook 与自检脚本。它们是插件本体（`src/`）的来源，用来回答一个问题：

> 这套机制为什么成立？换个环境还能不能跑通？

**重要：这不是给用户用的。** 用户装插件看 [README.md](../../README.md)；这里是给想验证明白「机制本身对不对」的人看的。

## 目录里有什么

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `rules/rules-engine.mjs` | **参照实现** | 校验、判定、`AGENTS.md` 段渲染、一致性自检 |
| `rules/agents-section.mjs` | **参照实现** | 哨兵段的定位、幂等 upsert、摘除 |
| `rules/export-agents.mjs` | **参照实现** | 导出与卸载 CLI |
| `hooks/permission-rules.mjs` | **参照实现** | 三态判定 + 看门狗 |
| `selfcheck.mjs` | **参照实现** | 一条命令跑完九项自检 |
| `rules/template-empty.json` | 参考数据 | 空模板，安装时不写入 |
| `rules/example-lowrisk.json` | 参考数据 | 语法示例，安装时不写入 |

前五个文件与 `src/` 下的同名文件**逐字节相同**，由 `../../scripts/verify-fidelity.mjs` 保证。注意 `selfcheck.mjs` 例外：它**没有** `src/` 对应物（那九个自检项在插件里由 `../../src/mcp/operations.mjs` 实现），所以它是本目录独有的脚本，不参与副本一致性校验。

## 为什么会有两份

这套代码最初是从 ZCode 自带的验证脚本原样复制的——那套脚本证明了「规则外置 + hook 判定 + 段投影」这个思路可行。复制过来当基准，好处是：

- **改动可以被察觉**：`src/` 下的文件若与基准不同，`verify-fidelity` 直接报错
- **机制可独立验证**：这套参照实现不依赖插件框架，能单独跑

代价是要维护两份副本。所以校验脚本除了比对 sha256 基线，还会比对「副本 ≡ 原件」——副本漂移不会无声发生。

## 九项自检是怎么设计的

插件面板的「运行检查」，底层就是这九项。设计上有三条原则。

### 原则一：`unmatched` 与 `onTimeout` 是正交的两件事

这两个最容易混，混了会让空规则时的行为出错。

| 字段 | 取值 | 什么时候用 |
| --- | --- | --- |
| `unmatched` | `"abstain"`（默认）/ `"deny"` | 规则**判定完了，没匹配上** |
| `onTimeout` | `"deny"`（唯一可选） | **还没判定完，超时了** |

第一个是「判完了，结果是不管」；第二个是「没判完，只能拒」。前者产品行为不变，后者是失败时的兜底。

**为什么 `onTimeout` 只能选 `deny`**：其它语义（比如「超时了就去问人」）依赖 broker 自己提供超时或明确失败机制，而实测 broker 在这条路径上会一直等（`permissionTimeoutMs` 全仓库没有 setter）。把实现不了的选项写进 schema，比不写更糟——用户会以为能用。

### 原则二：三种输出必须可区分

hook 有三种结局，输出形态必须让人从日志上就能分辨：

| 结局 | 输出 | 关键特征 |
| --- | --- | --- |
| `allow` | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` | 有 `decision` |
| `deny` | `{"continue":false,"reason":"…","hookSpecificOutput":{…,"decision":{"behavior":"deny","message":"…"}}}` | 有 `decision` + `continue:false` |
| `abstain` | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest"},"systemMessage":"zcode-rules: abstain(原因)"}` | **合法 JSON，但没有 `decision` 字段** |

`abstain` 那一行是关键：它**故意不表态**。产品侧解析后得到「无决定」，于是继续按原逻辑走——这就是「空规则零行为变化」的实现方式。

**为什么不干脆输出空**：空 stdout 或非法 JSON 与「hook 悄悄坏了」在日志上无法区分。显式 abstain 让审计时能分清「作者主动弃权」和「故障静默失效」。

### 原则三：七条锚点用来检测漂移

自检里有七条锚点，每条对着一个「一旦变了就说明机制被动过」的位置。它们是源码层的断言，不是行为断言。

**为什么需要**：行为测试可能因为巧合通过，锚点不会。改了关键行，锚点立刻报。

## 自检的退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 九项全过 |
| `1` | 有 `error`（规则非法、段结构损坏等） |
| `2` | 环境不可用（源码根不存在、Node 版本过低、规则文件缺失或非法 JSON、`AGENTS.md` 不存在） |

退出码 `2` 与 `1` 分开是有意的：`1` 是「你配置有问题」，`2` 是「环境不满足，没法判」。混在一起会让人误以为自己的规则写错了。

## 不变式（改动时不能破的）

1. **hook 出错必须 fail-closed**。任何未捕获异常都落成 `exit 2` → deny，不能是 `exit 1`（产品侧会当成「非 0 非 2」的失败，行为未定义）。
2. **规则源是唯一权威**。`AGENTS.md` 里的段是投影视图，不是第二份数据。
3. **段外内容一个字不动**。定位靠哨兵标记，只替换标记之间的内容。
4. **恢复空规则后文件字节会变**。`rules_write` 会规范化（补 `description: ""`、键序排序），所以判断恢复成功要用**语义等价**，不能用字节相等。

## 怎么自己跑

```pwsh
# 从仓库根目录
node docs/selfcheck/selfcheck.mjs --root <被测插件根> --data <数据目录> --agents <AGENTS.md 路径>
```

输出每项 `level=… id=… message=…`，最后一行是汇总。

想看每项的具体输出而不想过校验逻辑，用探针：

```pwsh
node scripts/probe-selfcheck.mjs <dataDir> <agentsPath> <configPath>
```

## 这份实现证明了什么、没证明什么

**证明了**：规则外置可行、hook 三态可表达且可区分、段投影幂等、自检能覆盖九项、空规则时行为不变。

**没证明**：
- 面板 GUI 行为（那是插件本体的事，见 [`../VERIFICATION.md`](../VERIFICATION.md)）
- `guarded` 档位与 `-p` 无人值守面（产品能力边界，见 [`../VERIFICATION.md`](../VERIFICATION.md) 第十节）
- macOS / Linux 上的实际行为（CI 三平台绿只是间接证据）

要复跑插件本体的判据，看 [`../REPRODUCE.md`](../REPRODUCE.md)。
