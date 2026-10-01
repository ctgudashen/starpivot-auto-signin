# StarPivot RI 自动签到

个人用脚本：用项目内**专属 Chrome 用户目录**保留登录态，打开 `https://starpivot-ri.top/profile`
自动点「立即签到」。不写账号密码进脚本，也不碰你日常使用的 Chrome。

> 站点签到前挂了 Cloudflare Turnstile 人机验证，所以脚本走**有头模式**（会自动尝试点勾，
> 点不掉时保留窗口等你手动点一下）。

## 特性

- **零凭据**：脚本里没有任何账号、密码、Token；登录态由 `chrome-profile/` 目录承载
- **浏览器隔离**：使用项目内专属用户目录，不干扰日常 Chrome，不会 taskkill 你的浏览器
- **自动过验证**：自动点击 Turnstile 复选框，失败时留窗口人工兜底
- **自动清理**：日志与截图按天数自动清理，避免无限堆积
- **最小化留痕**：截图**只在出错时**保存（登录失效 / 找不到按钮 / 验证未过），
  签到成功不留任何页面快照；也可用 `SAVE_SCREENSHOTS=0` 完全关闭
- **可配置**：所有开关都能用环境变量或 `.env` 覆盖，无需改代码

## 目录结构

```
starpivot-auto-signin/
├── checkin.mjs          # 入口脚本（签到 / setup / cleanup）
├── lib/
│   ├── retention.mjs    # 产物保留策略（按 mtime + 文件名正则清理）
│   └── env.mjs          # 零依赖的 .env 读取器
├── scripts/
│   ├── run.bat          # Windows 计划任务入口（签到）
│   └── run-cleanup.bat  # Windows 计划任务入口（仅清理）
├── .env.example         # 可选配置示例（复制为 .env 生效）
├── .gitignore           # 已排除登录态 / 日志 / 截图 / 依赖
├── package.json
├── package-lock.json
└── README.md
```

运行时自动生成（**均已 gitignore，不会提交**）：

| 目录 | 内容 |
| ---- | ---- |
| `chrome-profile/` | 专属 Chrome 用户目录，保存登录态（含 Cookie，**敏感**） |
| `logs/` | 每日日志 `YYYY-MM-DD.log` |
| `screenshots/` | **仅出错时**保存的截图，便于事后核对（成功不产生） |

## 环境要求

- **一个 `starpivot-ri.top` 账号** —— 脚本只做「登录后的每日签到」，**不包含注册流程**，
  需要你自己已有账号并能正常登录（登录通常需要过 Cloudflare，建议先在普通浏览器里登通一次）
- **Node.js ≥ 20**
- **Google Chrome 或 Edge** —— 脚本复用本机浏览器（`puppeteer-core` **不会**下载 Chromium）；
  两者都没装在默认位置时，用 `CHROME_PATH` 指明路径
- **Windows**：仅 `scripts/*.bat` 和下面的「计划任务」一节是 Windows 专用。
  `npm run setup` / `npm start` 本身跨平台，macOS / Linux 直接跑 npm 脚本即可

## 快速开始

```bash
# 0) 先确认上面「环境要求」里的账号与浏览器都已就绪

# 1) 安装依赖（仅 puppeteer-core，复用本机已装的 Chrome）
npm install

# 2) 登录一次（只做一次，会弹出 Chrome 窗口，手动登录后按回车）
npm run setup

# 3) 每日签到
npm start
```

`setup` 之后，登录态写在项目内 `chrome-profile/`。会话过期（约数周）后重跑一次 `npm run setup` 即可。

> `npm run setup` 需要在**可交互的终端**里跑（要按回车确认）。
> 如果环境没有 TTY（比如某些非交互式任务），登录完直接**关掉浏览器窗口**同样会保存登录态。
> 首次 `npm start` 若返回 `exitCode 2`，说明还没做过 `setup`，属于预期行为。

## 运行策略

站点的人机验证一直在升级，脚本的应对方式随之调整：

| 时间 | 站点变化 | 应对 |
| ---- | -------- | ---- |
| 2026-09-22 | 签到前挂 Cloudflare Turnstile，headless 必被拦 | 改成**默认有头** |
| 2026-09-27 | 有头也不再静默通过，弹出**需要点勾**的复选框 | 脚本**自动点勾** + 人工兜底 |

当前流程：

1. 有头 Chrome 打开页面 → 点「立即签到」→ 弹出验证框
2. 脚本**自动尝试点掉那个勾**（实测约 3 秒通过，无需干预）
3. 自动点失败 → **保留窗口等你手动点**，最长等 `TURNSTILE_WAIT_MS`（默认 120 秒）
4. 验证通过后完成签到

> 每天会短暂弹出一次 Chrome 窗口（自动点成功时只有几秒），这是目前能稳定签到的唯一方式。

## 退出码

| code | 含义 | 会留截图吗 |
| ---- | ---- | ---------- |
| 0 | 签到完成 / 今日已签到 | 否 |
| 1 | 脚本异常 | 否 |
| 2 | 检测到登录页 → 先 `npm run setup` 重新登录 | 是，`*-login.png` |
| 3 | 没找到签到按钮（页面改版 / 站点维护） | 是，`*-no-button.png` |
| 4 | 已点击但未确认成功 | 是，`*-after.png` |
| 5 | 被 Cloudflare 安全验证拦截（headless 与有头都没过） | 是，`*-after.png` |

> `screenshots/` 里的文件都是**失败现场**，成功的那天不会有新文件。

## 配置

所有配置项都可通过**环境变量**传入，也可以复制 `.env.example` 为 `.env` 后填写
（脚本零依赖自动读取 `.env`；已存在的环境变量优先级更高，不会被 `.env` 覆盖）。

| 变量 | 默认值 | 说明 |
| ---- | ------ | ---- |
| `CHROME_PATH` | 自动探测本机 Chrome / Edge | 浏览器可执行文件路径（探测不到时必填） |
| `CHROME_USER_DATA_DIR` | 项目内 `./chrome-profile` | 登录态目录（一般不用改） |
| `HEADLESS` | 不设 = **有头**（推荐） | 设 `1` 才用 headless（会被 Cloudflare 拦，仅供调试） |
| `TURNSTILE_WAIT_MS` | `120000` | 等人工点勾的最长毫秒数；`0` = 不等，直接失败 |
| `SAVE_SCREENSHOTS` | 不设 = 开（仅失败时） | 设 `0` 则**完全关闭**截图，一个都不落盘 |
| `LOG_KEEP_DAYS` | `7` | 日志保留天数；`0` = 永不清理 |
| `SHOT_KEEP_DAYS` | `7` | 截图保留天数；`0` = 永不清理 |

示例：

```powershell
$env:TURNSTILE_WAIT_MS="300000"; npm start   # 人工等待放宽到 5 分钟
$env:HEADLESS="1";               npm start   # 强制 headless（会被拦，仅供调试）
$env:LOG_KEEP_DAYS="30";         npm start   # 日志留 30 天
```

用 Edge 跑：

```powershell
$env:CHROME_PATH="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
npm run setup
npm start
```

## 产物自动清理

每次运行（含 `setup` / 计划任务）会先按天数清理 `logs/` 与 `screenshots/`，
默认保留 **7 天**。`screenshots/` 只在出错时才有内容，所以日常它基本是空的。
也可以单独触发，只清理不签到：

```bash
npm run cleanup          # 等价于 node checkin.mjs --cleanup
```

清理规则（见 `lib/retention.mjs`）：

- 按**文件最后修改时间**判断过期，不靠文件名猜日期
- **只删文件，绝不碰子目录**（`chrome-profile/` 永远安全）
- 只删命中类型的文件：日志 `*.log[.N][.gz|.zip|.bz2]`、图片 `*.png|jpg|jpeg|webp`
- 任何异常都被吞掉，**绝不影响签到主流程**

新增需要清理的目录：在 `checkin.mjs` 的 `retentionRules()` 数组里加一条
`{ dir, days, match, label }` 即可。

## 挂到 Windows 计划任务

> **需要以管理员身份打开 PowerShell**（`Register-ScheduledTask` 写系统任务库必须提权）。
> `<项目路径>` 必须替换成**绝对路径**（例如 `D:\code\starpivot-auto-signin`），
> 相对路径和 `~` 都不行。先手动跑一次 `npm start` 确认能签到成功，再挂任务。

```powershell
# 每天 08:30 自动签到（把 <项目路径> 换成实际绝对路径）
$a = New-ScheduledTaskAction -Execute "<项目路径>\scripts\run.bat" -WorkingDirectory "<项目路径>"
$t = New-ScheduledTaskTrigger -Daily -At 08:30
Register-ScheduledTask -TaskName "StarPivotCheckin" -Action $a -Trigger $t `
  -Description "StarPivot RI daily check-in" -StartWhenAvailable -Force
```

常用管理命令：

```powershell
Get-ScheduledTaskInfo -TaskName "StarPivotCheckin"    # 上次结果 / 下次时间
Start-ScheduledTask   -TaskName "StarPivotCheckin"    # 立即触发一次
Disable-ScheduledTask -TaskName "StarPivotCheckin"    # 暂停
Unregister-ScheduledTask -TaskName "StarPivotCheckin" # 删除
```

> `scripts/*.bat` 会自动定位 `node.exe`（PATH → 常见安装位置 → 兜底），
> 并自行切换到项目根目录，无需手改路径。
> 目前本机任务 `StarPivotCheckin` 处于 **停用（Disabled）** 状态，需要时手动启用即可。

> ⚠️ 计划任务跑的是**有头浏览器**，需要有一个可用的桌面会话；
> 如果机器在触发时处于未登录 / 睡眠状态，任务可能不执行（或延后补跑）。

## 常见问题

- **报「检测到登录页」** → 登录态失效，重跑 `npm run setup`
- **报「被 Cloudflare 安全验证拦截」(exitCode 5)** → 站点风控升级或没人点勾；
  看 `screenshots/*-after.png`，必要时手动开浏览器签到
- **报「没找到签到按钮」(exitCode 3)** → 站点可能改版；打开 `screenshots/` 里最新的
  `*-no-button.png` 核对按钮文案，再更新 `checkin.mjs` 的 `CONFIG.checkinExactTexts`
- **报「找不到 Chrome」** → 设 `CHROME_PATH` 指向 Chrome / Edge 可执行文件
- **`npm run setup` 卡住不动** → 它在等你按回车；或直接关掉浏览器窗口也会保存登录态
- **`screenshots/` 一直是空的** → 正常。只有出错时才写截图（exitCode 2/3/4/5）

## 安全与隐私

- 仓库内**不含**任何账号、密码、Token、密钥或个人信息
- `chrome-profile/`（登录态 / Cookie）、`logs/`、`screenshots/`（失败现场，含账号页面）、
  `.env` 均已写入 `.gitignore`，**不会被提交**
- 截图**只在出错时**产生，签到成功不留页面快照；`SAVE_SCREENSHOTS=0` 可完全关闭
- 首次使用请先跑 `npm run setup` 在本机登录，凭据只留在本机

## 免责声明

仅用于个人自动化，不得用于违反目标站点服务条款、刷量、薅羊毛、商业牟利等不当用途。
运行即视为同意上述条款，由此产生的账号风险与法律责任由使用者自负。

## 许可证

本仓库为**专有软件（Proprietary）**，保留所有权利。

代码公开可见**仅用于查看与参考**——公开可见不等于授予许可。未经版权人书面同意，
不得使用、复制、修改、分发、再许可或用于任何商业用途。完整条款见 [LICENSE](LICENSE)。

`package.json` 中的 `"private": true` 与 `"license": "UNLICENSED"` 与本声明一致，
本项目不发布到 npm，也不对外提供使用授权。
