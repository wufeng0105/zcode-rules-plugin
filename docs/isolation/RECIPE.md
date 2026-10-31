# 隔离配方：怎么在不污染真实环境的前提下做实验

任何要碰 ZCode 的实验——装插件、跑会话、开 GUI——**先按这份配方设环境变量，再用 `tools/run-with-fingerprint.mjs` 包壳跑。**

不照做的后果，下面有真实事故记录。

## 一、为什么需要这份配方

### 一次真实事故

2026-10-30 00:21:40，一次 GUI 实验只按常规 e2e 的姿势设了 `ZCODE_DESKTOP_HOME_DIR` + `ZCODE_DATA_BASE_DIR`。看起来该管的都管了，结果 **agent 侧的 CLI 存储写进了真实 `~/.zcode`**：

| 文件 | 结果 |
| --- | --- |
| `~/.zcode/cli/db/db.sqlite` | mtime 未变 |
| `~/.zcode/cli/db/db.sqlite-wal` | **被创建/写入，0 B** |
| `~/.zcode/cli/db/db.sqlite-shm` | **被创建/写入，32768 B** |

### 为什么设了两个变量还是漏了

因为**产品里有两个不同的路径来源，只设其中一个管不住另一个**：

- `adapters/src/config/file-config.adapter.ts` —— `DEFAULT_BASE_DIR = "~/.zcode/cli"`，其中 `~` 的展开走 **`homedir()`**
- `settingService.ts` —— 认 **`ZCODE_DESKTOP_HOME_DIR`**

只设 `ZCODE_DESKTOP_HOME_DIR`，只重定向了 `v2` 那半边。`cli` 那半边（`db` / `memories` / `rollout` / `plugins`）照样走真实 home。

**结论：必须同时重定向 `HOME` / `USERPROFILE`，才能管住 `homedir()` 派生的一切。**

## 二、配方：三组变量，缺一不可

```powershell
# ★ 第一组：真实 home 重定向。管住 homedir() 派生的一切
#   （cli/db、cli/memories、cli/rollout、cli/plugins 都从这来）
$env:HOME        = "<iso>/home"
$env:USERPROFILE = "<iso>/home"      # Windows 上 homedir() 优先读 USERPROFILE

# 第二组：ZCode 自己的变量
$env:ZCODE_DESKTOP_HOME_DIR  = "<iso>/home"    # settingService 认这个（v2 那半边）
$env:ZCODE_DATA_BASE_DIR     = "<iso>/data"    # 业务数据根：provider / 凭据 / 遥测 / tasks-index
$env:ZCODE_LOG_DIR           = "<iso>/logs"
$env:ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA = "1"

# 第三组：启动参数（只在 GUI 场景需要）
#   --user-data-dir=<iso>/ud
#   --remote-debugging-port=9334
#   ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1

# 第四组：跑 GUI 前必须清掉继承的 ELECTRON_RUN_AS_NODE
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

### 各组管哪半边（别记混）

| 变量 | 管住什么 | 漏了会怎样 |
| --- | --- | --- |
| `HOME` / `USERPROFILE` | `homedir()` 派生的一切：`cli/db`、`cli/memories`、`cli/rollout`、`cli/plugins` | 真实 `~/.zcode/cli/db` 被写 |
| `ZCODE_DESKTOP_HOME_DIR` | `settingService` 认的 `v2` 半边 | 桌面设置落到真实 home |
| `ZCODE_DATA_BASE_DIR` | 业务数据：provider 配置、凭据、遥测、`tasks-index` | 业务数据落到真实位置 |
| `ZCODE_LOG_DIR` | 结构化日志目录 | 日志污染真实日志 |
| `--user-data-dir` | Electron 渲染进程的 userData（localStorage / IndexedDB / Cookie） | GUI 状态落到真实 userData |
| `ELECTRON_RUN_AS_NODE` 清掉 | 否则 Electron 以 Node 模式启动，GUI 起不来 | GUI 场景启动失败 |

## 三、实验前必须先拍指纹

这不是可选步骤。**任何隔离实验，跑之前和跑之后都要各拍一次真实 home 的指纹，然后对账。**

包壳工具会帮你做这件事。用法：

```pwsh
node ../../docs/isolation/tools/run-with-fingerprint.mjs --label my-experiment -- node <你的驱动脚本>
```

它做四件事：

1. 按上面配方建隔离目录
2. 拍「实验前」的真实 home 指纹
3. 跑你的驱动脚本
4. 拍「实验后」指纹并比对——**有差异就报警**

期望看到最后一行：`结果：无差异（EXIT 0）`。

### 指纹清单

| 级别 | 内容 | 为什么 |
| --- | --- | --- |
| **必需** | `~/.zcode/cli/db/db.sqlite` | 主数据库，被写就说明隔离失败 |
| **必需** | `~/.zcode/AGENTS.md` | 插件投影的目标文件 |
| **可选** | `db.sqlite-wal` / `db.sqlite-shm` | SQLite 的临时文件。**不存在是正常的**——没写过就没有 |

**关于「可选」的诚实说明**：标可选不是放宽标准，是因为这两个文件**在某些机器上本来就不存在**。把它们标为必需会让「全新环境」永远对不上账，反而掩盖真问题。判断标准是：**实验前有、实验后被改，或实验前没有、实验后出现**——那才是问题。

## 四、反向验证：怎么证明隔离真的有效

一个只报「无差异」的检查是不可信的——万一它根本没检查呢？

所以配方还要求做**反向验证**：故意用一份**残缺的**配方（不设 `HOME`，只设 `ZCODE_DESKTOP_HOME_DIR`）在影子 home 上跑一次，**确认指纹能抓到差异**。

如果残缺配方也报「无差异」，说明检查本身失效了。

这就是包壳的 `--legacy-recipe` 参数的用途：它故意复刻那次事故的机制。

## 五、回滚

如果实验搞坏了隔离环境，直接删掉整个隔离目录重来即可——里面全是可重建的东西：

```pwsh
Remove-Item -Recurse -Force <iso>
```

**但如果指纹对账报了差异**，说明真实 home 已经被碰过。这时要看是哪个文件：

- `db.sqlite-wal` / `-shm` 被创建：影响小，SQLite 自己会回收
- `db.sqlite` 被改：严重，需要从备份恢复
- `AGENTS.md` 被改：检查是不是有哨兵段被写入，手工删掉

## 六、实验报告开头该贴什么

任何用这份配方做的实验，报告开头贴这三段：

```pwsh
# 1) 前置基线
node ../../docs/isolation/tools/fingerprint.mjs --label before

# 2) 跑实验（经包壳）
node ../../docs/isolation/tools/run-with-fingerprint.mjs --label <label> -- node <驱动脚本>

# 3) 确认包壳日志末段出现「结果：无差异（EXIT 0）」
```

这样别人能判断你的结论是在什么环境下得到的。

## 七、这套工具在哪些判据里被用到

`../REPRODUCE.md` 里「第三类：需要真实 ZCode + 真实会话」的判据，全部要求经这个包壳跑。具体是哪几条、怎么跑，看 [`../REPRODUCE.md`](../REPRODUCE.md) 第二节。

判断这些判据是否满足，看 [`../DOD.md`](../DOD.md)；验证过程与证据强度，看 [`../VERIFICATION.md`](../VERIFICATION.md)。
