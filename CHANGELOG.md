## 0.4.3（2026-10-31）

**「投影规则段」变成一个持久开关**：关掉后 `AGENTS.md` 只保留内容策略段，规则清单不再写给模型看——hook 拦截照旧。

- **为什么**：0.4.2 只给了 MCP 工具一个一次性参数 `projectRules`，但面板「保存」内部固定调 `export_agents` 不带参数（默认 true），所以只要在面板点一次保存，规则段就被写回来。用户要的是「设一次就一直不投影」。
- **设计（关键）**：这个开关**没有**落到插件数据目录，而是走产品自己的配置通道——`manifest.userConfig.projectRules`（产品详情页「配置」里的原生布尔开关）→ 产品存 `config.json` 的 `plugins.options["<pluginId>"]` → 按 manifest 的 `${user_config.projectRules}` 注入 MCP server env → `server.mjs` 解析成 boolean → 作为**显式参数**传给 `exportAgents()` / `runSelfcheck()`。插件不新建状态文件，纯函数仍不读 env/配置。
- **行为**：关掉后，任何导出（面板保存也算）只投影内容策略段，并摘除已有规则段；hook 判定读 `rules.json`，完全不受影响。MCP 工具显式传 `projectRules` 仍可**一次性**覆盖，不改配置、不落盘。
- **自检**：新增 `projection-mode`（info，报当前模式）；规则段缺失时的口径分流——配置关闭时是 `info`（预期态），配置开启时仍是 `warn`（"该投影却没导出"的信号不丢）。两者都带 `absent: true`，面板不会误报成手改。
- **兼容**：默认值 `true`，不配置时行为与 0.4.2 逐字节一致；显式参数语义不变。旧版产品若不展开 `${user_config.*}`，模板会原样传入，解析退化成 `true`（安全侧）。
- **证据（真实 GUI，发布后补记）**：在真实 ZCode 桌面 3.16.3 上按 GUI 路径关掉「投影规则段」并重启后，`config.json` 的 `plugins.options` 写入 `projectRules: false`；`AGENTS.md` 4203 B、无规则段、只有内容策略段；自检 `projection-mode`=关闭、`rules-section`=info、`errors=0`；hook 仍 allow / deny / abstain。详见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md) §十。
- **证据（产品侧）**：已安装的 CLI 产物 `zcode.cjs` 内含 `if(name.startsWith("user_config.")){...}` 展开逻辑；MCP server 的 `env` 经 `resolveStringRecord → resolveTemplate` 展开。
- 版本号 `0.4.3`：`package.json`、`.zcode-plugin/plugin.json`、`marketplace.json`（version ×2 + `source.ref`）、面板字样（`panel-version` / `PANEL_VERSION`）同步。
- 测试：新增 `tests/projection-mode.test.mjs`（8 例：manifest 声明与 env 接线、env 解析边界、MCP 缺省走配置、显式参数覆盖、自检口径分流）；`node --test tests/` 共 **197 例全绿**（原 189 + 8）。

## 0.4.2（2026-10-31）

**新增 `export_agents` 的 `projectRules` 开关（v0.4.2）**：只想让 `AGENTS.md` 带上内容策略、不想让规则表继续注入模型上下文时，可以不投影规则段。

- **行为**：`projectRules` 缺省 `true`（与 0.4.1 逐字节一致）；显式 `false` 时**只投影 `zcode-content-policy` 段**，并**摘除**已有的 `zcode-rules` 段——外科式删段：只动哨兵段本身与其后一个换行，段外字节原样，CRLF/LF 保持。
- **为什么摘除而不是留着**：留下的旧规则文本会继续作为会话上下文注入模型，看起来像"当前规则"，比没有更糟。规则真源 `rules.json` 不动，随时可以用缺省参数把规则段重新投影回来。
- **fail-closed**：规则段哨兵残缺 / 乱序 / 重复时**拒绝摘除**并返回 `ok:false`，一个字节都不写（与既有 upsert 同口径，绝不盲删）。
- **`rules` 免读免校验**：`projectRules:false` 时 `rules` 不参与投影，MCP 侧也不再要求 `rules.json` 存在（此前缺规则文件会直接失败）。`true` / 缺省路径的校验与报错完全不变。
- **hook 判定不受影响**：`PermissionRequest` hook 直接读 `<data>/rules.json`，与 `AGENTS.md` 投影无关；本版未改任何 hook 文件（4 个参照实现仍逐字节一致）。
- **返回值**：新增 `projectRules` 回显与 `removedRulesSection`（摘除时的字节数 + sha256）；`actions.rules` 增加取值 `removed` / `absent`；`ruleCount` 在 `false` 时为 0。
- **自检 / 面板口径**：缺规则段时 `rules-section` 仍是 `warn`（"完全没导出"依然会被 `policy-section` 的 warn 抓住），但该 check 增加机器可读的 `absent: true`；面板据此不再把它显示成「AGENTS.md 段被你手动改过」。**代价如实说明**：磁盘上没有持久标记，自检无法区分「有意不投影」与「规则段被手工删除」。
- **隔离验证**：新增随仓驱动 `scripts/proof/t68-project-rules.mjs`（路径全环境变量化，经 `docs/isolation/tools/run-with-fingerprint.mjs` 包壳运行）——隔离装 v0.4.2 → `projectRules:false` 导出 → 断言只剩策略段 → 用 7 条规则跑 hook 判定。
- 版本号 `0.4.2`：`package.json`、`.zcode-plugin/plugin.json`、`marketplace.json`（version ×2 + `source.ref`）、面板字样（`panel-version` / `PANEL_VERSION`）同步。
- 测试：新增 `tests/project-rules.test.mjs`（11 例）+ MCP 往返 2 例 + 面板静态 1 例；`node --test tests/` 共 **189 例全绿**（原 175 + 14）。

## 0.4.1（2026-10-31）

**新增自检项 `data-dir`**（数据目录可见性）——P-8 真实升级的载体版本。

- **为什么加它**：插件可能以不同 id / 不同市场源安装（目录市场 vs GitHub 源），数据目录名随之不同。此前「规则不生效」的第一排查动作（确认自己的规则存在哪）没有出口 —— 自检只在数据目录**出错**时才提它，正常路径下用户看不到。现在正常路径也报。
- **行为**：自检新增 `data-dir` 项（level=`ok`），message 形如「数据目录：`<绝对路径>`（规则源已存在|尚未创建，内容策略已存在|尚未创建）」，detail 为数据目录绝对路径。**不因缺文件报 error** —— 缺 `rules.json` 仍只让 `rules-valid` 为 `warn`（空规则 = 产品原行为）。
- **既有项不变**：`rules-valid` / `policy-state` / `config-no-manual-hooks` / `agents-exists` / `agents-size` / `rules-section` / `policy-section` / `version` 八项语义完全不变；`data-dir` 是**新增第九项**，不替换任何既有项。
- 版本号 `0.4.1`：`package.json`、`.zcode-plugin/plugin.json`、面板字样（`panel-version` / `version-panel` / `appInfo.version` / `PANEL_VERSION`）四处同步。
- 测试：新增 `tests/data-dir-visibility.test.mjs`（4 例：路径报出 / 已存在与未创建之别 / 不引入 error / 与既有项并存），`node --test tests/` 共 **173 例全绿**（原 169 + 4）。
## 0.4.0（2026-10-30）

**交付级文档重写**（M5 · T41）：把仓库从「内部导航」改写为外部用户文档，并把本轮实测出的产品契约边界写进用户可见位置。

- `README.md`（重写）：首屏改成外部用户流程——「这是什么 / 你会得到什么 / **它不做什么** / 五分钟上手六步 / 面板在哪 / 面板有什么 / 升级 / 卸载 / 自查 / 常见问题 / 故障排查」，原有技术细节全部保留并下移到「开发者参考」节（目录结构、数据结构、MCP 数据面、桥接、测试、保真、CI）。
- `QUICKSTART.md`（新）：一页纸——装（4 步）/ 第一条规则（3 步）/ 面板在哪（**三个走不通的入口**）/ 卸载干净（2 步）/ 自查（1 条）/ 常见坑（5 条）/ 开发三命令。
- 版本号 `0.4.0`：`package.json`、`.zcode-plugin/plugin.json`、面板字面（`panel-version` / `version-panel` / `PANEL_VERSION`）同步；`tests/panel.test.mjs` 的版本断言改为**从清单动态读取**（不写死版本号），三处同源仍被强制校验。
- `scripts/check-docs.mjs`：默认受检文件加入 `QUICKSTART.md`（此前只查 README/CHANGELOG）。

### 本版写进用户文档的实测契约边界（全部来自本轮运行期证据）

- **面板入口**：会话内 `Ctrl+Alt+B` → 插件市场 → ZCode Rules 卡片右上「打开」。**「立即试用」只预填提示词不开面板；「应用插件」推荐区只列官方推荐插件；详情页「配置」只有 `userConfig` 两项**——三者都不是功能界面。
- **升级**：同 id 直接 `plugins install` 即原地升级，**数据目录不动**；**不要先 `uninstall`**（会删规则与策略）。升级后旧面板标签因 cache 路径含版本号会报 `ENOENT`，需关标签重开或重启。
- **卸载**：产品只清三处注册（缓存 / 安装记录 / 启用开关），**不摘 `AGENTS.md` 里的两个段**——需手工删除；**卸载会删数据目录**，卸载前先备份。
- **`rules_write` 规范化**：写入会补 `description: ""` 并按 schema 排序键名，故「恢复空规则」是**语义等价**而非字节相等。
- **内容策略对新会话生效**；用户级 = 所有工作区、每个会话。
# CHANGELOG

## 未发布（工程化；本批条目随 0.4.1 发布，原样保留）

M4 首批：P-8 升级模拟 + CI 门禁 + 保真/文档校验脚本。**不升版本、不打 tag**（本批只加工程化护栏，插件行为零变化）。

- `FIDELITY.json`（新，仓根）+ `scripts/verify-fidelity.mjs`（新）：4 个参照实现的 sha256 基线落进仓库，脚本对工作树实测值逐条比对。基线不再依赖 ZCode 检出，CI 可跑。fail-closed 覆盖：基线缺条目 / 多出清单外条目 / 值非法 / 文件缺失或读失败，任一即 exit 1（否则删一条基线就能让校验静默失效）。`--list` 用于重新生成基线。
- `scripts/check-docs.mjs`（新）：检查 README / CHANGELOG 里的相对链接、图片、引用式链接与反引号内的仓库内路径引用是否存在。纯静态、无网络。刻意不查：外链（CI 不联网）、纯锚点、`mailto:`、围栏代码块内的示意路径、反斜杠形态的 ZCode 检出路径；`docs/zcode-mod/` 前缀属只读检出，跳过但**逐条打印 SKIP 行**（跳过可见，非静默放行）。
- `scripts/smoke-upgrade.mjs`（新）：P-8 升级模拟（隔离环境）。装 v0.3.0 → 经数据面写 1 条规则 + 非空内容策略 → 换 version 重装 → 断言 `rules.json` / `content-policy.json` 字节与 sha256 不变、`AGENTS.md` 投影 sha256 不变（重投影 `changed=false`）、插件 id 与 `enabledPlugins` 不变 → 卸载确认清理。脚本自带安全门（`HOME` 必须已重定向到 `.zhll/rt/iso-runs/**` 且不等于真实 home，否则 exit 2），并必须经 `run-with-fingerprint.mjs` 包壳启动。
  - **升级做法（实测结论）**：ZCode 的 `plugins install` 每次都从市场条目 `source.path` 重新复制、并用**源**清单的 `version` 决定安装版本；只改插件缓存里的 manifest 不生效（脚本把这一步当对照观测写进日志，并还原被改的缓存清单）。故升级走「复制本仓到隔离目录 → 改副本清单 version=0.3.1 → 市场条目指向副本 → `plugins install`」，全程不碰本仓与 ZCode 检出。
  - 卸载语义补充（实测）：`uninstall` 只删**当前** installPath，不清 cache 父目录，换过版本的机器上旧版本目录会残留——脚本把它记为 INFO 而非失败项。
- `.github/workflows/ci.yml`（新）：`ubuntu-latest` + Node 24，三步 `run`（verify-fidelity / check-docs / `node --test tests/`），**无任何依赖安装步骤**（零依赖，只用 `actions/checkout` + `actions/setup-node`）。
- `package.json`：新增 `verify`（两个静态校验串联）与 `smoke:upgrade` 两个脚本；版本仍 0.3.0。
- `README.md`：新增「CI 与本地门禁」段（徽章占位说明 + 三段命令）与「P-8 升级模拟」小节；「来源与保真」段的旧 `Get-FileHash` 手抄命令改指 `verify-fidelity` 脚本。
- 测试：新增 `tests/static-checks.test.mjs`（17 例，覆盖两个校验脚本的**红/绿双向**——恒真脚本比没脚本更糟）与 `tests/ci-config.test.mjs`（6 例，workflow 语义回归）；`node --test tests/` 共 169 例全绿。
- 证据（ZCode 检出侧，gitignored）：`.zhll\rt\wp33\upgrade-proof.log`（P-8 全流程五段头）、`docs\zcode-mod\evidence\rt-iso-wp33-upgrade.log`（包壳隔离证明，真实 home 指纹零差异）。
- 四个参照实现未改一行；`FIDELITY.json` 记录的 sha256 与文件实测全等。

## 0.3.0（2026-10-30）

面板四屏 + 手改提示用户路径（M3 · T33）：

- `ui/panel.html` 从 128 行静态占位升级为**四屏可用面板**（单页分区 tab，一屏一职责，零依赖纯内联 JS，共 45 KB）：
  1. **状态**：启用态说明（开关归产品设置页的 `userConfig.enabled`，面板**不提供开关**、也读不到当前值）+ 三个徽标「规则 N 条 / 策略 空|非空 / 自检 ok|warn|error」。
  2. **规则表**：`rules_read` 渲染表格（id / 工具 / 匹配 / decision / 说明）+ 「编辑 JSON」文本域保存走 `rules_write`，保存成功后自动 `export_agents` → `selfcheck_run` 并逐步显示结果；**不提供**「一键清空规则」按钮。
  3. **内容策略**：多行文本域，默认空；保存走 `content_policy_write` + `export_agents`；界面写「保存后**对新会话生效**」与「**用户级 = 所有工作区、每个会话**；想让某个项目不同，去那个项目的 AGENTS.md」；清空已有策略必须过二次确认。
  4. **自检与版本**：`selfcheck_run` 结果表（id / level / message）、版本对（面板内置 / 清单 / ZCode 版本，取不到显示「未知」不猜）、备份说明（卸载不还原 AGENTS.md，要清理请手动删哨兵段）。
  - **P-6 手改提示**：`rules-section` / `policy-section` 非 ok 时屏 4 顶部显示「AGENTS.md 段被你手动改过，本次不覆盖；以哪边为准由你决定」，并给两个**真实**动作——「用真源覆盖 AGENTS.md」（`export_agents`）与「从 AGENTS.md 回填真源」（`rules_write` / `content_policy_write` + 重新导出，带二次确认，两段都不可无损还原时按钮禁用）。
  - 未收到宿主握手时不显示任何数值、所有读写按钮禁用（不伪造状态）。
- `src/mcp/bridge.mjs`（新，零依赖）：JSON-RPC 2.0 over postMessage 最小客户端——帧形状 `{ jsonrpc: "2.0", id, method, params }`、`tools/call` 参数 `{ name, arguments }`、`ui/initialize` → `ui/notifications/initialized` 握手、`resources/read`；含 id 配对、超时、非法帧忽略、source 过滤、dispose 作废。面板内联同一逻辑（沙箱 iframe 无法 import 仓库模块），bridge.mjs 保留可单测实现。
- `src/mcp/agents-backfill.mjs`（新）：从 AGENTS.md 的 `zcode-rules` / `zcode-content-policy` 段**无损**反解真源。规则段严格按 `renderAgentsSection` 的投影格式解析，并要求「回渲后与文件里的段逐字（按行尾归一化）相同」才 `ok=true`；因投影按 decision 分组、跨组次序不可还原，回填时**保留当前 rules.json 的次序**并报 `orderChanged` / `appendedIds` / `droppedIds`，`description` 沿用真源。
- `src/mcp/operations.mjs`：`runSelfcheck` 返回值新增 `backfill`（供屏 4 手改提示用；AGENTS.md 不存在或数据目录缺失时为 `null`），其余判定与返回值不变。
- `tests/panel.test.mjs`（新，19 例）：四屏标题与分区、禁项（无「立即生效」/无 input 假开关/无清空规则类按钮/清空策略必须确认）、**每个 `data-action` 都有实现且没有无人使用的动作**（假按钮判定）、无内联事件与外部脚本、桥接函数与六个工具调用、规则表五列与「写入 → 导出 → 自检」顺序、策略两句措辞、自检表/版本对/备份说明、手改提示双动作与二次确认文案、徽标三态、未连接不伪造数据、**内联脚本真编译一遍**（`vm.Script`，静态正则抓不到语法错误）、**内联桥与 `bridge.mjs` 的协议常量逐项一致**（防两份实现漂移）。
- `tests/bridge.test.mjs`（新，21 例）：帧形状四键、通知无 id、`tools/call` 参数形状、`parseFrame` 四分类、id 配对（乱序回包/并发六请求）、错误与退化错误码、非法帧不结算、source 过滤、超时与迟到回包、握手成功才补 `initialized`、`resources/read`、`unwrapToolResult`、通知分发与退订、dispose、`targetOrigin`。
- `tests/agents-backfill.test.mjs`（新，20 例）：反解逐字段还原、次序保持与 append/drop、CRLF/LF、段缺失/残缺/坏格式/条目数不符/段尾说明被删各种拒绝、policy 逐字往返、格式常量与引擎输出一致、EOL 工具函数。
- `tests/operations.test.mjs`：`renderPanelHtml` 用例从「静态占位页无按钮/无脚本」改为 v0.3.0 口径（逐字节一致 + 无内联事件 + 无「立即生效」+ 无外部脚本），禁项细化到 `tests/panel.test.mjs`。
- 版本：`package.json` / `.zcode-plugin/plugin.json` / 面板版本字样 → `0.3.0`；`README.md` 面板与桥接章节重写。
- 证据：`.zhll\rt\wp30\panel-proof.log`（C1–C7 逐条 + C4 MCP 往返 + 面板真跑 + C7 越界）、`.zhll\rt\wp30\smoke-v0.3.0.log`、隔离包壳日志 `docs\zcode-mod\evidence\rt-iso-wp30-plugin-smoke.log`（ZCode 检出，gitignored）。
- **面板真跑**（`.zhll\rt\wp30\panel-live.mjs`）：headless Chrome + 假 MCP Apps 宿主（按 wire 形状回 `ui/initialize` / `tools/call`），37 项断言全过——四屏可见、三徽标按假数据面渲染、规则表 2 行 5 列、策略框回填真源、清空策略先弹确认、手改提示横幅与文案、回填按钮可用且点开二次确认、取消后不写、切屏只显示一屏、连上后无禁用按钮，外加 fail-closed 场景（工具回 -32002 时徽标写「读取被拒绝」并显示服务端原话）。这条补的是静态断言抓不到的行为面，开发中真抓到一个渲染 bug（整行说明被渲染成内容为 `5` 的单元格），已修并加静态回归断言。
- 四个参照实现（`rules-engine.mjs` / `agents-section.mjs` / `export-agents.mjs` / `permission-rules.mjs`）**未改一行**，sha256 与 ZCode 检出全等。

## 0.2.1（2026-10-30）

hook 入口兜底 + selfcheck「config 无手工接线」（M2 · R1）：

- `rules.default.json`（仓根）：内置空规则（`version:1` / `unmatched:"abstain"` / `onTimeout:"deny"` / `watchdogMs:120000` / `rules:[]`），作为数据目录还没有 `rules.json` 时的兜底内容基线，过 `validateRules`。
- `src/hooks/permission-rules-entry.mjs`：PermissionRequest hook 入口 launcher——同步读全量 stdin；`<data>/rules.json` 存在则用，否则用 `${ZCODE_PLUGIN_ROOT}/rules.default.json`（`--default` 可覆盖，`--data`/`--root` 缺省回退 `ZCODE_PLUGIN_DATA`/`ZCODE_PLUGIN_ROOT`）；两者皆缺 → 输出合法 abstain（无 decision + systemMessage）exit 0；委托参考 hook 时 stdin 原文透传、原样转发 stdout/stderr、继承 0/2 退出码；launcher 自身异常（含委托失败/输出非法 JSON）→ 显式 abstain + stderr + exit 0，不创建/不写任何文件、不持有定时器。
- `.zcode-plugin/plugin.json` v0.2.1：hooks 命令改为 `permission-rules-entry.mjs --data "${ZCODE_PLUGIN_DATA}" --root "${ZCODE_PLUGIN_ROOT}" --watchdog-ms 120000`。
- `src/mcp/operations.mjs`：`runSelfcheck` 新增 `config-no-manual-hooks` 检查——`hooks.events.PermissionRequest` 为非空数组时给 warning（「config 含手工 PermissionRequest 接线（A 路线残留？）」），config 缺失/该键缺省/空数组通过，非法 JSON 给 warning（无法确认）；`rules.json` 缺失时新增 `rules-default` info（使用内置空规则）；新增 `configPath` 参数与 `defaultCliConfigPath()`。
- `src/mcp/server.mjs`：`selfcheck_run` 接受可选 `configPath`（测试/诊断用），默认仍读 `os.homedir()/.zcode/cli/config.json`。
- `ui/panel.html`：版本号更新为 v0.2.1。
- 测试：新增 `tests/entry.test.mjs`（11 例，spawn 真进程覆盖缺规则 abstain / allow / deny 转发 / 非法规则短 watchdog exit 2 / stdin 原文透传 / default 回退与优先级 / 委托失败 fail-safe）；`tests/operations.test.mjs` 追加 5 例（config 有/无手工接线、空数组、非法 JSON、内置空规则 info）；`node --test tests/` 共 86 例全绿。
- 隔离安装冒烟（directory 市场 → validate → install → list --verbose（hooks: 1）→ uninstall --force → 三处清净）通过，真实 home 指纹零差异；证据 `.zhll\rt\wp26\hook-entry-matrix.{mjs,log}`、`.zhll\rt\wp26\smoke-plugin-v0.2.1.log`（ZCode 检出，gitignored）。
- 四个参照实现（`rules-engine.mjs` / `agents-section.mjs` / `export-agents.mjs` / `permission-rules.mjs`）**未改一行**，sha256 与 ZCode 检出全等。

## 0.2.0（2026-10-30）

插件壳与数据面（M2）：

- `.zcode-plugin/plugin.json` v0.2.0 清单：`hooks`（PermissionRequest 判定，命令含 `${ZCODE_PLUGIN_ROOT}` / `${ZCODE_PLUGIN_DATA}` 展开）、`mcpServers`（stdio，零依赖）、`ui.surfaces`（`ui://zcode-rules/panel.html`，session 级）、`userConfig`（`enabled` / `watchdogSeconds`）。
- `src/rules/sections.mjs`：通用命名哨兵双段引擎（`locateNamedSection` / `upsertNamedSection` / `removeNamedSection` / `sectionSnapshot`）。`zcode-rules` 段哨兵从 `rules-engine.mjs` import，与既有投影逐字兼容；`zcode-content-policy` 段承载自由文本；段外字节不动、幂等、保留 CRLF/LF、残缺哨兵 refused。
- `src/mcp/operations.mjs`：数据面（全部显式传路径）——`loadRules` / `saveRules`（`validateRules` 校验，非法拒绝写入）、`loadPolicy` / `savePolicy`、`exportAgents`（双哨兵投影，缺文件创建只含两段的文件）、`runSelfcheck`（规则合法 / 策略空非空 / 两段手改检测 / AGENTS.md >90 KiB 预警 / 版本号）、`renderPanelHtml`。
- `src/mcp/server.mjs`：零依赖换行分隔 JSON-RPC 2.0 stdio MCP server；支持 `initialize`、通知、`ping`、`tools/list`、`tools/call`、`resources/list`、`resources/read`；6 个工具（`rules_read` / `rules_write` / `content_policy_read` / `content_policy_write` / `export_agents` / `selfcheck_run`）+ 1 个 UI 资源；数据目录缺失时工具调用 fail-closed（-32002）。
- `ui/panel.html`：静态占位面板（标题、版本、数据目录与状态说明、「面板四屏在 M3 实现」），无假按钮、无脚本。
- 新增测试 `tests/sections.test.mjs`、`tests/operations.test.mjs`、`tests/mcp-server.test.mjs`（共 41 例，含 spawn server 的协议往返）；`node --test tests/` 共 70 例全绿。
- 更新 `package.json`（0.2.0、`start:mcp` 脚本）、`README.md`（结构/安装/空规则=零行为变化/MCP 数据面/双哨兵）、`CHANGELOG.md`。
- 隔离安装冒烟（directory 市场 → install → list --verbose → uninstall → 三处清净）通过，真实 home 指纹零差异；证据 `.zhll\rt\wp25\smoke-plugin-v0.2.0.log`（ZCode 检出，gitignored）。
- 四个参照实现（`rules-engine.mjs` / `agents-section.mjs` / `export-agents.mjs` / `permission-rules.mjs`）**未改一行**，sha256 与 ZCode 检出全等。

## 0.1.0（2026-10-30）

初始骨架：

- 参照实现逐字节迁入（sha256 与 ZCode 检出 `docs/zcode-mod/selfcheck/` 对应文件全等）：
  - `src/rules/rules-engine.mjs`（规则校验 `validateRules`、hook 判定 `evaluate`、AGENTS.md 段投影 `renderAgentsSection`、单一性自检 `consistencyCheck`、指纹 `fingerprintRules`）
  - `src/rules/agents-section.mjs`（`locateSection` / `upsert` / `removeSection` / `removeSectionBySentinels`，含 UTF-8 字节 vs UTF-16 码元与 `sep` 回退）
  - `src/rules/export-agents.mjs`（导出/卸载 CLI）
  - `src/hooks/permission-rules.mjs`（PermissionRequest hook，三态输出 + 看门狗）
- 首批单元测试（`node:test` + `node:assert/strict`，夹具全部内联，零依赖、离线可跑）：
  - `tests/rules-engine.test.mjs`
  - `tests/agents-section.test.mjs`
- 工程骨架：`package.json`（零运行时依赖）、`README.md`、`LICENSE`（MIT）、`.gitignore`。
- 测试入口 `tests/index.js`：`node --test tests/`（Node 21–24.20 存在目录参数回归 nodejs/node#64555）的兼容入口，仅导入全部 `*.test.mjs`，不改变测试内容。
- 不含：插件壳（`.zcode-plugin/plugin.json`）、面板 UI、MCP 数据通道、内容策略段。机制验证与运行期判据仍留在 ZCode 检出 `docs/zcode-mod/`，按路线图 M2 起迁入本仓库。


