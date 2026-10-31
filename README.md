# zcode-rules-plugin

**写一次规则，两处同时生效。** 你不用再维护两份：一份告诉 ZCode「这条命令能不能跑」，一份告诉模型「你该守什么规矩」。

[![CI](https://github.com/wufeng0105/zcode-rules-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/wufeng0105/zcode-rules-plugin/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.4.1-informational.svg)](https://github.com/wufeng0105/zcode-rules-plugin/releases)

## 它解决什么问题

ZCode 里有两件互不相干的事，都需要你配置。

**第一件是权限。** 模型要跑一条命令，ZCode 会弹窗问你能不能跑。每次弹窗都打断你的思路。

**第二件是行为习惯。** 比如「提交信息写中文」「回答先给结论」。这类要求只能写在 `AGENTS.md` 里让模型自己读——但它只是提示词，模型可能不听。

麻烦在于两处配置各写各的，时间一长就漂移：你在权限里放行了 `git push`，却忘了在 `AGENTS.md` 里说明「推送前先问」，于是模型真的直接推了。

这个插件把两处合成一份规则源（保存规则的 JSON 文件，默认在插件的 `rules.json`）：**你在面板里写一条规则，权限判定和行为提示同时更新。**

## 三个核心概念

理解这三个词，README 剩下的部分就不用逐字读了。

**规则源**——`rules.json`，唯一的权威。里面每一条是一个对象：匹配哪个工具、命令要符合什么正则、命中后放行还是拒绝。

**hook**——ZCode 的钩子机制，在判权限那一刻被调用（事件名 `PermissionRequest`）。插件挂的 hook 收到「模型想跑这条命令」的通知，按规则源给出裁决。注意：hook 只是**被询问时回答**，不是替 ZCode 做决定。

**投影**——把规则源的内容写进 `AGENTS.md` 里给模型看的那一段。投影不是第二份配置：改了规则源，投影重算；两者永远一致。投影落在一个「哨兵段」里（用 `<!-- BEGIN … -->` 和 `<!-- END … -->` 两个标记圈出边界，段外你的手写内容一个字不动）。

三者关系一句话：**规则源是账本，hook 是执行者，投影是给模型看的摘要。**

## 快速开始

需要 **ZCode 桌面版** 与 **Node 24**。插件零运行时依赖——不要 `npm install`。

```pwsh
# <CLI> = ZCode 安装目录里的 CLI 入口（Windows 默认 C:\Program Files\ZCode\resources\glm\zcode.cjs）

# ① 添加本仓库为市场源（从 GitHub 直读，一次即可）
#    期望：Added marketplace zcode-rules-plugin (N plugins)
node <CLI> plugins marketplace add wufeng0105/zcode-rules-plugin

# ② 安装
#    期望：Installed plugin zcode-rules@zcode-rules-plugin (0.4.1) [enabled]
node <CLI> plugins install zcode-rules@zcode-rules-plugin

# ③ 确认宿主已加载 hook 与 MCP
#    期望：zcode-rules@zcode-rules-plugin … hooks: 1, mcp: plugin:zcode-rules:zcode-rules
node <CLI> plugins list --verbose
```

装好后**重启 ZCode**——面板首次出现需要重启，不重启会以为没装成。

打开面板：会话内按 `Ctrl`+`Alt`+`B` → 侧栏「插件市场」→ **ZCode 规则** 卡片右上角「**打开**」。

### 面板上有什么

四屏：

| 屏 | 干什么 |
| --- | --- |
| 状态 | 看插件是否启用、规则几条、策略空不空、上次自检结果 |
| 规则表 | 编辑规则 JSON，保存后自动投影并自检 |
| 内容策略 | 一段自由文本，投影给模型读 |
| 自检与版本 | 九项检查，查出问题在哪 |

### 升级

```pwsh
node <CLI> plugins install zcode-rules@zcode-rules-plugin
```

原地升级，规则与策略不动。**不要先 `uninstall`**——卸载会删掉数据目录，你的规则和策略一起丢失。

## 三条使用路径

### 路径一：让常用命令不再弹窗

写一条放行规则。比如让 `npm test` 免确认：

```json
{
  "rules": [
    {
      "id": "allow-npm-test",
      "tool": "Bash",
      "commandPattern": "^npm (test|run test)(\\s|$)",
      "decision": "allow",
      "comment": "跑测试无副作用，不需要每次确认"
    }
  ]
}
```

保存后，`npm test` 不再弹窗；其他命令照旧。

### 路径二：拦住危险操作

```json
{
  "rules": [
    {
      "id": "deny-rm-rf",
      "tool": "Bash",
      "commandPattern": "rm\\s+-[a-zA-Z]*r[a-zA-Z]*f\\s",
      "decision": "deny",
      "comment": "递归强制删除不可逆"
    }
  ]
}
```

命中后 hook 直接拒绝，模型收到拒绝原因，命令不执行。

### 路径三：给模型立规矩

在「内容策略」屏写自由文本：

```
先给结论，再给依据。
不确定的事直接说「不确定」并说明缺什么信息。
删除、覆盖、推送前先说明将要做什么。
```

保存后投影进 `AGENTS.md` 的 `zcode-content-policy` 段。**对新会话生效**——`AGENTS.md` 是会话开始时的上下文，当前会话已加载的文字不会因此改变。

## 规则写了却像没生效？三个最常见原因

排查顺序从最常见的开始。

**一、这条命令本来就不会被询问。** ZCode 自带一份只读命令白名单（**74 个**：`ls`、`cat`、`echo`、`grep`、`find`、`rg`、`jq`、`head`、`tail`、`wc` 等），这些命令走免询问路径，**根本不进入权限询问环节**——hook 没有出场机会，你的规则自然不生效。

要测规则，得用**确实会被询问**的命令：`touch`、`rm`、`npm --version`、`git -C <目录> status`。完整白名单见 [docs/REPRODUCE.md](docs/REPRODUCE.md) 的「坑 1」。

**二、正则转义写错。** `commandPattern` 是正则表达式。在 `rules.json` 这个 JSON 文件里，反斜杠要写两次；在面板的编辑框里直接写一次。

| 你想匹配 | JSON 里写 | 落到规则源里是 |
| --- | --- | --- |
| 字面点号 `.` | `"\\."` | `\.` |
| 任意字符 | `"."` | `.` |
| 字面反斜杠 | `"\\\\"` | `\\` |

写错成 `"\\\\."`，落到规则源里是 `\\.`——匹配的是「一个反斜杠加任意字符」，永远命中不了。

**三、锚点和实际命令形态不匹配。** 你以为命令是 `touch x.tmp`，实际传给 hook 的可能带引号和绝对路径：`touch "C:/path/x.tmp"`。用 `^touch$` 就永远匹配不上。改成 `touch .*` 这类宽松写法。

## 可靠性与边界

### 凭什么信它

| 检查 | 结果 |
| --- | --- |
| 单元测试 | **175 例全过**，三平台（ubuntu / macos / windows）各跑一遍 |
| 参照实现保真 | 4 个文件逐字节校验 sha256，且「副本 ≡ 原件」 |
| 文档引用 | 全部相对链接与仓库内路径存在 |
| 依赖 | 零。CI 里没有 `npm install` 这一步 |

**hook 判定真的生效，有对照组**：客户端被故意延迟 8 秒后答 `deny`，而 allow 规则命中时命令**仍被执行**（日志 `tool.permission.resolved` 的 `reason` 为 `Allowed by PermissionRequest hook`）；把插件禁用后同样配置**不执行**——差异只能由 hook 造成。

完整结论见 [docs/VERIFICATION.md](docs/VERIFICATION.md)；逐条判据核销见 [docs/DOD.md](docs/DOD.md)；自己复跑见 [docs/REPRODUCE.md](docs/REPRODUCE.md)。

### 它做不到什么

先说产品本来的限制（不是插件缺陷）：

- **`guarded` 档位不覆盖**——该档位下危险命令绕过 hook。
- **`-p` 无人值守面不覆盖**——没有权限客户端时，hook 会被竞速取消。
- **内容策略不是沙箱**——它只是给模型读的提示文本，真正强制拦截的是 hook 的 allow/deny。想让某类命令绝对跑不了，写规则，别指望提示词。
- **产品卸载不摘 `AGENTS.md` 里的段**——卸载只清插件自身注册，段还留着，要自己删。

再说本项目没做到的：

- **macOS / Linux 的完整安装剧本只在 Windows 实机跑过**，其他两平台靠 CI 间接验证。
- **面板验证依赖人工截图**，无法自动重跑。
- **只有中文界面**，没测过非中文环境。

## 文档

| 文档 | 内容 |
| --- | --- |
| [QUICKSTART.md](QUICKSTART.md) | 一页纸：装、写第一条规则、面板在哪、卸载干净、常见坑 |
| [docs/DOD.md](docs/DOD.md) | 验收判据逐条核销（D-1..D-10，每条带可复跑证据） |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | 验证结论与证据（含未覆盖范围） |
| [docs/REPRODUCE.md](docs/REPRODUCE.md) | 第三方如何复跑每条判据（含四个实测坑） |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发者参考：组件、目录、数据结构、MCP 数据面、保真、CI |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 三条红线与改动流程 |
| [SECURITY.md](SECURITY.md) | 安全边界与漏洞报告渠道 |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | 行为准则 |

问题与建议用 [issue 模板](.github/ISSUE_TEMPLATE) 提；安全漏洞请走 [私下报告渠道](SECURITY.md)，不要开公开 issue。

## 许可

MIT，见 [LICENSE](LICENSE)。

---

<details>
<summary>备选安装：从本地目录装（不看 GitHub）</summary>

如果你已经 `git clone` 了本仓库，也可以用本地目录方式装。这样注册的市场类型是 `directory`（本地目录），**不是** GitHub 源。

```pwsh
# ① 校验本地副本 → 期望：Plugin manifest is valid: <repo>
node <CLI> plugins validate <repo>

# ② 建本地市场源 ~/zcode-market/marketplace.json
#    注意 path 用正斜杠（Windows 下反斜杠在 JSON 里必须转义，容易写错）：
#    { "name": "my-market",
#      "plugins": [{ "name": "zcode-rules",
#                    "source": { "source": "directory", "path": "C:/path/to/zcode-rules-plugin" },
#                    "version": "0.4.1" }] }

# ③ 加入并安装 → 期望：Installed plugin zcode-rules@my-market (0.4.1) [enabled]
node <CLI> plugins marketplace add ~/zcode-market
node <CLI> plugins install zcode-rules@my-market
```

</details>
