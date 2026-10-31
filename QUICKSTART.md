# QUICKSTART

装到能用，一页纸。第一次装想先搞懂「这份规则源、hook、投影是怎么回事」，看 [README.md](README.md) 的前两节再回来。

这一份只讲四件事：**怎么装、第一条规则怎么写、面板在哪、出问题怎么查**。

## 一、装

三条命令。市场源（插件市场的来源地址）只需添加一次；以后重装或升级都不用再添加。

```pwsh
# <CLI> = C:\Program Files\ZCode\resources\glm\zcode.cjs

# ① 把本仓库添加到市场源（从 GitHub 直读）
node <CLI> plugins marketplace add wufeng0105/zcode-rules-plugin
#    期望：Added marketplace zcode-rules-plugin (N plugins)

# ② 安装
node <CLI> plugins install zcode-rules@zcode-rules-plugin
#    期望：Installed plugin zcode-rules@zcode-rules-plugin (0.4.3) [enabled]

# ③ 确认 hook 与 MCP 都挂上了
node <CLI> plugins list --verbose
#    期望：zcode-rules@zcode-rules-plugin … hooks: 1, mcp: plugin:zcode-rules:zcode-rules
```

**装完必须重启 ZCode。** 不重启的话 `plugins list` 已经显示 `[enabled]`，但面板就是打不开，容易误判成没装成。

## 二、第一条规则

### 先选对被测命令

这一步最容易错，先说清楚。

ZCode 对一批**只读命令**不询问——直接放行，不弹窗。`ls`、`cat`、`echo`、`grep`、`find`、`rg`、`jq`、`head`、`tail`、`wc`、`ps`、`pwd` 都在里面，一共 **74 个**。

既然不询问，就**不会调用 hook**，你给它们写规则等于白写。

要用**确实会被询问**的命令做实验：`touch`、`rm`、`npm --version`、`git -C <目录> status`。

下面统一用 `touch`。

### 写进去

1. 打开 ZCode 会话 → 按 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd> → 侧栏「插件市场」→ **ZCode 规则** 卡片右上角「打开」
2. 切到「规则表」屏 → 在编辑框里把 `"rules": []` 换成：

```json
"rules": [
  {
    "id": "allow-touch-test",
    "tool": "Bash",
    "commandPattern": "^touch .*test\\.tmp$",
    "decision": "allow",
    "comment": "创建 .tmp 测试文件，可回滚"
  }
]
```

3. 点「**保存规则（写入 → 投影 → 自检）**」。下方会出现三行日志：写入成功、投影成功、自检无 error。

### 验证它真的生效

让模型跑一条会命中的命令，比如 `touch check-test.tmp`。

- **生效了**：不弹窗，文件直接出现
- **没生效**：还会弹窗问你要不要允许

如果没生效，跳到本文「四、出问题怎么查」。

## 三、面板在哪（三个入口中只有一个能走通）

**唯一正确的入口**：会话内按 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd> → 侧栏「插件市场」→ **ZCode 规则** 卡片右上角「**打开**」。

另外三个看着像入口、实际走不通：

| 你可能会点的 | 实际行为 |
| --- | --- |
| 卡片上的「立即试用」 | 只把示例提示词预填进新会话，**不打开面板** |
| 「应用插件」推荐区 | 只列官方插件，找不到本插件 |
| 插件详情页的「配置」 | 只有「启用规则」和「看门狗秒数」两个原生控件，没有规则表和策略输入框 |

四个屏各自管什么：

| 屏 | 用途 |
| --- | --- |
| 状态 | 插件是否启用、规则几条、策略空不空、上次自检结果 |
| 规则表 | 编辑规则 JSON 并保存 |
| 内容策略 | 写自由文本，投影给模型读 |
| 自检与版本 | 十项检查，出问题时看这里 |

## 四、出问题怎么查

### 规则不生效

按这个顺序排查，前两个占了绝大多数。

**先看权限模式是不是「自主模式 / 完全访问」。** 这两个档位下由产品自己把关（普通命令自动放行、危险命令由产品弹确认），`PermissionRequest` hook 不参与，规则写什么都不生效。切到**构建模式**或**编辑模式**再测。

**再看这条命令会不会被询问。** 用只读白名单里的命令（`echo`、`ls`、`cat` 等）做实验是查不出问题的——它们根本不进权限询问环节。换成 `touch`、`rm` 再试。

**再检查正则转义。** `commandPattern` 是正则表达式。在 `rules.json` 这个 JSON 文件里，反斜杠要写两个：

| 要匹配 | JSON 里写 | 落进规则源是 |
| --- | --- | --- |
| 字面点号 `.` | `"\\."` | `\.` |
| 任意字符 | `"."` | `.` |

写成 `"\\\\."`，落进去就是 `\\.`——意思是「反斜杠 + 任意字符」，永远命中不了。

在面板的编辑框里直接写 `\.` 就行，面板会负责转义。

**最后确认锚点和命令形态匹配。** 你看到的是 `touch x.tmp`，但传给 hook 的可能是带引号的绝对路径 `touch "C:/path/x.tmp"`。用 `^touch$` 匹配不上，改成 `touch .*` 这类宽松写法。

### 自查十项

面板 →「自检与版本」→ 点「运行检查」。十项分别是：数据目录、投影模式、规则合法、策略状态、配置无手工接线、`AGENTS.md` 存在、`AGENTS.md` 尺寸、`rules` 段投影一致、`policy` 段投影一致、版本一致。

任意一项不是 `ok`，就按它的提示处理。

### 策略保存了但当前会话没变

这是正常的。`AGENTS.md` 是**会话开始时**读入上下文的，当前会话已经加载的文字不会因为这次保存而改变。**开新会话**才生效。

### 手改了 `AGENTS.md` 里的段

自检会报 `warn`，但**不会覆盖你的改动**。面板顶上会出现两个按钮，由你决定以哪边为准：

- 「用真源覆盖 `AGENTS.md`」——以规则源为准
- 「从 `AGENTS.md` 回填真源」——以你手改的内容为准

### 不想让 `AGENTS.md` 里出现规则清单

**设置 → 插件 → 已安装 → ZCode 规则 → 配置** → 关掉「**投影规则段**」→ **重启 ZCode**。之后导出只写内容策略段，规则段会被摘掉；hook 拦截照旧（它读 `rules.json`）。生效证据：面板「自检与版本」里 `projection-mode` 一行会写「规则段投影：关闭」。

### 升级后旧面板标签报 `ENOENT`

关掉那个标签重新打开，或者重启 ZCode。原因是资源路径里带了版本号，旧标签还指着旧路径。

## 五、升级与卸载

### 升级

```pwsh
node <CLI> plugins install zcode-rules@zcode-rules-plugin
```

`plugins install` 对已装的同 id 插件是**原地升级**：规则和策略都不动。

**不要先 `uninstall` 再装。** 卸载会删掉插件的数据目录，你的规则和策略会一起丢。

### 升级 ZCode 本体之后要复查什么

插件挂在 ZCode 的四个契约面上：插件注册（`hooks` / `mcpServers` 声明）、`PermissionRequest` hook 调用、MCP stdio 握手、`userConfig` 注入。产品升级后按这个顺序查，**一层不过就停在那层**：

1. **插件还在**：`plugins list --verbose`，本插件那行应为 `[enabled]`，下面一行是 `hooks: 1, mcp: plugin:zcode-rules:zcode-rules`。看不到就先重启 ZCode。
2. **清单仍合法**：`plugins validate <安装缓存目录>` → `Plugin manifest is valid`。
3. **MCP 能用**：打开面板，状态/规则表/自检三屏能读出数；宿主日志里 `mcp.ui.tool.call` 的 `isError` 应为 `false`。
4. **hook 还在判定**：开一个新会话发一条**会被询问**的命令（如 `touch check.tmp`）——命中 allow 规则时应直接执行、不弹窗；随后日志 `tool.permission.resolved` 的 `reason` 应为 `Allowed by PermissionRequest hook`。**权限模式必须是构建/编辑模式**——自主模式（`guarded`）与完全访问（`yolo`）下 hook 不参与（见 README「它做不到什么」）。
5. **投影没走样**：面板「自检与版本」里 `projection-mode` 与你的配置一致；`rules-section` / `policy-section` 不是 `warn`（配置关闭规则段投影时 `rules-section` 为 `info`，属预期）。

第 1–3、5 步可以一条命令跑完（只读，不改任何文件）：

```pwsh
node scripts/proof/upgrade-recheck.mjs
```

**实测提醒**：升级/刚重启的瞬间，宿主日志里可能出现多条 `mcp.server.failed · spawn node ENOENT`——同一时刻 `codegraph`、`node_repl` 等也会一起失败，属**环境级抖动**（进程拉起时 PATH 尚未就绪），重开一个会话即恢复；不是插件缺陷，也不影响 0.4.3 的 manifest。

### 卸载干净（三步）

```pwsh
# ① 先备份（卸载会删数据目录）
Copy-Item -Recurse "$HOME\.zcode\cli\plugins\data\zcode-rules@zcode-rules-plugin" "$HOME\zcode-rules-backup"

# ② 卸载
node <CLI> plugins uninstall zcode-rules@zcode-rules-plugin --force
```

**③ 手工删掉 `AGENTS.md` 里的两个段**——产品卸载只清插件自身注册，这两段会留在文件里继续注入模型上下文：

```
<!-- BEGIN zcode-rules … -->    …    <!-- END zcode-rules -->
<!-- BEGIN zcode-content-policy … -->    …    <!-- END zcode-content-policy -->
```

## 六、开发这个插件

```pwsh
node scripts/verify-fidelity.mjs   # 4 个参照实现逐字节保真（含副本 ≡ 原件）
node scripts/check-docs.mjs        # 文档相对链接与仓库内路径检查
node --test tests/                 # 197 例，零依赖、离线可跑
```

三条都不需要 `npm install`。CI 跑的就是这三步，三平台（ubuntu / macos / windows）各一遍。

改动流程与红线见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

MIT 许可，见 [LICENSE](LICENSE)。
