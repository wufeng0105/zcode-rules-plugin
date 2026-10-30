# 安全策略

## 这个插件做什么、不做什么

这是一个 **ZCode 桌面客户端插件**。它做两件事：

1. 在 `PermissionRequest` 环节给工具调用一个判定（allow / deny / abstain）；
2. 把同一份规则投影成 `~/.zcode/AGENTS.md` 里的两个带哨兵的段，供模型阅读。

**它不做什么**（这些边界是安全属性的一部分）：

- **不修改 ZCode 本体**，不改 `C:\Program Files\ZCode` 或等价安装目录的任何文件。
- **不联网**。没有网络请求、没有遥测、没有外部 API 调用。
- **不读取你不知道的文件**。数据目录只认宿主注入的 `ZCODE_RULES_DATA` / `ZCODE_PLUGIN_DATA`；缺失就 fail-closed，不猜路径。
- **不碰 `AGENTS.md` 段外的内容**。只维护 `zcode-rules` 与 `zcode-content-policy` 两个带哨兵的段。
- **不静默覆盖你的手改**。若 `AGENTS.md` 的段与真源不一致，自检只报 `warn`，由你点「用真源覆盖」或「从 AGENTS.md 回填真源」决定。

## 报告漏洞

**请不要开公开 issue 报告安全问题。**

用 GitHub 的 [私有漏洞报告](https://github.com/wufeng0105/zcode-rules-plugin/security/advisories/new)（Security → Report a vulnerability）。若该功能不可用，请通过仓库 Issues 里的「安全」标签私密联系维护者。

请在报告里给出：

- 受影响版本（tag）；
- 复现步骤；
- 你的 ZCode 版本与操作系统；
- 影响面（是否会导致越权执行命令、覆盖未声明的文件、泄露本机数据等）。

## 权限模型

| 能力 | 由谁控制 | 说明 |
| --- | --- | --- |
| 插件启用 | 用户（产品设置页的 `userConfig.enabled`） | 关闭后 hook 不注入规则，等价空规则 |
| 规则内容 | 用户（面板或直接编辑 `rules.json`） | 规则由用户自己写，插件不预设 |
| `AGENTS.md` 投影 | 用户（面板保存 / `export_agents`） | 卸载**不**摘段，需手动清理 |
| 卸载 | 用户 | 卸载会删插件数据目录（规则与策略真源），**卸载前请备份** |

## 关于 deny 的失败模式

规则非法或 hook 超时时，判定按 `onTimeout=deny` **fail-closed**（拒绝而非放行）。这是刻意选择：宁可让一条命令被挡住，也不要在规则不可用时静默放行高风险操作。

若你认为某个行为不安全（例如担心 deny 误伤），优先在规则里用 `unmatched: "abstain"` 让未命中交回 ZCode 原逻辑，而不是关掉整个插件。

## 已知限制

- **规则匹配是纯正则**，不支持语义判断；复杂策略请用内容策略（自由文本）表达，靠 `AGENTS.md` 段影响模型行为。
- **内容策略不是沙箱**。它是给模型读的提示文本，不是强制约束。真正强制的是 hook 的 allow/deny 判定。
- **本插件不能保护其他插件或 ZCode 自身的行为**，只对自己的规则判定负责。
