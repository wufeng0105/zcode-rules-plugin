# 怎么自己复跑这些判据

这份文档给的是**动手入口**：如果你不信前面那些结论，按这里的命令自己跑一遍。

先讲一件容易误解的事：**历史门禁日志里那些路径，你复现不了**。日志里写的是 `C:\Users\Administrator\...` 和 `.zhll/...`——那是当时那台机器上的工作目录，不在仓库里，也不可能在你的机器上存在。那些日志是历史记录，不是可跑脚本。

所以要复跑，得用下面这份映射：每条判据对应到**本仓库内的文件或命令**。

## 一、先把环境准备好

```pwsh
git clone https://github.com/wufeng0105/zcode-rules-plugin.git
cd zcode-rules-plugin
node --version          # 需要 v24
```

**不要 `npm install`。** 本仓库零运行时依赖、零 devDependency，所有脚本只用 Node 内置模块。装了反而多一层失败源。

## 二、三类判据，跑法不同

判据分三类，能跑的环境不同。先看清楚你要验的是哪一类，别在错的环境里跑。

### 第一类：纯静态检查，任何机器都能跑

不碰 ZCode，不联网，只读文件。

```pwsh
node scripts/verify-fidelity.mjs    # 4 个参照实现逐字节 + 副本 ≡ 原件
node scripts/check-docs.mjs         # 文档相对链接与仓库内路径
node --test tests/                  # 189 例
```

期望三条都 exit 0。这是 CI 跑的三步，也是最容易复跑的部分。

### 第二类：需要真的 ZCode 装在你机器上

`plugins` 系列命令是 ZCode 的 CLI 提供的，没有 ZCode 就没有。

```pwsh
# <CLI> = 你机器上的 ZCode CLI 入口
#         Windows 默认 C:\Program Files\ZCode\resources\glm\zcode.cjs

node <CLI> plugins validate <本仓库路径>
# 期望：Plugin manifest is valid: <本仓库路径>

node <CLI> plugins marketplace add wufeng0105/zcode-rules-plugin
# 期望：Added marketplace zcode-rules-plugin (N plugins)

node <CLI> plugins install zcode-rules@zcode-rules-plugin
# 期望：Installed plugin zcode-rules@zcode-rules-plugin (0.4.2) [enabled]

node <CLI> plugins list --verbose
# 期望：出现 hooks: 1 与 mcp: plugin:zcode-rules:zcode-rules
```

**但别在真实 home 上做装/卸。** 会污染你自己的插件状态。用下面第三类里的隔离方式。

### 第三类：需要真实 ZCode + 真实会话的（必须在隔离环境）

这一类包括「hook 真的放行了吗」「真实会话里规则生效吗」——需要启动 `zcode app-server`、创建会话、发指令、读日志。

**必须用隔离配方**，否则会写你的真实 `~/.zcode`：

```pwsh
node ../docs/isolation/tools/run-with-fingerprint.mjs --label my-label -- node <你的驱动脚本>
```

这个包壳做三件事：

1. 造一个隔离的 `HOME`，所有 ZCode 状态落到临时目录
2. 跑你的驱动脚本
3. 前后各拍一次真实 home 的指纹，比差异——**差异非零就报警**

配套工具：
- `run-with-fingerprint.mjs` —— 包壳 + 指纹对账
- `fingerprint.mjs` —— 快照与比对
- `probe-child.mjs` —— 探针子进程

配方细节见 [`isolation/RECIPE.md`](isolation/RECIPE.md)。

**安全门**：你的驱动脚本必须自己检查 `HOME` 是否落在隔离目录下，不是就 `exit 2` 拒绝执行。这是防止误伤真实环境的第一道闸。

## 三、仓库里现成的驱动脚本

不用从零写。`../scripts/proof/` 下有四份，路径全部可用环境变量覆盖，直接跑或作为模板改：

| 脚本 | 验什么 |
| --- | --- |
| `dod-remaining.mjs` | D-1 / D-2 / D-4 / D-7b / D-8 里那些能自动化的部分 |
| `d3-real-session.mjs` | D-3：真实会话里 hook 是否放行 |
| `p8-real-upgrade.mjs` | 换版本升级：真源保留 + 投影幂等 + 产物零改动 |
| `t68-project-rules.mjs` | v0.4.2 的 `projectRules:false`：只投影内容策略段、摘除规则段，且 hook 7 条规则照常判定 |

可覆盖的环境变量：

| 变量 | 作用 |
| --- | --- |
| `ZCODE_CLI_ENTRY` | ZCode CLI 入口路径 |
| `ZCODE_INSTALL_DIR` | ZCode 安装目录 |
| `ZCODE_WORKSPACE` | 工作区路径 |
| `ZCODE_PLUGIN_REPO` | 本仓库路径 |
| `ZCODE_PROOF_OUT` | 证据输出目录 |

跑法：

```pwsh
$env:ZCODE_CLI_ENTRY = "C:\Program Files\ZCode\resources\glm\zcode.cjs"
$env:ZCODE_PLUGIN_REPO = "C:\path\to\zcode-rules-plugin"
node ../docs/isolation/tools/run-with-fingerprint.mjs --label proof-d3 -- node scripts/proof/d3-real-session.mjs
```

## 四、四个实测出来的坑

这四条都是踩过之后才知道的，能省你很多时间。

### 坑 1：规则只对「会被询问的命令」起作用

产品有一份**只读命令白名单**，一共 74 个（46 个任意参数命令 + 49 个按 flag 判定的策略命令，去重后 74）。

命中白名单的命令走**免询问**路径——产品直接放行，**根本不进入权限询问环节**，hook 没有出场机会。你给它们写规则，永远不会生效。

**实测对照**（每种命令跑一次真会话，同一份规则）：

| 命令形态 | hook 是否介入 |
| --- | --- |
| `touch <file>` | ✅ 介入（`reason=Allowed by PermissionRequest hook`） |
| `rm -f <file>` | ✅ 介入 |
| `git -C <绝对路径> status` | ✅ 介入 |
| `echo x > <file>`（带重定向） | ✅ 介入 |
| `npm --version` | ✅ 介入 |
| `echo x` / `ls .` / `cat <file>` | ❌ 不介入（免询问，无 `permission.resolved` 记录） |
| `git status`（不带 `-C`） | ❌ 不介入 |
| `wc -l` / `which` / `head -1` | ❌ 不介入 |

完整的 74 个命令清单（从源码 `bash-readonly-policy-simple-commands.ts` 提取，去重后）：

```
alias base64 basename cal cat cd cmp column comm cut df diff dirname du echo egrep expand expr
false fd fdfind fgrep file find fmt fold free grep groups head help hexdump id jq locale ls
md5sum netstat nl nproc numfmt od paste pgrep pr printf ps pwd readlink realpath rev rg seq
sha1sum sha256sum sleep sort ss stat strings tac tail tr tree true tsort type uname unexpand
uniq uptime wc which whoami
```

另有 `docker images` / `docker ps` 两个前缀形态，以及 git / gh 的多词只读子命令集。

> ⚠️ 一个特例：`docker ps` 实测**进了询问路径**（有 `permission.resolved` 记录），但宽松规则没匹配上——说明宿主传给 hook 的命令文本与你在终端写的字面可能不同（有归一化或加参）。要覆盖这类命令，用宽松正则（如 `docker.*`），别用精确匹配。

> 早期版本的文档曾写「带重定向的命令 hook 不触发」——**那个结论是错的**，已由上表实测推翻。真实机制是只读白名单免询问，与重定向无关。

### 坑 1b：`commandPattern` 的正则转义和锚点

`commandPattern` 是正则表达式，有两个高频陷阱：

| 写法 | 落进规则源是 | 效果 |
| --- | --- | --- |
| JSON 里 `"\\."` | `\.` | ✅ 匹配字面点号 |
| JSON 里 `"\\\\."` | `\\.` | ❌ 匹配「反斜杠 + 任意字符」，永不命中 ⇒ 表现为 abstain |
| `^touch$` | —— | ❌ 实际命令常带引号和路径（`touch "C:/…/x"`），匹配不上 |

**在面板编辑框里直接写 `\.` 就行**，面板负责 JSON 转义。别在 JSON 层面手动加转义。

### 坑 2：升级前必须更新市场清单的 `ref`

市场清单里的 `source.ref` **锁定了版本**。上游发了新 tag 之后，如果清单还指着旧 tag，`plugins install` 装到的**仍是旧版本**——你会以为升级成功了。

正确顺序：

1. 更新市场清单的 `ref` 与 `version`
2. `plugins install <id>`（**不要先 uninstall**——卸载会删数据目录）
3. `plugins list` 确认版本号变了

### 坑 3（附）：stdio MCP server 的可靠探针

`../scripts/tools-list-probe.mjs` 用**串行** JSON-RPC 读一个 stdio MCP server 的工具清单：

```pwsh
node ../scripts/tools-list-probe.mjs <server.mjs 路径> <dataDir>
# 期望：tools=6 rules_read,rules_write,content_policy_read,content_policy_write,export_agents,selfcheck_run
```

写这个脚本踩了四个坑，都写在脚本头部注释里：

- 请求必须**串行**发（一次性连发三条拿不到回包）
- 必须显式 `stdio: ["pipe","pipe","pipe"]`
- 不要用 `cmd /c` 重定向（`<` / `>` 会被当普通参数）
- 不要用 `shell:true` 跑整串（`set` 的值会带上引号）

## 五、每条判据跑完之后，怎么判断结果

| 判据 | 你该看到什么 |
| --- | --- |
| D-1 | `marketplace add` 输出 `Added marketplace …`；`install` 输出 `Installed … [enabled]`；`list --verbose` 有 `hooks: 1` |
| D-2 | 空规则时 hook 输出**不含 `decision` 字段**的 JSON，带 `systemMessage` 说明 abstain |
| D-3 | 会话日志里 `tool.permission.resolved` 的 `reason` 为 `Allowed by PermissionRequest hook` |
| D-4 | 投影后 `AGENTS.md` 含 `<!-- BEGIN zcode-content-policy … -->` 与段内正文 |
| D-5 | 手改段后自检报 `warn`，且文件字节未变 |
| D-6 | 三处注册无该 id；`--uninstall` 后 `AGENTS.md` 逐字节回装前 |
| D-7 | 升级前后 `rules.json` / `content-policy.json` 字节不变；`AGENTS.md` 重投影 sha 不变 |
| D-8 | ZCode 安装目录逐文件摘要前后一致 |
| D-9 | 仓库 PUBLIC / MIT / 有 tag；CI 三平台绿 |
| D-10 | 就是这份文档——你能按上面的命令跑起来，这条就成立 |

每条判据的验证过程、证据强度与口径说明，见 [`VERIFICATION.md`](VERIFICATION.md) 与 [`DOD.md`](DOD.md)。

## 六、历史门禁日志在哪

早期开发时的门禁日志（**64 份**，每份带五段头：命令 / 退出码 / 环境 / 输入 / 复跑方式）保存在项目本地的归档目录，**不在本仓库**——它们含本机绝对路径与 gitignored 的实验产物，对第三方没有复跑价值。

本仓库提供的是它们的**结论**（[`VERIFICATION.md`](VERIFICATION.md)）与**复跑入口**（这份文档）——第三方不需要那批日志也能验证同样的结论。

## 七、结论的可信度边界

复跑时请注意：能自动跑通的部分，与需要真实 GUI 的部分，证据强度不同。

| 类型 | 证据强度 |
| --- | --- |
| 静态检查（保真 / 文档 / 单测） | 强——任何机器跑结果一致，CI 三平台已经跑过 |
| CLI 装/卸/列 | 较强——但依赖你机器上的 ZCode 版本 |
| 真实会话 hook 行为 | 中——依赖真实 ZCode + 会话，日志可读但环境难复现 |
| 面板 GUI 行为 | 弱——依赖人工操作截图，无自动化驱动 |

最后一行是实话：面板部分**没有自动化复跑路径**，`mcp/uiOpenInstance` 需要真 GUI 渲染进程提供的 `ownerWebContentsId`，这条路没打通。要看面板证据，只能看留档的截图与描述。

这些命令覆盖的判据逐条结论见 [`DOD.md`](DOD.md)；每条判据的验证方式与未覆盖范围见 [`VERIFICATION.md`](VERIFICATION.md)。
