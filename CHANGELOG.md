# CHANGELOG

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
