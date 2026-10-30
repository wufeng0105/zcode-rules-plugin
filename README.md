> **空规则 + 空策略 = 零行为变化**：不写任何规则、不写任何内容策略时，本插件不改变 ZCode 的默认行为——未命中一律 abstain（退赛），权限判定仍由产品原逻辑完成。

# zcode-rules-plugin

一句话定位：把「一份规则源、两个出口」做成 ZCode 插件——同一个规则 JSON 既供 `PermissionRequest` hook 判 allow/deny/退赛，又投影成 `AGENTS.md` 里给人读的规则段。

## 当前状态（v0.1.0，骨架）

- 本仓库目前是**骨架**：只包含逐字节迁入的参照实现与首批单元测试，**没有**插件壳（`.zcode-plugin/plugin.json`）、没有面板 UI、没有 MCP 数据通道、没有内容策略段。
- 机制验证、运行期判据与证据仍以 ZCode 检出 `docs/zcode-mod/` 为准（selfcheck、gates、evidence、plan 均在那里）；ZCode 检出对本仓库而言**只读**，本仓库不回改它。
- 后续（路线图 M2 起）：插件 manifest + hooks 搬移 → MCP 数据面 → 双哨兵投影（`zcode-rules` + `zcode-content-policy`）→ 面板四屏。

## 目录

```
src/
  rules/
    rules-engine.mjs      # 校验 / 判定 / AGENTS.md 段投影 / 一致性自检
    agents-section.mjs    # 段的定位、幂等 upsert、按 meta 或哨兵摘除
    export-agents.mjs     # 导出与卸载 CLI（node src/rules/export-agents.mjs --help 语义见文件头）
  hooks/
    permission-rules.mjs  # PermissionRequest hook：allow / deny / abstain 三态 + 看门狗
tests/
  rules-engine.test.mjs
  agents-section.test.mjs
```

## 测试

```pwsh
# 仓库根目录执行；零依赖、离线可跑（只用 node: 内置模块）
node --test tests/
```

测试夹具全部**内联**在测试文件里，不读取 ZCode 检出、不读取真实 home、不写临时目录之外的位置。

> `tests/index.js` 是 Node 21–24.20 的目录参数兼容入口：上游回归（[nodejs/node#64555](https://github.com/nodejs/node/issues/64555)）里 `node --test <目录>` 会把目录当中单个文件执行并 `MODULE_NOT_FOUND`；该文件只按文件名导入全部 `*.test.mjs`，不改变任何测试内容。上游修复后（或 Node 20）它不会被测试发现机制匹配到。

## 来源与保真

`src/` 下四个文件是从 ZCode 检出 `docs/zcode-mod/selfcheck/` 原样复制的（**不改一行**）：

| 本仓库文件 | 来源（ZCode 检出，只读） | sha256 |
| --- | --- | --- |
| `src/rules/rules-engine.mjs` | `docs/zcode-mod/selfcheck/rules/rules-engine.mjs` | `8d28407ec7feecfefc93975d0be5446c59ef64cf4921040acc5556ee293980bb` |
| `src/rules/agents-section.mjs` | `docs/zcode-mod/selfcheck/rules/agents-section.mjs` | `3088e7d0692b5703dc8ee77107f6c4eb32a5c01569c076992b417ae1ca4d599f` |
| `src/rules/export-agents.mjs` | `docs/zcode-mod/selfcheck/rules/export-agents.mjs` | `22f4a0c0a71e8cdbe912b614da0c286a0a3e3f0973dbfdf9ea068a017781b51a` |
| `src/hooks/permission-rules.mjs` | `docs/zcode-mod/selfcheck/hooks/permission-rules.mjs` | `a8c2121e6e6118cb506faa3e3842527df50fb866f74aa4f7c12c62fb7e464b23` |

保真校验（在仓库根执行）：

```pwsh
Get-FileHash -Algorithm SHA256 src\rules\rules-engine.mjs, src\rules\agents-section.mjs, src\rules\export-agents.mjs, src\hooks\permission-rules.mjs
```

## 许可

MIT，见 [LICENSE](LICENSE)。
