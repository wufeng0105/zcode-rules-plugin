# QUICKSTART

> 一页纸：装上、写第一条规则、知道面板在哪、卸载干净、遇到坑怎么办。
> 完整文档见 [README.md](README.md)。

## 1. 装（3 步）

```pwsh
# <CLI> = C:\Program Files\ZCode\resources\glm\zcode.cjs

# ① 添加本仓库为市场源（从 GitHub 直读）
node <CLI> plugins marketplace add wufeng0105/zcode-rules-plugin  # 期望：Added marketplace zcode-rules-plugin (N plugins)
# ② 安装
node <CLI> plugins install zcode-rules@zcode-rules-plugin          # 期望：Installed … (0.4.1) [enabled]
# ③ 确认
node <CLI> plugins list --verbose                                   # 期望含 hooks: 1 与 mcp: plugin:zcode-rules:zcode-rules
```

装完**重启 ZCode**，面板才会出现。

## 2. 第一条规则（3 步）

1. 打开会话 → <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd> → 「插件市场」→ **ZCode 规则** 卡片右上「打开」
2. 「规则表」页 → 编辑 JSON：把 `"rules": []` 改成
   ```json
   "rules": [{ "id": "allow-echo", "tool": "Bash", "commandPattern": "^echo hello$", "decision": "allow" }]
   ```
3. 点「保存规则（写入 → 导出 → 自检）」→ 下方出现三行日志（写入 / 导出 / 自检）

内容策略：在「内容策略」页写自由文本 → 「保存策略（写入 → 导出）」。**对新会话生效**。

## 3. 面板在哪（别再找错）

| 想找 | 在哪 |
| --- | --- |
| 规则表 / 内容策略输入框 / 自检 | **侧边面板**：会话内 `Ctrl+Alt+B` → 插件市场 → 卡片右上「打开」 |
| 启用开关 / 看门狗秒数 | 插件详情页「配置」区（只有这两项，是产品原生控件） |
| 规则没生效时看诊断 | 面板「自检与版本」页 → 「运行检查」 |

**三个走不通的入口**：「立即试用」（只预填提示词）、「应用插件」推荐区（只列官方插件）、详情页「配置」（只有两项）。

## 4. 卸载干净（3 步）

```pwsh
# ① 先备份规则与策略（卸载会删数据目录）
Copy-Item -Recurse "$HOME\.zcode\cli\plugins\data\zcode-rules@zcode-rules-plugin" "$HOME\zcode-rules-backup"
# ② 卸载
node <CLI> plugins uninstall zcode-rules@zcode-rules-plugin --force
# ③ 手工删掉 AGENTS.md 里的两个段（产品卸载不摘段）：
#    <!-- BEGIN zcode-rules … --> … <!-- END zcode-rules -->
#    <!-- BEGIN zcode-content-policy … --> … <!-- END zcode-content-policy -->
```

## 5. 自查（1 条命令）

面板 → 「自检与版本」→ 「运行检查」：九项（数据目录 / 规则合法 / 策略状态 / 配置无手工接线 / `AGENTS.md` 存在 / 尺寸 / 两段投影一致 / 版本一致）。

## 6. 常见坑（5 条）

1. **升级别先卸载**——`uninstall` 会删数据目录（规则与策略会丢）。直接 `plugins install` 同 id 重装即可，数据不动。
2. **升级后旧面板标签报 `ENOENT`**——关掉标签重开，或重启 ZCode（资源路径含版本号）。
3. **规则不生效**——`commandPattern` 是正则且 first-match-wins；不命中就是 abstain（交回 ZCode 原逻辑）。
4. **策略保存后当前会话没变**——`AGENTS.md` 是会话开始时的上下文，新会话才读到。
5. **手改 `AGENTS.md` 段不会被覆盖**——自检只报 `warn`，由你点「用真源覆盖」或「从 AGENTS.md 回填真源」决定。

## 7. 开发

```pwsh
node scripts/verify-fidelity.mjs   # 4 个参照实现逐字节保真
node scripts/check-docs.mjs        # 文档链接检查
node --test tests/                 # 零依赖测试
```

MIT 许可，见 [LICENSE](LICENSE)。
