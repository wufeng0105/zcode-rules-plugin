// v0.4.1 新增能力：自检项 `data-dir`（数据目录可见性）
//
// 背景：插件可能以不同 id / 不同市场源安装（目录市场 vs GitHub 源），
// 数据目录名随之不同。「规则不生效」的第一排查动作是确认自己的规则存在哪，
// 但此前自检只在出错时提 data-dir，正常路径下用户看不到数据目录在哪。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runSelfcheck } from "../src/mcp/operations.mjs";

const KEPT = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-rules-datadir-"));
  KEPT.push(dir);
  return dir;
}
function cleanup() {
  for (const dir of KEPT.splice(0)) rmSync(dir, { recursive: true, force: true });
}
test.after(cleanup);

function selfcheckIn(dir, agentsPath) {
  return runSelfcheck({
    agentsPath,
    dataDir: dir,
    configPath: join(dir, "config.json"),
  });
}

test("data-dir 项存在且报出数据目录绝对路径", () => {
  const dir = tempDir();
  const agents = join(dir, "AGENTS.md");
  writeFileSync(agents, "# fixture\n", "utf8");
  const sc = selfcheckIn(dir, agents);
  const item = sc.checks.find((c) => c.id === "data-dir");
  assert.ok(item, "自检应含 data-dir 项");
  assert.equal(item.level, "ok");
  assert.ok(item.detail, "data-dir 项应带 detail（数据目录路径）");
  assert.ok(item.detail.includes(dir), "detail 应含数据目录路径", item.detail);
  assert.ok(item.message.includes("数据目录"), "message 应说明这是数据目录");
});

test("data-dir 区分「真源已存在」与「尚未创建」", () => {
  const dir = tempDir();
  const agents = join(dir, "AGENTS.md");
  writeFileSync(agents, "# fixture\n", "utf8");

  const before = selfcheckIn(dir, agents).checks.find((c) => c.id === "data-dir");
  assert.match(before.message, /规则源尚未创建/);
  assert.match(before.message, /内容策略尚未创建/);

  writeFileSync(join(dir, "rules.json"), JSON.stringify({ version: 1, name: "x", rules: [] }), "utf8");
  writeFileSync(join(dir, "content-policy.json"), JSON.stringify({ version: 1, text: "" }), "utf8");
  const after = selfcheckIn(dir, agents).checks.find((c) => c.id === "data-dir");
  assert.match(after.message, /规则源已存在/);
  assert.match(after.message, /内容策略已存在/);
});

test("data-dir 项不引入 error（数据目录可读即可，不因缺文件报错）", () => {
  const dir = tempDir();
  const agents = join(dir, "AGENTS.md");
  writeFileSync(agents, "# fixture\n", "utf8");
  const sc = selfcheckIn(dir, agents);
  assert.ok(!sc.checks.some((c) => c.id === "data-dir" && c.level === "error"));
  // 缺 rules.json 只应让 rules-valid 成为 warn（空规则 = 产品原行为），不是 error
  assert.ok(!sc.checks.some((c) => c.id === "rules-valid" && c.level === "error"));
});

test("data-dir 与其他项并存（不替换既有自检项）", () => {
  const dir = tempDir();
  const agents = join(dir, "AGENTS.md");
  writeFileSync(agents, "# fixture\n", "utf8");
  const sc = selfcheckIn(dir, agents);
  const ids = sc.checks.map((c) => c.id);
  for (const expected of ["data-dir", "rules-valid", "policy-state", "version"]) {
    assert.ok(ids.includes(expected), `自检应含 ${expected} 项，实际：${ids.join(",")}`);
  }
});
