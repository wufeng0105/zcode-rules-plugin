// 实验包壳：前置快照 → 用隔离配方跑子命令 → 后置快照 → 对账 → 落一份五段头日志。
//
// 用法：
//   node run-with-fingerprint.mjs --label <名字> [--legacy-recipe] [--evidence-dir <dir>] -- <命令> [参数...]
//
// 退出码（透传语义，便于门禁判）：
//   0  子命令成功 且 指纹零差异
//   1  子命令非零退出（实验本身失败）  或  指纹有差异（写脏真实目录）
//   2  环境不可用（指纹 fail-closed / 子命令无法启动）
//
// 隔离配方（RECIPE，2026-10-30 修正后）——三组变量缺一不可：
//   ZCODE_DESKTOP_APPLICATION_NAME        单实例锁按运行时身份生效
//   ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA=1
//   ZCODE_DESKTOP_HOME_DIR                settingService 认这个（只管 v2 半边）
//   ZCODE_DATA_BASE_DIR                   业务数据根（provider/凭据/遥测）
//   HOME / USERPROFILE                    ★ 关键：agent 侧 CLI 存储走 homedir()，
//                                          只有这两个能管住 cli/{db,memories,rollout,plugins}
//   --user-data-dir                       Chromium profile（GUI 场景由调用方拼进命令）
//
// --legacy-recipe：故意**不设** HOME/USERPROFILE，用于 J2-4 反向用例
//   （证明"报告零差异"不是因为压根没检查；旧配方必须报出差异）。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", "..");
const FINGERPRINT = path.join(HERE, "fingerprint.mjs");

function parseArgs(argv) {
  const opts = { label: "run", legacyRecipe: false, evidenceDir: null, base: null, command: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      opts.command = argv.slice(i + 1);
      break;
    }
    if (a === "--label") {
      opts.label = argv[i + 1];
      i += 2;
      continue;
    }
    if (a === "--legacy-recipe") {
      opts.legacyRecipe = true;
      i += 1;
      continue;
    }
    if (a === "--evidence-dir") {
      opts.evidenceDir = argv[i + 1];
      i += 2;
      continue;
    }
    if (a === "--base") {
      opts.base = argv[i + 1];
      i += 2;
      continue;
    }
    i += 1;
  }
  return opts;
}

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (error) => resolve({ code: 2, stdout, stderr: `${stderr}${error.message}` }));
    child.on("exit", (code) => resolve({ code: code ?? 2, stdout, stderr }));
  });
}

function runCommand(command, env) {
  return new Promise((resolve) => {
    if (command.length === 0) {
      resolve({ code: 2, stdout: "", stderr: "没有子命令（-- 之后为空）" });
      return;
    }
    const started = Date.now();
    const child = spawn(command[0], command.slice(1), {
      cwd: REPO,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (error) =>
      resolve({ code: 2, durationMs: Date.now() - started, stdout, stderr: `${stderr}${error.message}` }),
    );
    child.on("exit", (code) =>
      resolve({ code: code ?? 2, durationMs: Date.now() - started, stdout, stderr }),
    );
  });
}

const opts = parseArgs(process.argv.slice(2));
const runRoot = path.join(REPO, ".zhll", "rt", "iso-runs", opts.label);
const home = path.join(runRoot, "home");
const data = path.join(runRoot, "data");
const logs = path.join(runRoot, "logs");
const ud = path.join(runRoot, "ud");
for (const d of [home, data, logs, ud]) mkdirSync(d, { recursive: true });

// ---- 隔离配方 ----
const base = { ...process.env };
const isolated = {
  ...base,
  HOME: home,
  NO_COLOR: "1",
  USERPROFILE: home,
  ZCODE_DATA_BASE_DIR: data,
  ZCODE_DESKTOP_APPLICATION_NAME: "ZCode ISO Probe",
  ZCODE_DESKTOP_HOME_DIR: home,
  ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA: "1",
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  ZCODE_LOG_DIR: logs,
};
const legacy = {
  ...base,
  // 安全复刻 2026-10-30 00:21:40 那次污染的**机制**，而不是复刻污染的**后果**：
  //   · 不设 HOME（保持"配方只给了 ZCODE_DESKTOP_HOME_DIR"这一原始条件）
  //   · USERPROFILE 指向 --base 指定的影子 home，于是 homedir() 解析到影子 home，
  //     真实 ~/.zcode 零触碰，而"只设 ZCODE_DESKTOP_HOME_DIR 管不住 homedir()"依然被完整复现
  // 若不给 --base，则退回真实 USERPROFILE —— 那种用法会真的污染，禁止在门禁里用。
  USERPROFILE: opts.base ?? base.USERPROFILE,
  NO_COLOR: "1",
  ZCODE_DATA_BASE_DIR: data,
  ZCODE_DESKTOP_APPLICATION_NAME: "ZCode ISO Probe",
  ZCODE_DESKTOP_HOME_DIR: home,
  ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA: "1",
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  ZCODE_LOG_DIR: logs,
};
const childEnv = opts.legacyRecipe ? legacy : isolated;

const evidenceDir = opts.evidenceDir
  ? path.resolve(REPO, opts.evidenceDir)
  : path.join(REPO, "docs", "zcode-mod", "evidence");
mkdirSync(evidenceDir, { recursive: true });

const beforePath = path.join(runRoot, "fingerprint-before.json");
const afterPath = path.join(runRoot, "fingerprint-after.json");
const optional = ["cli-db-wal", "cli-db-shm"];

// 1) 前置快照（用"真实"环境，不是隔离环境 —— 我们关心的是真实目录）
const snapBefore = await runNode(
  [FINGERPRINT, "--snapshot", beforePath, "--label", `${opts.label}-before`, ...(opts.base ? ["--base", opts.base] : []), ...optional.flatMap((o) => ["--optional", o])],
  base,
);
if (snapBefore.code === 2) {
  process.stderr.write(`FAIL-CLOSED: 前置快照不可用，拒绝继续实验\n${snapBefore.stderr}\n`);
  process.exit(2);
}

// 2) 跑子命令
const run = await runCommand(opts.command, childEnv);

// 3) 后置快照
const snapAfter = await runNode(
  [FINGERPRINT, "--snapshot", afterPath, "--label", `${opts.label}-after`, ...(opts.base ? ["--base", opts.base] : []), ...optional.flatMap((o) => ["--optional", o])],
  base,
);

// 4) 对账
let compareCode = 2;
let compareOut = "";
if (snapAfter.code === 0) {
  const cmp = await runNode([FINGERPRINT, "--compare", beforePath, afterPath], base);
  compareCode = cmp.code;
  compareOut = `${cmp.stdout}${cmp.stderr}`;
} else {
  compareOut = `后置快照 fail-closed（exit ${snapAfter.code}），无法对账：\n${snapAfter.stderr}`;
}

// 5) 落日志（五段头）
const logPath = path.join(evidenceDir, `rt-iso-${opts.label}.log`);
const lines = [];
lines.push("# cmd:");
lines.push(`node docs/zcode-mod/isolation/tools/run-with-fingerprint.mjs --label ${opts.label}${opts.legacyRecipe ? " --legacy-recipe" : ""} -- ${opts.command.join(" ")}`);
lines.push("# exit:");
lines.push(`fingerprint.compare=${compareCode}  child=${run.code}  综合=${compareCode !== 0 ? compareCode : run.code}`);
lines.push("# env:");
lines.push(`recipe=${opts.legacyRecipe ? "legacy(缺 HOME；USERPROFILE 指向影子 home，安全复刻)" : "isolated(完整配方：HOME+USERPROFILE+ZCODE_DESKTOP_HOME_DIR+ZCODE_DATA_BASE_DIR)"}`);
lines.push(`HOME=${opts.legacyRecipe ? "<未设置>" : home}`);
lines.push(`USERPROFILE=${opts.legacyRecipe ? (opts.base ?? "<未设置>") + "  ← 影子 home（安全复刻，非真实目录）" : home}`);
lines.push(`ZCODE_DESKTOP_HOME_DIR=${home}`);
lines.push(`ZCODE_DATA_BASE_DIR=${data}`);
lines.push(`ZCODE_DESKTOP_APPLICATION_NAME=ZCode ISO Probe`);
lines.push(`ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA=1`);
lines.push(`ZCODE_LOG_DIR=${logs}`);
lines.push("# input:");
lines.push(`子命令=${opts.command.join(" ") || "<空>"}`);
lines.push(`前置快照=${beforePath}`);
lines.push(`后置快照=${afterPath}`);
lines.push(`指纹目标=cli/db/db.sqlite(REQUIRED), cli/db/db.sqlite-wal(optional), cli/db/db.sqlite-shm(optional), AGENTS.md(REQUIRED)`);
lines.push("# repro:");
lines.push(`node docs/zcode-mod/isolation/tools/run-with-fingerprint.mjs --label ${opts.label}${opts.legacyRecipe ? " --legacy-recipe" : ""} -- ${opts.command.join(" ")}`);
lines.push("# runtime:");
lines.push(`node=${process.version}`);
lines.push(`repo=${REPO}`);
lines.push(`runRoot=${runRoot}`);
lines.push("");
lines.push("--- 前置快照 ---");
lines.push(snapBefore.stdout.trim());
lines.push("");
lines.push(`--- 子命令输出（exit=${run.code} durationMs=${run.durationMs ?? "?"}）---`);
lines.push("stdout:");
lines.push(run.stdout.trim() || "<empty>");
lines.push("stderr:");
lines.push(run.stderr.trim() || "<empty>");
lines.push("");
lines.push("--- 后置快照 ---");
lines.push(snapAfter.stdout.trim() || `<failed exit=${snapAfter.code}>`);
if (snapAfter.stderr.trim()) lines.push(snapAfter.stderr.trim());
lines.push("");
lines.push("--- 对账（EXIT " + compareCode + "）---");
lines.push(compareOut.trim());

writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");

process.stdout.write(`[${opts.label}] recipe=${opts.legacyRecipe ? "legacy" : "isolated"} child=${run.code} compare=${compareCode}\n`);
process.stdout.write(`log → ${logPath}\n`);
process.stdout.write(compareOut.split("\n").slice(0, 6).join("\n") + "\n");

if (compareCode !== 0) process.exit(compareCode === 2 ? 2 : 1);
process.exit(run.code === 0 ? 0 : 1);
