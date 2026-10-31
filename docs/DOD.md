# 验收判据逐条核销（DoD）

> 这是本插件的**验收判据表**与逐条结论。每条都指向**可复跑的证据**（命令或日志），第三方可用 [`REPRODUCE.md`](REPRODUCE.md) 的入口自己复跑。
> 判据原文出自 ZCode 客户端改造项目 ROADMAP §四（DoD D-1..D-10）。

## 核销总表

| DoD | 判据 | 结论 | 证据（可复跑） |
| --- | --- | --- | --- |
| **D-1** | GitHub 市场源添加→列表出现→一键安装成功 | ✅ | `plugins marketplace add` → `Added marketplace … (1 plugins)`；`plugins install` → `Installed plugin zcode-rules@<market> (0.4.1) [enabled]`；`plugins list --verbose` → `hooks: 1` + `mcp: plugin:zcode-rules:zcode-rules`。**并从公开远端真 clone 演练过整条全新机器剧本**（见 REPRODUCE §一） |
| **D-2** | 空规则+空策略下会话行为与未装一致（abstain 实证），面板首屏/README 首行写明 | ✅ | 空规则时 hook 输出 `{"hookSpecificOutput":{"hookEventName":"PermissionRequest"},"systemMessage":"zcode-rules: abstain (no rule matched, unmatched=abstain (产品原行为))"}` —— **不产出 decision**，不改变产品判定；面板首屏与 README 首行均写明「零行为变化」 |
| **D-3** | 面板写第一条 allow 规则→新会话命中不弹窗且执行（permission.resolved 证据） | ✅ | 真会话日志 `tool.permission.resolved`：`decision=allow`、`reason=Allowed by PermissionRequest hook`（客户端被故意延迟 8s 答 deny，仍由 hook 抢先放行；**对照组**：禁用插件后同配置不执行） |
| **D-4** | 内容策略保存→请求体含 `zcode-content-policy` 段 marker | ✅ | 经 MCP `exportAgents`（= 面板「保存策略」同一入口）投影后，`AGENTS.md` 含 `BEGIN zcode-content-policy` / 段内策略正文 / `END zcode-content-policy`，且 rules 段未被破坏 |
| **D-5** | 手改 AGENTS.md 段→「运行检查」提示不覆盖 | ✅ | 手改段内文字 → 自检 `policy-section = warn`（「可能被手改，或策略改了没重新导出」），且**文件字节未被改动**；点「用真源覆盖」后逐字节回基线，自检转 `ok` |
| **D-6** | 卸载后 cache/installed/enabledPlugins 清净 + AGENTS.md sha 不变 | ✅（口径见下） | 三处清净：cache 下该插件**文件数 0**、`installed_plugins.json` 无该 id、`enabledPlugins` 无该 id；`export-agents --uninstall` **逐字节**回装前状态（**必须带 `--state`**，否则 exit 2） |
| **D-7** | 换 plugin version 重装真源保留、投影幂等；ZCode 升级后自检三态可判 | ✅ | 前半：v0.4.0 → v0.4.1 **真实升级**（带实质变更：新增自检项 `data-dir`）—— `rules.json` / `content-policy.json` **字节不变**、`AGENTS.md` 重投影 sha 不变、自检含新项且 `version=v0.4.1`、产物逐文件指纹一致。后半：自检**三态**各自可触发且可区分（正常 `errors=0` / 手改段 `warn` / 非法规则 `error` 且 `summary.errors≥1`） |
| **D-8** | 全程 `C:\Program Files\ZCode` 文件 mtime 不变 | ✅ | 逐文件（相对路径 + size + mtimeMs）聚合 digest，升级前后**完全一致**。**口径说明**：ROADMAP 写的 1410 是当时快照数，实测 1433 —— 判据以「逐文件 digest 前后一致」为准 |
| **D-9** | 公开仓库含 LICENSE/README/CHANGELOG/tag，CI 绿 | ✅ | 本仓（PUBLIC / MIT / main / 描述 / 6 个 tag）；CI **三平台矩阵**：ubuntu + macos + windows × Node 24，每个平台都是「保真 exit 0 + 文档 exit 0 + **pass 173 / fail 0**」 |
| **D-10** | 全部证据日志的 repro 命令指向仓库内文件，第三方可复现 | ✅（实质满足） | 历史门禁日志**原样保留**（改写历史 = 伪造证据）；改为提供本仓的复跑入口：`REPRODUCE.md`（逐条判据 → 仓库内可复跑文件/命令）+ `../scripts/proof/` 三份路径全环境变量化的判据驱动 + `../scripts/tools-list-probe.mjs`（stdio MCP 可靠探针） |

## 三条「口径澄清」（产品边界，不是缺陷）

1. **产品卸载不摘 `AGENTS.md` 的段** —— 卸载只清插件自身注册；段仍会注入模型上下文，**需用户自己删**（D-6）。
2. **规则只对「会被询问的命令」起作用** —— 产品有只读命令白名单（**74 个**，由 46 个任意参数命令 + 49 个策略命令去重而来；另有 `docker images`/`docker ps` 前缀与 git/gh 多词子命令），走免询问路径，hook 没有参与机会（D-2 相关，完整清单见 REPRODUCE §三）。
3. **`plugins install` 对已装 id 是原地升级** —— 「卸载会删数据目录」是 **uninstall** 的语义；两者不要混为一谈（D-7）。

## 未覆盖范围（如实声明）

**产品边界**（能力所不及，非本插件缺陷）：

- **`guarded` 档位**：该档位下危险命令绕过 hook。
- **`-p` 无人值守面**：无权限客户端时 hook 会被竞速取消。
- **GUI 弹窗路径**：结论在 Host↔CLI 协议面成立；GUI 是另一种客户端实现，走同一 broker 竞速路径（面板本身已在真实桌面宿主验证过，见下）。
- **内容策略不是沙箱**：它是给模型读的提示文本，真正强制的是 hook 的 allow/deny。

**验证覆盖不足**（本项目未做到的）：

- **macOS / Linux 完整实机剧本**：CI 在三平台跑「保真 + 文档 + 单测」三步全绿，但**「第三方全新机器安装剧本」只在 Windows 实机跑过**（含 Windows 特有的 `cmd /c`、路径写法）。macOS/Linux 的完整安装链路属间接证据。
- **面板验证不可自动重跑**：面板四屏已在真实 ZCode 宿主经用户实操截图验证（5 张，见验证记录），但该验证**依赖人工操作**，无自动化驱动（CDP 路径未打通：`mcp/uiOpenInstance` 需 `ownerWebContentsId`，仅真 GUI 渲染进程可给）。
- **国际化（i18n）**：面板与文档为纯中文，无英文界面；未测试非中文环境下的显示。

详细结论与每条的验证方式见 [`VERIFICATION.md`](VERIFICATION.md)；复跑入口见 [`REPRODUCE.md`](REPRODUCE.md)。
