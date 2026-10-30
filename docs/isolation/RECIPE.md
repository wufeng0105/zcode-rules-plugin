# 隔离配方（RECIPE）· 桌面 GUI / agent 会话实验专用

> 阶段三件 2 产物。**本文是配方权威**：任何要碰 ZCode 的实验，先按本文设环境变量，再用 `tools/run-with-fingerprint.mjs` 包壳跑。
> 事实来源：`docs/zcode-mod/evidence/rt-gui-report.md` C1 段（2026-10-30 00:21:40 那次真实污染）+ `plan/STAGE3-BREAKDOWN.md` 件 2。

## 一、为什么需要这份配方（一次真实事故）

2026-10-30 00:21:40，一次 GUI 实验只按 wdio e2e 的姿势设了 `ZCODE_DESKTOP_HOME_DIR` + `ZCODE_DATA_BASE_DIR`，结果 **agent 侧 CLI 存储写进了真实 `~/.zcode`**：

| 文件 | 结果 |
| --- | --- |
| `~/.zcode/cli/db/db.sqlite` | **mtime 未变**（2026-10-29 17:41） |
| `~/.zcode/cli/db/db.sqlite-wal` | **被创建/写入，0 B** |
| `~/.zcode/cli/db/db.sqlite-shm` | **被创建/写入，32768 B** |

**机制**（源码）：
- `adapters/src/config/file-config.adapter.ts:62,67-72`：`DEFAULT_BASE_DIR = "~/.zcode/cli"`，`~` 展开走 **`homedir()`**
- `settingService.ts:44-52`：认 **`ZCODE_DESKTOP_HOME_DIR`**
- ⇒ **两个不同源**。只设 `ZCODE_DESKTOP_HOME_DIR` 只重定向了 `v2` 那半边，`cli` 那半边（`db`/`memories`/`rollout`/`plugins`）照样走真实 home。

**验证**：`evidence/rt-iso-red-oldrecipe.log` —— 用同一配方（缺 `HOME`）在影子 home 上复刻，指纹精确抓到 `-wal`/`-shm` 的两个 `[existence]` 差异。

## 二、配方（三组变量，缺一不可）

```powershell
# ★ 1) 真实 home 重定向 —— 管住 homedir() 派生的一切（cli/db、cli/memories、cli/rollout、cli/plugins）
$env:HOME        = "<iso>/home"
$env:USERPROFILE = "<iso>/home"      # Windows 上 homedir() 优先读 USERPROFILE

# 2) ZCode 自己的变量
$env:ZCODE_DESKTOP_HOME_DIR                     = "<iso>/home"   # settingService 认这个（v2 半边）
$env:ZCODE_DATA_BASE_DIR                        = "<iso>/data"   # 业务数据根：provider/凭据/遥测/tasks-index
$env:ZCODE_DESKTOP_APPLICATION_NAME             = "ZCode ISO Probe"  # 单实例锁按运行时身份生效
$env:ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA = "1"
$env:ZCODE_LOG_DIR                              = "<iso>/logs"

# 3) 启动参数（GUI 场景）
#   --user-data-dir=<iso>/ud
#   --remote-debugging-port=9334
#   ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1

# 4) 跑 GUI 前必须清掉继承的 ELECTRON_RUN_AS_NODE
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

### 各变量管哪半边（别记混）

| 变量 | 管住什么 | 管不住什么 |
| --- | --- | --- |
| `HOME` / `USERPROFILE` | **agent 侧 CLI 存储**：`~/.zcode/cli/{db,memories,rollout,plugins}`、用户级 `~/.zcode/AGENTS.md` | Electron/Chromium profile |
| `ZCODE_DESKTOP_HOME_DIR` | `settingService` 那条：`v2/setting.json` 等 | `cli/**`（这就是事故根因） |
| `ZCODE_DATA_BASE_DIR` | provider / 凭据 / 遥测 / `tasks-index.sqlite` | **用户级 `AGENTS.md`**（它走 `HOME`）、`cli/**` 的其余部分 |
| `--user-data-dir` | Chromium profile（Cache/Local Storage 等） | 上面所有 `~/.zcode/**` |
| `ZCODE_LOG_DIR` | 运行时 JSONL 日志落点 | — |

> **R-22 的额外提醒**：用户级 `~/.zcode/AGENTS.md` 走 `HOME`，**不跟** `ZCODE_DATA_BASE_DIR`（`rt-22-capture-attribution.json` 实测 marker=0 反证）。

## 三、实验前置指纹（强制流程）

**任何实验都必须**：前置快照 → 跑 → 后置快照 → 对账，且**对账必须 exit 0**。

```powershell
node docs\zcode-mod\isolation\tools\run-with-fingerprint.mjs `
  --label <实验名> `
  -- <你的命令与参数>
```

这条命令做四件事：① 用**真实环境**做前置快照 ② 用**隔离配方**跑子命令 ③ 后置快照 ④ 对账并写 `docs/zcode-mod/evidence/rt-iso-<label>.log`（五段头）。

退出码：`0` 子命令成功且指纹零差异 ｜ `1` 子命令失败**或**指纹有差异 ｜ `2` 环境不可用（fail-closed）。

### 指纹清单（J2-1，用户点名要求）

| id | 文件 | 必需性 |
| --- | --- | --- |
| `cli-db` | `~/.zcode/cli/db/db.sqlite` | **REQUIRED** |
| `cli-db-wal` | `~/.zcode/cli/db/db.sqlite-wal` | optional（空闲 SQLite 下本来就可能不存在） |
| `cli-db-shm` | `~/.zcode/cli/db/db.sqlite-shm` | optional（同上） |
| `user-agents-md` | `~/.zcode/AGENTS.md` | **REQUIRED** |

每项记 `sha256 + mtime + size`。差异检测覆盖四种：`existence` / `size` / `mtime` / `sha256`。

### 关于 optional 的诚实说明（不是放宽）

`-wal` / `-shm` 在空闲 SQLite 下**本来就可能不存在**。若当 REQUIRED，每次快照都 exit 2，工具就废了。因此：
- **缺失** → 记 `exists:false` 并进 `NOT VERIFIED`（INFO 级），快照成功；
- **前无后有 / 前有后无 / 内容变化** → 仍算差异（exit 1）；
- **REQUIRED 缺失或读失败** → **exit 2，绝不报零差异**（J2-5 fail-closed）。

## 四、J2-4 的安全复刻法（重要，别照字面做）

**J2-4 原意**："用旧配方实际跑一次，指纹必须抓到差异"。**照字面做会真的污染真实 `~/.zcode`** —— 这与配方本身的目的矛盾。

**采用的等效做法**（零污染）：
1. 造一个**影子 home** `<iso>/shadow-home`，内容模拟污染前状态（只有 `db.sqlite`、`AGENTS.md`，**无** `-wal`/`-shm`）；
2. 用 `--base <影子home>` 把**指纹监控根**指向它；
3. 用 `--legacy-recipe` 跑 —— 不设 `HOME`，`USERPROFILE` 指向影子 home（所以 `homedir()` 解析到影子 home，真实目录零触碰），**"只设 `ZCODE_DESKTOP_HOME_DIR` 管不住 `homedir()`"这一机制被完整复现**；
4. 子命令用 `--mimic-sqlite` 模拟 SQLite 打开主库时生成 `-wal`(0 B) / `-shm`(32768 B) —— 与真实事故的观测值一致。

结果：指纹报出 2 处 `[existence]` 差异（exit 1），真实 `~/.zcode` 零变化。证据：`evidence/rt-iso-red-oldrecipe.log`。

> 这处偏离已在 `evidence/rt-iso-report.md` 里显式标注：**我们复刻的是污染机制，不是污染后果**。

## 五、回滚

- 本文与 `tools/**` 都是新增文件：`Remove-Item docs/zcode-mod/isolation -Recurse` 即完全回滚
- **零运行期副作用**：指纹工具只读真实目录（`readFileSync` + `statSync`），从不写
- 实验数据全在 `.zhll/rt/`（已 gitignore），删掉不影响交付树
- 唯一会写盘的是"影子 home"与隔离 home，都在 `.zhll/rt/` 下

## 六、自检（贴到任何实验报告开头）

```powershell
# 1) 前置基线
node docs\zcode-mod\isolation\tools\fingerprint.mjs --snapshot <iso>\before.json --label before --optional cli-db-wal --optional cli-db-shm
# 2) 跑实验（经包壳）
node docs\zcode-mod\isolation\tools\run-with-fingerprint.mjs --label <名> -- <命令>
# 3) 确认包壳日志末段出现「结果：无差异（EXIT 0）」
```
