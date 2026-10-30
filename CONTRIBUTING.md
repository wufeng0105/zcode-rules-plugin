# 贡献指南

感谢你愿意为这个插件花时间。这份文档说明**怎么改、怎么验证、什么不能动**。

## 环境

| 需求 | 版本 |
| --- | --- |
| Node.js | **24**（CI 与本地一致；`node --version` 应输出 v24.x） |
| 依赖 | **零**。不要 `npm install` / `pnpm install` —— 仓库不需要任何第三方包 |
| 平台 | Windows / macOS / Linux 均可（CI 在 ubuntu-latest + Node 24 上跑） |

克隆后直接可用：

```pwsh
node --test tests/          # 全部测试
node scripts/verify-fidelity.mjs
node scripts/check-docs.mjs
```

## 三条不可动的红线

### 1. 四个参照实现文件必须逐字节不变

```
src/rules/rules-engine.mjs
src/rules/agents-section.mjs
src/rules/export-agents.mjs
src/hooks/permission-rules.mjs
```

它们是从 ZCode 检出自带的验证脚本**逐字节复制**过来的参照实现。改动它们会让「本插件行为与 ZCode 自带实现一致」这个前提失效。

基线在 `FIDELITY.json`，校验命令：

```pwsh
node scripts/verify-fidelity.mjs
```

脚本是 **fail-closed** 的：基线缺条目、多出清单外条目、值非法、文件缺失或读失败，任一情况都 `exit 1`。**不要为了让校验通过而删基线条目** —— 那等于让校验静默失效。确实需要更新基线时用 `node scripts/verify-fidelity.mjs --list` 重新生成，并在 PR 里说明原因。

### 2. 界面不承诺做不到的事

面板的每一块都必须是真能力。具体地：

- **不写「立即生效」**：内容策略投影到 `AGENTS.md`，而 `AGENTS.md` 是会话开始时的上下文 ⇒ 只能承诺「对新会话生效」。
- **不提供「一键清空所有规则」按钮**：删规则请在 JSON 编辑框里把 `rules` 改成 `[]` 再保存，用户能看见内容再确认。
- **不提供假开关**：插件启用态由产品设置页的 `userConfig` 决定，面板读不到就不显示，不猜状态。
- **每个 `data-action` 必须有真实实现**：改面板时新增按钮要同时在 `ACTIONS` 表里实现它；没有实现的按钮就是假按钮。

`tests/panel.test.mjs` 会检查这几条。

### 3. 不猜路径、不猜状态

数据目录只认宿主注入的 `ZCODE_RULES_DATA` / `ZCODE_PLUGIN_DATA`；缺失时所有工具调用 fail-closed。**不要**改成猜 `~/.zcode/cli/plugins/data/...` 之类的路径 —— 那会在多插件/多用户场景下读错文件。

## 改动流程

1. **先写判据**：你要证明什么？写下来（可以是测试断言、也可以是一次性脚本）。
2. **实现**：最小改动。四个参照实现不碰。
3. **验证**：跑全量门禁，三条都要 exit 0：

```pwsh
node scripts/verify-fidelity.mjs
node scripts/check-docs.mjs
node --test tests/
```

4. **写文档**：如果改了行为或命令，同步更新 `README.md`；如果是用户可见变化，在 `CHANGELOG.md` 顶部加一条。
5. **版本号**：用户可见的行为变化才升版本（`package.json` 与 `.zcode-plugin/plugin.json` **必须一起改**）；纯文档或纯内部改动可以不动版本。面板里的版本字样（`panel-version` / `version-panel` / `PANEL_VERSION`）也要一起改 —— `tests/panel.test.mjs` 会检查三处与清单一致。
6. **提交信息**：中文，格式 `<范围>：<做了什么>`，例如 `WP40：v0.4.1 修复 X`。

## 测试怎么写

- 框架用 Node 内置 `node:test` + `node:assert`，**不要引入测试框架依赖**。
- 测试文件放 `tests/`，用 `node --test tests/` 跑（`tests/index.js` 是目录入口）。
- **不要写恒真测试**（断言永远成立的测试比没有测试更糟）。写不出有意义的断言时，先问自己「这条判据真的能翻红吗」。
- 涉及「红绿双向」的脚本（校验脚本本身），正反两例都要有。
- 需要临时文件时用 `node:os` 的 `tmpdir()`，测试结束清理。

## 提交与发布

- 提 PR 前跑 `node scripts/verify-fidelity.mjs && node scripts/check-docs.mjs && node --test tests/`。
- CI 会在 GitHub 上重跑这三条，不需要你在描述里贴日志，但**有失败要如实写**。
- 维护者打 tag 发布（`vX.Y.Z`）。tag 一旦推送就是对外承诺，不要移动已有 tag。

## 提问

遇到「规则该怎么写」「hook 为什么不生效」这类问题，先看 [README.md](README.md) 的「常见问题」与「故障排查」两节 —— 绝大多数答案在那里。
