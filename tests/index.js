// tests/index.js —— `node --test tests/`（本仓库 package.json 的 test 脚本）的目录入口。
//
// 为什么需要这个文件：
//   Node 21 把测试文件发现改为内部 glob 实现后，`node --test <目录>` 会把目录本身
//   当成一个测试文件去执行，在 Windows 上直接 MODULE_NOT_FOUND（nodejs/node#64555，
//   上游已修复但本机 Node v24.20.0 仍受影响）。package.json 的 test 脚本是
//   `node --test tests/`，故用本文件作目录入口：由它导入全部 *.test.mjs。
//
// 影响面（只在"目录参数"这条路径上生效，不改变测试语义）：
//   · Node 20：目录扫描只收默认测试文件名模式，本文件不会被执行；
//   · 上游修复后的 Node：目录参数展开为 <dir>/**/*.test.*，本文件同样不会被匹配；
//   · Node 21–24.20：本文件是唯一能让 `node --test tests/` 跑起来的入口。
//
// 新增测试文件不需要改这里：按文件名排序全量导入。
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));

for (const entry of readdirSync(dir).sort()) {
  if (entry.endsWith(".test.mjs")) {
    await import(pathToFileURL(join(dir, entry)).href);
  }
}
