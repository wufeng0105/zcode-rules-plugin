# 第三方如何复跑这些判据

> 这份文档是**证据复现入口**。历史门禁日志里写的 `.zhll/…` 与 `C:\Users\Administrator\…` 是**当时本机的工作路径**，不属于仓库，也不可能在第三方机器上存在 —— 那是历史事实，不是可复跑路径。
>
> 要复跑，请用下面这份**映射表**：每条判据都指向本仓库内的文件或公开 URL。

## 零、环境准备

```pwsh
git clone https://github.com/wufeng0105/zcode-rules-plugin.git
cd zcode-rules-plugin
node --version          # 需要 v24（CI 同版本；v20+ 大概率可用，但以 CI 为准）
```

**零依赖**：不要 `npm install` / `pnpm install`。仓库只用 Node 内置模块。

### 需要真实 ZCode 的判据（本地跑）

```pwsh
# <CLI> = 你的 ZCode 安装里的 CLI 入口（Windows 默认 C:\Program Files\ZCode\resources\glm\zcode.cjs）
node <CLI> plugins validate <本仓库路径>     # 期望：Plugin manifest is valid
```

### 隔离环境（强烈建议）

**不要直接对真实 home 装/卸插件**。用随仓附带的隔离配方：

```pwsh
node docs/isolation/tools/run-with-fingerprint.mjs --label my-label -- node <你的驱动脚本>
```

- 配方说明：[`isolation/RECIPE.md`](isolation/RECIPE.md)
- 工具：`run-with-fingerprint.mjs`（包壳 + 前后指纹对账）、`fingerprint.mjs`（快照与比对）、`probe-child.mjs`（探针子进程）
- 安全门：驱动脚本必须自己检查 `HOME` 落在 `.zhll/rt/iso-runs/**` 下，否则退出码 2

## 一、可直接复跑的（仓库内，零外部依赖）

| 判据 | 命令 | 期望 |
| --- | --- | --- |
| 四个参照实现逐字节保真 | `node scripts/verify-fidelity.mjs` | exit 0，「4 个参照实现逐字节一致」 |
| 文档链接与路径引用有效 | `node scripts/check-docs.mjs` | exit 0 |
| 全部单测 | `node --test tests/` | 173 pass / 0 fail |
| CI 三步（等价） | GitHub Actions 页面 | `success` |
| 自检九项 | `node scripts/probe-selfcheck.mjs <dataDir> <agentsPath> <configPath>` | 打印每项 `level/id/message` |

**变异测试（证明校验脚本非恒真）**：把 `FIDELITY.json` 里任一条 sha 的末位改错 → `verify-fidelity` 必须 exit 1；把 README 里某个仓库内链接改成不存在的路径 → `check-docs` 必须 exit 1。改完恢复。

## 二、需要真实 ZCode 的（本地跑，命令形态见下）

| 判据 | 做什么 | 复跑入口 |
| --- | --- | --- |
| **D-1** GitHub 源安装 | 建市场清单（`source: {source:"github", repo:"wufeng0105/zcode-rules-plugin", ref:"<tag>"}`）→ `plugins marketplace add` → `plugins install` → `plugins list --verbose` 看到 `hooks: 1` + `mcp: plugin:zcode-rules:zcode-rules` | 本仓库 `README.md`「五分钟上手」 |
| **D-2** 空规则 = 零行为 | `rules.json` 为空时 hook 输出 `abstain` 且**不产出 decision** | `selfcheck/hooks/permission-rules.mjs`（参照实现）+ 本仓库 `../src/hooks/permission-rules-entry.mjs` |
| **D-3** allow 规则命中 → 不弹窗且执行 | 写一条 allow 规则 → 新会话里跑匹配的命令 → 日志 `tool.permission.resolved` 的 `reason` 为 `Allowed by PermissionRequest hook`、`decision: allow` | 见下方「⚠️ 两个必须知道的坑」 |
| **D-4** 内容策略投影 | 保存策略 → `AGENTS.md` 出现 `BEGIN zcode-content-policy` 段且含正文 | `../src/mcp/operations.mjs` 的 `exportAgents({ agentsPath, rules, policy })` |
| **D-5** 手改不被静默覆盖 | 手改段内文字 → 自检报 `policy-section`/`rules-section` 为 `warn` → 文件字节不变 | `../src/mcp/operations.mjs` 的 `runSelfcheck` |
| **D-6** 卸载闭环 | 卸载后 `cache/` 下该插件文件数 0、`installed_plugins.json` 无该 id、`enabledPlugins` 无该 id | `plugins uninstall <id> --force`；`AGENTS.md` 摘段用 `src/rules/export-agents.mjs --uninstall`（**必须带 `--state`**） |
| **D-7** 升级 | 同 id 直接 `plugins install` ⇒ 原地升级、data 不动、投影幂等 | 见下方「⚠️ 升级必须先更新市场清单」 |
| **D-8** 产物零改动 | 比对 `C:\Program Files\ZCode`（或你的安装目录）全量文件的 size+mtime | 本仓库 `isolation/tools/fingerprint.mjs`（前后快照比对） |
| **D-9** 公开仓库形态 | LICENSE / README / CHANGELOG / tag / CI 绿 | <https://github.com/wufeng0105/zcode-rules-plugin> |
| **D-10** 证据可复现 | 就是本文档 | 本文 |

## 三、⚠️ 两个必须知道的坑（实测得出）

### 坑 1：命令带 shell 重定向（`>`）时，hook 不会被调用

产品的权限判定里，**带重定向的命令被判为高风险**（`mode.build.highRisk`），其 `approvalMode` 是 `user-once`，而 `runHooks` 的条件是 `hooksAvailable && approvalMode !== "user-once"` ⇒ **hook 被跳过**，你的规则不会生效。

⇒ 验证 allow 规则时，**用不带 `>` 的命令**（例如 `touch <file>` 而不是 `echo x > <file>`）。这不是本插件的缺陷，是产品的既有语义。

### 坑 2：升级前必须先更新市场清单的 `ref`

市场清单里 `source.ref` 锁定了版本。上游发了新 tag 之后，若清单还指向旧 tag，`plugins install` 装到的**仍是旧版本**。

⇒ 升级步骤：①更新市场清单的 `ref` 与 `version` → ②`plugins install <id>`（**不要先 uninstall** —— 卸载会删掉你的规则与策略） → ③确认 `plugins list` 的版本号变了。

## 四、历史门禁日志在哪

历史门禁日志（46 份，含每条判据的原始输出与五段头）保存在**项目本地的归档目录**，不在本仓库（它们含本机绝对路径与 gitignored 的实验产物，对第三方没有复跑价值）。

- 归档位置（维护者本机）：`C:\Users\Administrator\Downloads\zcode-mod-history-20261030\docs-zcode-mod\`
- 其中 `gates/` 是逐条门禁日志，`evidence/` 是运行期证据与复跑脚本。
- **判据的结论已提炼进 [`VERIFICATION.md`](VERIFICATION.md)** —— 那是第三方应该读的那一份。

## 五、结论可信度

`VERIFICATION.md` 每条结论都标注了验证方式与是否在真实环境跑过。其中「hook 决策生效」的结论附**对照组**（禁用插件后同配置不生效），是因果证明而非相关性。

已明确声明**未覆盖**的范围也在该文件末尾（如 `guarded` 档位、`-p` 无人值守面）。

## 六、随仓附带的判据驱动脚本（`scripts/proof/`）

三份脚本把上述判据做成了**可重跑**的形式，路径全部可由环境变量覆盖（仓库根由脚本位置自推导）：

| 脚本 | 覆盖判据 | 需要的环境变量 |
| --- | --- | --- |
| `../scripts/proof/dod-remaining.mjs` | D-1 / D-2 / D-4 / D-7b / D-8 | `ZCODE_CLI_ENTRY`、`ZCODE_INSTALL_DIR`（可省略，取 Windows 默认安装位置） |
| `../scripts/proof/d3-real-session.mjs` | D-3 | `ZCODE_CLI_ENTRY`、`ZCODE_WORKSPACE`（会话工作区） |
| `../scripts/proof/p8-real-upgrade.mjs` | D-7a（P-8 真实升级） | `ZCODE_CLI_ENTRY`、`ZCODE_INSTALL_DIR` |

跑法（示例）：

```pwsh
node scripts/proof/dod-remaining.mjs
node scripts/proof/d3-real-session.mjs
node scripts/proof/p8-real-upgrade.mjs
```

⚠️ 这些脚本会**写真实 home**（写规则、升级插件、跑会话）。请先按上文「隔离环境」把它们包起来跑，或接受在真实 home 上操作。
