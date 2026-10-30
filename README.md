# zcode-rules-plugin

**让 ZCode 按你的规则工作。** 同一份规则 JSON 既决定「这条命令能不能跑」（`PermissionRequest` hook 判 allow/deny/abstain），又投影成 `AGENTS.md` 里给模型看的规则段 —— 不再有两套配置互相漂移。

[![CI](https://github.com/wufeng0105/zcode-rules-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/wufeng0105/zcode-rules-plugin/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.4.1-informational.svg)](https://github.com/wufeng0105/zcode-rules-plugin/releases)

高风险命令每次都要点「允许」，规则和提示词又写在两个地方 —— 这个插件把两件事合成一份规则源：写一条规则，权限判定和 `AGENTS.md` 同时生效。**空规则 + 空策略 = 零行为变化**，装上不装一样。

- **规则源单一性** —— `rules.json` 是唯一权威，`AGENTS.md` 里的是它的投影，不是第二份配置
- **hook 判定** —— 命中规则 → allow/deny；未命中 → `abstain`（交回 ZCode 原逻辑，不替你做决定）
- **哨兵段投影** —— `AGENTS.md` 里只维护 `zcode-rules` 与 `zcode-content-policy` 两个带哨兵标记的段，段外内容不动

## 快速开始

需要 **ZCode 桌面版** 与 **Node 24**。插件零运行时依赖 —— 不要 `npm install`。

```pwsh
# <CLI> = ZCode 安装目录里的 CLI 入口（Windows 默认 C:\Program Files\ZCode\resources\glm\zcode.cjs）
# <repo> = 本仓库路径

# ① 校验清单 → 期望：Plugin manifest is valid: <repo>
node <CLI> plugins validate <repo>

# ② 建一个市场源（一次即可），写 ~/zcode-market/marketplace.json：
#    注意 path 用**正斜杠**（Windows 下反斜杠在 JSON 里必须转义，容易写错）：
#    { "name": "my-market",
#      "plugins": [{ "name": "zcode-rules",
#                    "source": { "source": "directory", "path": "C:/path/to/zcode-rules-plugin" },
#                    "version": "0.4.1" }] }

# ③ 加入市场源并安装 → 期望：Installed plugin zcode-rules@my-market (0.4.1) [enabled]
node <CLI> plugins marketplace add ~/zcode-market
node <CLI> plugins install zcode-rules@my-market

# ④ 确认宿主已加载 hook 与 MCP
#    → 期望：zcode-rules@my-market … hooks: 1, mcp: plugin:zcode-rules:zcode-rules
node <CLI> plugins list --verbose
```

装好后打开面板：**会话内按 `Ctrl`+`Alt`+`B`** → 侧栏「插件市场」→ **ZCode Rules** 卡片右上角「**打开**」。

## 能做什么

> 面板在哪：会话内 `Ctrl`+`Alt`+`B` → 侧栏「插件市场」→ **ZCode Rules** 卡片右上角「**打开**」。详情页的「立即试用」**不会**打开面板（它只把示例提示词预填进新会话）；详情页「配置」只有 `启用规则` 与 `看门狗秒数` 两个原生控件 —— 规则表和内容策略输入框都在面板里。

- **写命令级规则**：工具 + 正则匹配 + allow/deny。first-match-wins，数组顺序有意义。
- **写内容策略**：一段自由文本（如「提交信息一律中文」「回答先给结论」），投影给模型读。
- **看自己写的东西**：规则表是表格也能直接编辑 JSON；内容策略是文本框；保存即写入、导出、自检。
- **自查**：九项自检（数据目录 / 规则合法 / 策略状态 / 配置无手工接线 / `AGENTS.md` 存在与尺寸 / 两段投影一致 / 版本一致），外加被手改时的提示与修复动作。
- **数据全在自己磁盘上**：规则在插件数据目录，投影在 `~/.zcode/AGENTS.md`，两者都能手工查看与编辑。

### 规则写了却像没生效？三个最常见原因

1. **命令本来就不会被询问** —— ZCode 自带只读命令白名单（`cat` `ls` `head` `wc` `which` `echo` `git status` 等 46 个），走免询问路径，hook 没有参与机会。测规则请用确实会被询问的命令（`touch`、`rm`、`npm --version`、`git -C <dir> status`）。完整对照见 [docs/REPRODUCE.md](docs/REPRODUCE.md) §三。
2. **正则转义写错** —— `commandPattern` 是**正则**。JSON 里写 `"\\."` 落盘是 `\.`（匹配字面点号，正确）；写 `"\\\\."` 落盘是 `\\.`（匹配字面反斜杠）⇒ 永不命中。在面板里直接写 `\.` 即可，不必操心 JSON 转义。
3. **锚点与实际命令不匹配** —— 实际命令形态可能是 `touch "C:/path/x.probe-file"`（带引号）。`^touch$` 匹配不上；用 `touch .*probe-file` 这类宽松写法。

## 可靠性与证据

CI 三步全绿（`ubuntu-latest` + Node 24，**无依赖安装步骤**）：

```
参照实现保真（4 文件 sha256）  结论：4 个参照实现逐字节一致（exit 0）
文档链接与文件引用              结论：受检文档里的相对链接与仓库内路径引用全部存在（exit 0）
单元测试                        pass 173 / fail 0
```

真实安装（GitHub 源）：

```
Added marketplace zcode-rules-github (1 plugins)
Installed plugin zcode-rules@zcode-rules-github (0.4.1) [enabled]
  hooks: 1, mcp: plugin:zcode-rules:zcode-rules
```

空规则时的自检（九项全 ok）与 hook 输出：

```
ok data-dir             数据目录：…（规则源已存在，内容策略已存在）
ok rules-valid          规则合法：0 条（schema v1，未命中 abstain）
ok policy-state         内容策略为空（零行为变化）
ok version              版本一致：v0.4.1
summary errors=0 warnings=0 rulesCount=0 version=0.4.1

{"hookSpecificOutput":{"hookEventName":"PermissionRequest"},
 "systemMessage":"zcode-rules: abstain (no rule matched, unmatched=abstain (产品原行为))"}
```

**hook 判定真的生效**，有对照组：客户端被故意延迟 8 秒后答 `deny`，而 allow 规则命中时命令**仍被执行**（日志 `tool.permission.resolved` 的 `reason` 为 `Allowed by PermissionRequest hook`）；把插件禁用后，同样配置命令**不执行** —— 差异只能由 hook 造成。

完整验证结论（含每条的验证方式与未覆盖范围）见 **[docs/VERIFICATION.md](docs/VERIFICATION.md)**；复跑入口见 **[docs/REPRODUCE.md](docs/REPRODUCE.md)**。

## 已知限制

- **`guarded` 档位不覆盖**：该档位下危险命令绕过 hook。
- **`-p` 无人值守面不覆盖**：无权限客户端时 hook 会被竞速取消。
- **规则只对「会被询问的命令」起作用**：ZCode 自带只读命令白名单（如 `echo`、`git status`）本就走免询问路径，你的规则对它们无意义 —— 这是产品的既有判定。
- **产品卸载不摘 `AGENTS.md` 里的段**：卸载只清插件自身注册，段要自己删。
- **内容策略不是沙箱**：它是给模型读的提示文本，真正强制的是 hook 的 allow/deny。

## 文档

| 文档 | 内容 |
| --- | --- |
| [QUICKSTART.md](QUICKSTART.md) | 一页纸：装、写第一条规则、面板在哪、卸载干净、常见坑 |
| [docs/DOD.md](docs/DOD.md) | **验收判据逐条核销**（D-1..D-10，每条带可复跑证据） |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | 验证结论与证据（含未覆盖范围） |
| [docs/REPRODUCE.md](docs/REPRODUCE.md) | 第三方如何复跑每条判据（含两个实测坑） |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发者参考：目录结构、数据结构、MCP 数据面、桥接、保真、CI |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 三条红线与改动流程 |
| [SECURITY.md](SECURITY.md) | 安全边界与漏洞报告渠道 |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | 行为准则 |

问题与建议用 [issue 模板](.github/ISSUE_TEMPLATE) 提；安全漏洞请走 [私下报告渠道](SECURITY.md)，不要开公开 issue。

## 许可

MIT，见 [LICENSE](LICENSE)。
