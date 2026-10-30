> **空规则 + 空策略 = 零行为变化**：不写任何规则、不写任何内容策略时，本插件不改变 ZCode 的默认行为——未命中一律 abstain（退赛），权限判定仍由产品原逻辑完成，`AGENTS.md` 里只有两个空段。
>
> **缺规则时使用内置空规则（abstain）**：数据目录还没有 `rules.json` 时，hook 入口使用插件内置的 `rules.default.json`（unmatched=abstain），不会 deny，也不创建/写任何文件；非法规则仍按 `onTimeout=deny` fail-closed。

# zcode-rules-plugin

[![CI](https://github.com/wufeng0105/zcode-rules-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/wufeng0105/zcode-rules-plugin/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**一句话**：把「一份规则源、两个出口」做成 ZCode 插件——同一个规则 JSON 既供 `PermissionRequest` hook 判 allow/deny/退赛，又投影成 `AGENTS.md` 里给人读的规则段；内容策略以自由文本形式走同一套双哨兵投影。

**你会得到什么**

| 能力 | 说明 |
| --- | --- |
| 命令级权限规则 | 在面板里写规则（工具 + 匹配 + 判定），命中即 allow/deny；不命中一律 abstain（交回 ZCode 原逻辑） |
| 给模型看的人可读规则 | 同一份规则自动投影到 `~/.zcode/AGENTS.md` 的 `zcode-rules` 段 |
| 内容策略 | 一段自由文本，投影到 `AGENTS.md` 的 `zcode-content-policy` 段（如「提交信息一律中文」「回答先给结论」） |
| 双向可见 | 所有数据都在你自己的磁盘上：规则在插件数据目录，投影在 `AGENTS.md`，两者都能手工查看和编辑 |
| 可自查 | 面板「运行检查」给出九项自检：数据目录、规则合法、策略状态、投影一致、尺寸、版本一致等 |

**它不做什么**（先说清，免得误会）

- 不修改 ZCode 本身，不改你的模型配置，不联网。
- 不接管没写规则的命令——未命中一律 abstain。
- 不在用户不确认的情况下改写 `AGENTS.md` 段外的内容（只维护两个带哨兵的段）。
- 不提供「一键清空所有规则」的按钮（删规则请在 JSON 里把 `rules` 改成 `[]` 再保存，你能看见内容再确认）。

---

## 文档索引

| 你想知道 | 看哪份 |
| --- | --- |
| 怎么装、怎么写第一条规则 | [QUICKSTART.md](QUICKSTART.md)（一页纸） |
| 面板在哪、按钮是什么意思 | 本文「面板在哪」「面板有什么」两节 |
| 规则/策略没生效怎么查 | 本文「常见问题」「故障排查」两节 |
| **这个插件真的生效吗？验证过什么？** | [docs/VERIFICATION.md](docs/VERIFICATION.md) |
| **想自己复跑这些验证？** | [docs/REPRODUCE.md](docs/REPRODUCE.md) |
| 想改代码 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 发现安全问题 | [SECURITY.md](SECURITY.md) |
| 版本变化 | [CHANGELOG.md](CHANGELOG.md) |
| 许可 | [LICENSE](LICENSE) |

---

## 五分钟上手

### 1. 准备市场（一次即可）

插件以**目录市场**方式安装。先在仓库里建一个市场目录（例如 `~/zcode-market/`），里面放一个 `marketplace.json`：

```json
{
  "name": "my-market",
  "plugins": [
    {
      "name": "zcode-rules",
      "source": { "source": "directory", "path": "<本仓库绝对路径>" },
      "version": "0.4.0",
      "description": "一份规则源，两个出口"
    }
  ]
}
```

### 2. 校验并加入市场

```pwsh
# <CLI> = C:\Program Files\ZCode\resources\glm\zcode.cjs
node <CLI> plugins validate <本仓库路径>
# 期望：Plugin manifest is valid

node <CLI> plugins marketplace add ~/zcode-market
# 期望：Added marketplace my-market (1 plugins)
```

### 3. 安装

```pwsh
node <CLI> plugins install zcode-rules@my-market
node <CLI> plugins list --verbose
# 期望含：zcode-rules@my-market … hooks: 1 … mcp: plugin:zcode-rules:zcode-rules
```

### 4. 打开面板

面板在**侧边面板**里（不在插件详情页）：

1. 打开任意会话（侧边面板是会话级，空会话不显示插件入口）。
2. 按 <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>B</kbd> 打开右侧面板。
3. 在「插件市场」里找到 **ZCode Rules** 卡片，点卡片右上角的 **「打开」**。

> **三个走不通的入口**（实测过，别再试）：
> 1. 详情页的「立即试用」——只把示例提示词预填进新会话，**不开面板**；
> 2. 侧栏「应用插件」推荐区——只列官方推荐插件，自建市场插件不出现；
> 3. 插件详情页的「配置」区——只有 `启用规则` 开关和 `看门狗秒数` 两个产品原生控件，**没有任何规则/文本输入框**。

### 5. 写第一条规则

面板「规则表」页 → 「编辑 JSON」文本框 → 把 `"rules": []` 改成：

```json
"rules": [
  { "id": "allow-echo", "tool": "Bash", "commandPattern": "^echo hello$", "decision": "allow" }
]
```

点 **「保存规则（写入 → 导出 → 自检）」**。下方日志会依次出现三行：`rules_write：已写入 1 条`、`export_agents：AGENTS.md 已更新`、`selfcheck_run：无 error`。

判定是 **first-match-wins**，数组顺序有意义。

### 6. 写一条内容策略（可选）

面板「内容策略」页 → 多行文本框 → 写自由文本 → 点 **「保存策略（写入 → 导出）」**。

> **保存后对新会话生效**：`AGENTS.md` 是会话开始时的上下文，当前会话里已经加载进去的文字不会因为这次保存而改变；新会话才会读到新内容。
>
> **用户级 = 所有工作区、每个会话**：想让某个项目不一样，去那个项目的 `AGENTS.md` 里写，别改这里的用户级策略。

---

## 面板有什么

| 屏 | 内容 |
| --- | --- |
| **状态** | 规则 N 条 / 策略空或非空 / 自检 ok·warn·error；总开关由产品设置页控制（面板不提供假开关，也不猜状态） |
| **规则表** | 表格 + JSON 编辑框；保存走 `rules_write` → `export_agents` → `selfcheck_run` |
| **内容策略** | 多行文本框；保存走 `content_policy_write` → `export_agents`；「对新会话生效」与「用户级 = 所有工作区」两句都在页面上 |
| **自检与版本** | 九项自检逐条结果 + 插件版本对 + 备份说明；`AGENTS.md` 哨兵段被手改时给出提示与两个动作 |

**手改 `AGENTS.md` 段会怎样**：自检报 `warn`（"段与规则投影不一致：可能被手改，或规则改了没重新导出"），**但不会替你决定以哪边为准，也不会静默覆盖你手改的内容**。两个动作由你点：

- **用真源覆盖 `AGENTS.md`** —— 段内容以规则源为准；
- **从 `AGENTS.md` 回填真源** —— 段内容反过来成为规则源（带二次确认，会先告诉你要消失/新增哪些规则）。

---

## 升级

```pwsh
node <CLI> plugins install zcode-rules@my-market   # 同 id 直接重装 = 原地升级
```

- **直接重装即可**，插件数据目录（你的规则与策略）**不会被删**。
- **不要先 `uninstall` 再装**：`uninstall` 会删掉数据目录，你的规则和策略会一起丢。
- **升级后已打开的面板标签要关掉重开**（或重启 ZCode）：面板资源路径里含版本号，旧标签会报 `ENOENT`。
- 升级后建议在面板点一次「运行检查」，确认 `version` 项显示新版本。

---

## 卸载

```pwsh
node <CLI> plugins uninstall zcode-rules@my-market --force
```

**卸载后必须知道的两件事**：

1. **卸载不会摘掉 `AGENTS.md` 里的两个段**。产品只清自己的三处注册（插件缓存 / 安装记录 / 启用开关），不碰你的文件。段还在，内容就还会被注入模型上下文。想干净卸载，请手工删掉 `AGENTS.md` 里 `<!-- BEGIN zcode-rules … -->` 到 `<!-- END zcode-rules -->` 之间（含哨兵行），以及 `zcode-content-policy` 段。
2. **卸载会删掉插件数据目录**（规则与策略真源）。卸载前先备份：

```pwsh
Copy-Item -Recurse "$HOME\.zcode\cli\plugins\data\zcode-rules@my-market" "$HOME\zcode-rules-backup"
```

---

## 自查

面板「自检与版本」页 → 点 **「运行检查」**。八项自检覆盖：规则合法性、策略空/非空、配置无手工 `PermissionRequest` 接线、`AGENTS.md` 存在与尺寸、两段投影是否与真源一致、版本号一致性。

命令行自查（等价）：

```pwsh
node <本仓库路径>\src\mcp\server.mjs   # stdio MCP server，需由宿主注入 ZCODE_RULES_DATA 才能工作
```

---

## 常见问题

**Q：插件详情页只有「启用规则」和「看门狗秒数」，规则在哪？**
A：那两项是产品按 manifest `userConfig` 渲染的原生控件，不是功能界面。规则表与内容策略输入框在侧边面板里，见上文「4. 打开面板」。

**Q：面板按钮点了没反应？**
A：面板会先跟宿主握手。握手失败时页面顶部会显示明确提示，且除切屏外的按钮保持禁用（不会装可用）。先关掉面板标签重开；仍不行就重启 ZCode。

**Q：我改了 `AGENTS.md` 里的段，插件把我的修改冲掉了？**
A：不会。自检只报 `warn`，不静默覆盖。只有你点「用真源覆盖」时才会重投影。

**Q：规则没生效？**
A：先看规则是否命中（`commandPattern` 是正则，`^echo hello$` 只匹配整行完全等于 `echo hello` 的命令）；不命中就是 abstain（交回 ZCode 原逻辑）。面板「运行检查」的 `rules-valid` 项能确认规则本身合法。

**Q：删规则怎么操作？**
A：面板不提供「一键清空」按钮。在「编辑 JSON」里把 `"rules"` 改成 `[]` 再保存——你能看见内容再确认一次。

**Q：内容策略保存后为什么当前会话没变？**
A：策略投影到 `AGENTS.md`，而 `AGENTS.md` 是会话开始时的上下文。新会话才会读到新内容。

---

## 故障排查

| 现象 | 排查 |
| --- | --- |
| 面板打不开 | 面板是会话级 → 先打开会话；再确认市场里该插件卡片存在（点卡片右上「打开」） |
| 面板报 `ENOENT` 且路径含旧版本号 | 升级后的旧标签 → 关标签重开或重启 ZCode |
| 面板显示「没有收到宿主的握手回包」 | 该页被当成静态文件打开了；在 ZCode 面板里打开它，不是双击 HTML |
| `plugins install` 报 manifest 无效 | 先跑 `plugins validate <仓库路径>` |
| 安装后 `plugins list` 没有 `hooks: 1` | 检查 `installed_plugins.json` 的 `hooks` 数组；本插件的 hook 是 `PermissionRequest` |
| 规则一直不生效 | 看 `rules.json` 是否真在插件数据目录（`ZCODE_PLUGIN_DATA`）；面板「运行检查」的 `rules-valid` 与 `rules-section` 两项能分辨「规则非法」与「没重新导出」 |

---

## 许可

MIT，见 [LICENSE](LICENSE)。
