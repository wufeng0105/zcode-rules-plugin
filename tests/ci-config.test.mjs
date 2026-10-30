// CI 配置的静态回归（判据 C5）：workflow 的语义必须仍是「三步 node、零依赖、ubuntu + node 24」。
//
// 为什么要测：CI 是本仓库唯一的外部可见门禁。它一旦被悄悄改成「先装依赖再跑测试」，
// 仓库「零依赖、离线可跑」这条对外承诺就变成假的；而 YAML 改动不会让任何运行期测试变红。
//
// 纪律：只读仓库内文本，不联网、不调用 GitHub API、不执行 workflow。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CI_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const RAW = readFileSync(CI_PATH, "utf8");

// 只保留 YAML 语义行：注释里提到「npm install」不该被当成分依赖（也不该被当挡箭牌）。
const BODY = RAW.split(/\r?\n/u)
  .filter((line) => !/^\s*#/u.test(line))
  .join("\n");
const RUN_STEPS = [...BODY.matchAll(/^\s*run:\s*(.+)$/gmu)].map((m) => m[1].trim());
const USES = [...BODY.matchAll(/uses:\s*(\S+)/gu)].map((m) => m[1].trim());

describe(".github/workflows/ci.yml（判据 C5）", () => {
  test("runner 与 Node 版本：ubuntu-latest + node 24（与作者本机一致）", () => {
    assert.match(BODY, /^\s*runs-on:\s*ubuntu-latest\s*$/mu);
    assert.match(BODY, /node-version:\s*'?24'?\s*$/mu);
  });

  test("恰好三个 run 步骤，且分别就是三段门禁", () => {
    assert.equal(RUN_STEPS.length, 3, `实际 run 步骤：${JSON.stringify(RUN_STEPS)}`);
    assert.deepEqual(RUN_STEPS, [
      "node scripts/verify-fidelity.mjs",
      "node scripts/check-docs.mjs",
      "node --test tests/",
    ]);
  });

  test("零依赖：没有任何 npm / pnpm / yarn 安装命令", () => {
    assert.doesNotMatch(BODY, /\b(npm|pnpm|yarn)\s+(install|ci|i|add)\b/u);
    assert.doesNotMatch(BODY, /^\s*run:\s*(npm|pnpm|yarn)\b/mu);
    assert.doesNotMatch(BODY, /cache:\s*'?(npm|pnpm|yarn)/u);
  });

  test("只允许两个 action：checkout 与 setup-node（不引入第三方 action）", () => {
    assert.equal(USES.length, 2, `实际 uses：${JSON.stringify(USES)}`);
    assert.ok(USES.every((u) => /^(actions\/checkout|actions\/setup-node)@/u.test(u)), `意外 action：${JSON.stringify(USES)}`);
  });

  test("触发条件覆盖 push 与 pull_request", () => {
    assert.match(BODY, /^\s*push:\s*$/mu);
    assert.match(BODY, /^\s*pull_request:\s*$/mu);
  });

  test("最小权限：contents: read", () => {
    assert.match(BODY, /permissions:\s*\n\s+contents:\s*read/u);
  });
});
