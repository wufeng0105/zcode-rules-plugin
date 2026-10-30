// 隔离配方的探针子命令（被 run-with-fingerprint.mjs 包壳调用）。
//
// 模拟"agent 侧 CLI 存储走 homedir()"这一真实行为：
//   · 打印 os.homedir() 的解析结果 —— 这是判定"配方有没有管住 homedir()"的直接证据；
//   · 在该 homedir 下写一个探针文件 —— 用于证明写入真的落到哪里；
//   · 用 --no-write 时只解析不写（用于在真实 home 上做"解析证明"而零污染）。
//
// 用法：
//   node probe-child.mjs [--no-write] [--tag <name>]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const noWrite = argv.includes("--no-write");
const mimicSqlite = argv.includes("--mimic-sqlite");
const tagIndex = argv.indexOf("--tag");
const tag = tagIndex >= 0 ? argv[tagIndex + 1] : "default";

const home = homedir();
const envHome = process.env.HOME;
const envUserProfile = process.env.USERPROFILE;
// 模拟 agent 侧 CLI 存储位置：adapters/src/config/file-config.adapter.ts:62,67-72 的
// DEFAULT_BASE_DIR="~/.zcode/cli" → homedir()
const cliRoot = path.join(home, ".zcode", "cli");
const probeFile = path.join(cliRoot, "iso-probe", `${tag}.txt`);

process.stdout.write(`[probe-child] tag=${tag}\n`);
process.stdout.write(`[probe-child] os.homedir()      = ${home}\n`);
process.stdout.write(`[probe-child] env.HOME          = ${envHome ?? "<unset>"}\n`);
process.stdout.write(`[probe-child] env.USERPROFILE   = ${envUserProfile ?? "<unset>"}\n`);
process.stdout.write(`[probe-child] 派生 CLI 存储根   = ${cliRoot}\n`);
process.stdout.write(`[probe-child] 目标探针文件      = ${probeFile}\n`);

if (noWrite) {
  process.stdout.write("[probe-child] --no-write：只解析，不写盘（零污染）\n");
  process.exit(0);
}

if (mimicSqlite) {
  // 精确复刻 2026-10-30 00:21:40 那次污染的**机制**：
  // agent 侧 SQLite 打开 db.sqlite 时，自动生成 db.sqlite-wal 与 db.sqlite-shm。
  // 真实观测：db.sqlite 主库 mtime 未变，只新增/改写了 -wal（0 B）与 -shm（32768 B）。
  const mainDb = path.join(cliRoot, "db", "db.sqlite");
  const walFile = `${mainDb}-wal`;
  const shmFile = `${mainDb}-shm`;
  process.stdout.write(`[probe-child] --mimic-sqlite：模拟 SQLite 打开 ${mainDb}\n`);
  mkdirSync(path.dirname(mainDb), { recursive: true });
  if (!existsSync(mainDb)) writeFileSync(mainDb, "shadow-main-db", "utf8");
  writeFileSync(walFile, "", "utf8"); // 真实观测：-wal 长度 0
  writeFileSync(shmFile, Buffer.alloc(32768, 0)); // 真实观测：-shm 32768 B
  process.stdout.write(`[probe-child] 已生成 ${path.basename(walFile)} / ${path.basename(shmFile)}\n`);
  process.exit(0);
}

mkdirSync(path.dirname(probeFile), { recursive: true });
writeFileSync(probeFile, `probe tag=${tag}\nhomedir=${home}\nat=${new Date().toISOString()}\n`, "utf8");
process.stdout.write(`[probe-child] 已写入探针文件\n`);
process.exit(0);
