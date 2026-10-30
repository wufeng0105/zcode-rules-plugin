# 验证记录

这份文档汇总本插件在**真实环境**下已通过的验证结论，供使用者与维护者判断可信度。每条都标注验证方式；标「运行期」的都在真实 ZCode 桌面版上跑过。

## 怎么读

- **机制事实**：产品怎么работает的客观事实，可复现。
- **契约边界**：产品**不会**替你做什么 —— 这些是使用时的注意事项，不是 bug。
- **界面纪律**：面板不许出现的东西（假按钮、假开关、做不到的承诺）。

## 一、hook 决策真实生效（核心结论）

> 验证方式：协议客户端（`zcode app-server`）+ **对照组**（禁用插件后同配置不生效）。

规则命中时，hook 的判定**优先于客户端的权限应答**：

| 场景 | 客户端行为 | 结果 | 判定 |
| --- | --- | --- | --- |
| 规则 = allow | 客户端故意延迟 8 秒后答 **deny** | 命令**仍被执行** | 决策来自 hook |
| 规则 = deny | 客户端延迟后答 deny | 命令被拦截 | ✅ |
| 规则为空（abstain） | 客户端延迟后答 deny | 交回 ZCode 原逻辑 | ✅ |
| **对照组**：规则 = allow，但**禁用插件** | 客户端延迟后答 deny | 命令**不执行**（19 次权限请求全走客户端） | 差异只能由 hook 造成 |

⇒ allow 场景里客户端明确答了 deny，命令却执行了；把插件禁用后同样配置不再执行。**这是「hook 决策生效」的唯一因果证明**（不是相关，是差异归因）。

## 二、三个产品机制事实

### 1. `PermissionRequest` 事件在运行期真实存在

在协议客户端面（`zcode app-server`）可稳定触发 `interaction/requestPermission` 反请求（实测每次会话 1–4 次）。这是 hook 的竞速点。

### 2. `runHooks` 与客户端并行

hook 与客户端权限应答**并行**执行，hook 先给出决策即生效。客户端答得快慢不影响 hook 的结论方向。

### 3. 空规则 = 零行为变化

规则集为空时，hook 输出显式 abstain：

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest"},
 "systemMessage":"zcode-rules: abstain (no rule matched, unmatched=abstain (产品原行为))"}
```

与未安装插件的行为完全一致。

## 三、面板链路（真实宿主）

> 验证方式：真实 ZCode 桌面 GUI（Electron）+ 协议面探针。

- **握手成功**：真宿主成功加载并渲染面板（`ui/initialize` 握手无超时）。
- **沙箱可用**：内联脚本正常执行，CSP 未拦截；`window.parent` 消息通道可达。
- **读路径**：面板状态页的「本次操作」显示 `rules_read`（已读真源 0 条）、`content_policy_read`（空策略）、`selfcheck_run`（无 error）三条真实调用。
- **写路径**（等价验证，`rules_write` → `export_agents` → `selfcheck_run`）：
  - 写入 1 条规则 → 磁盘 `rules.json` 变化 → `AGENTS.md` 变化（**段内含新规则 id**）→ 自检 8/8 ok → 恢复后 `AGENTS.md` **逐字节回到基线**。
- **策略写路径**：`content_policy_write` → `export_agents` → 段内含新策略文本 → `policy-state=ok` → 恢复逐字节回基线。
- **按钮真实性**：16 个按钮全部有真实实现，6 个 MCP 工具全部可达；离线时按钮自动禁用；无「立即生效」字样、无「清空规则」按钮。

## 四、P-6：手改 `AGENTS.md` 段不会被静默覆盖

> 验证方式：真数据目录 + 真 `AGENTS.md` 制造手改。

| 步骤 | 观测 |
| --- | --- |
| 基线 | 6715 B，自检 8 项无 error |
| 段内插入一行 | 6770 B |
| **自检** | `rules-section = warn`「段与规则投影不一致：可能被手改，或规则改了没重新导出」；**文件字节未被改动**（未静默覆盖） |
| 点「用真源覆盖」 | `AGENTS.md` **逐字节回到基线**，自检转 `ok` |

⇒ 产品**不替你决定**「以哪边为准」：只报警，修复动作必须你显式点。

## 五、卸载闭环（P-7）

> 验证方式：隔离环境完整循环（装 → 写 → 导出 → 卸载 → 核对）。

- **`export-agents --uninstall` 精确回退**：摘段后 `AGENTS.md` **逐字节回到装前状态**。
- **`--dry-run` 不写文件**：打印计划，文件 sha 不变。
- **幂等**：连续两次 `--uninstall`，第二次不改变文件。
- **产品卸载三处清净**：`cache/` 下该插件文件数 0、`installed_plugins.json` 无该 id、`enabledPlugins` 无该 id。

## 六、升级语义

> 验证方式：真实 home 升级 + 隔离环境模拟。

- **同 id 重装 = 原地升级**：插件数据目录（你的规则与策略）**不动**。
- **卸载会删数据目录** ⇒ **不要先卸载再装**，那会丢规则与策略。
- **旧版本缓存目录不自动清**（换过版本的机器上会残留旧版本目录）。

## 七、四条契约边界（使用时必读）

| # | 边界 | 含义 |
| --- | --- | --- |
| 1 | **产品卸载不摘 `AGENTS.md` 的段** | 卸载只清三处注册。段还在，内容就还会注入模型上下文 ⇒ 需手工删段 |
| 2 | **`--uninstall` 必须带 `--state`** | 首次导出要带 `--state install-state.json`（记录原始 sha）。不带则 **exit 2**（fail-closed，不静默部分还原） |
| 3 | **`rules_write` 会规范化写回** | 补 `description: ""`、键序按 schema 排序 ⇒「恢复空规则」是**语义等价**，不是字节相等 |
| 4 | **内容策略对新会话生效** | `AGENTS.md` 是会话开始时的上下文，当前会话已加载的文字不会因此改变 |

## 八、自检八项

面板「运行检查」覆盖：

`rules-valid`（规则合法与条数）/ `policy-state`（策略空或非空）/ `config-no-manual-hooks`（配置无手工 `PermissionRequest` 接线）/ `agents-exists` / `agents-size`（≤ 90 KiB）/ `rules-section`（段与投影一致）/ `policy-section` / `version`（版本号一致）。

## 九、CI 回归防线

GitHub Actions（ubuntu-latest + Node 24，零依赖安装）跑三步：

| 步骤 | 作用 |
| --- | --- |
| `node scripts/verify-fidelity.mjs` | 四个参照实现逐字节保真 |
| `node scripts/check-docs.mjs` | 文档相对链接与仓库内路径引用存在 |
| `node --test tests/` | 169 例（含两个校验脚本的**红绿双向**用例） |

CI 是**回归防线**，不是运行期证据源 —— 运行期判据需要真实 ZCode 安装与 GUI 环境，只能在本地跑（隔离配方见 `isolation/RECIPE.md`）。

## 十、本插件没有覆盖的范围（如实声明）

- **`guarded` 档位**：危险命令在该档位绕过 hook，不覆盖。
- **`-p` 无人值守面**：无权限客户端时 hook 会被竞速取消，不覆盖。
- **GUI 弹窗路径**：结论在 Host↔CLI 协议面成立；GUI 只是另一种客户端实现，走同一 broker 竞速路径。
- **内容策略不是沙箱**：它是给模型读的提示文本，真正强制的是 hook 的 allow/deny。
