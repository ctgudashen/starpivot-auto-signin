// checkin.mjs
//
// 自动签到脚本 —— 用项目内"专属 Chrome 用户目录"保留登录态,与你日常浏览器完全隔离
//
// 三种运行方式:
//   1) 登录态初始化(只做一次):  npm run setup     (有头窗口,手动登录一次)
//   2) 每日签到:                 npm start         (默认有头,自动过验证)
//   3) 只清理产物(不签到):       npm run cleanup
//
// 设计要点:
// - 不在脚本里写任何账号密码;登录态存在项目内 ./chrome-profile 目录
// - 不碰你日常使用的 Chrome 用户目录,更不会 taskkill 你的浏览器
// - 每次签到落 1 行日志;**截图只在出错时**保存(成功不留账号页快照)
// - 所有可配置项一律走环境变量,也可写进项目根目录的 .env(见 .env.example)
//
// ----------------------------------------------------------------------------
// 免责声明
// 本脚本仅用于个人自动化操作,不得用于违反目标网站服务条款、刷量、薅羊毛、
// 商业牟利或其他不当用途。运行前请阅读并同意 https://starpivot-ri.top/ 的
// 《用户协议》与《隐私政策》。由此脚本产生的任何账号风险与法律责任由使用者
// 自负。
// ----------------------------------------------------------------------------

import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
// 本仓库自带模块(lib/),保证单独 clone 即可运行,不依赖仓库外路径
import { cleanupAll, MATCH } from "./lib/retention.mjs";
import { loadDotEnv } from "./lib/env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 可选:读取项目根目录的 .env(不存在则跳过)。
// 已在 shell 里设置的环境变量优先级更高,不会被 .env 覆盖。
loadDotEnv(path.join(__dirname, ".env"));

const isSetup = process.argv.includes("--setup");
const isCleanup = process.argv.includes("--cleanup");

// ---------- 配置 -----------------------------------------------------------

// 解析浏览器可执行文件路径:显式 CHROME_PATH 优先,否则按平台探测本机
// 已安装的 Chrome / Edge。都没找到时回退到该平台的常见路径,
// 这样 launchBrowser() 报的 "找不到 Chrome" 里能带上一个可读的位置。
function resolveChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env["LOCALAPPDATA"] || "";

  const candidates = (
    {
      win32: [
        path.join(pf, "Google\\Chrome\\Application\\chrome.exe"),
        path.join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
        local && path.join(local, "Google\\Chrome\\Application\\chrome.exe"),
        path.join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
        path.join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
      ],
      darwin: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ],
      linux: [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
      ],
    }[process.platform] || []
  ).filter(Boolean);

  return candidates.find((p) => fs.existsSync(p)) || candidates[0] || "chrome";
}

const CONFIG = {
  // 目标页面
  url: "https://starpivot-ri.top/profile",

  // 浏览器路径:CHROME_PATH 优先,否则自动探测(Chrome / Edge)
  chromePath: resolveChromePath(),

  // 专属用户数据目录(项目内,和日常 Chrome 隔离;登录态就存在这里)
  userDataDir:
    process.env.CHROME_USER_DATA_DIR ||
    path.join(__dirname, "chrome-profile"),

  // 是否无头模式:
  //   - setup 模式强制有头
  //   - 日常**默认有头**:站点签到前固定挂 Cloudflare Turnstile 验证,
  //     headless 浏览器每次都会被拦(2026-09-22 起),有头浏览器能自动通过、无需人工点击
  //   - 代价:每次运行会短暂弹一下 Chrome 窗口,跑完自动关闭
  //   - 想强制 headless(大概率被拦,仅供调试): HEADLESS=1
  headless: isSetup ? false : process.env.HEADLESS === "1",

  // 页面等待签到按钮的超时时间(ms)
  clickTimeoutMs: 30_000,

  // 目录
  logDir: path.join(__dirname, "logs"),
  screenshotDir: path.join(__dirname, "screenshots"),

  // 是否保存截图。默认 **只保存失败现场**(登录失效 / 找不到按钮 / 验证没通过),
  // 成功后不再截图 —— 免得每天往磁盘写一张已登录的账号页快照。
  // SAVE_SCREENSHOTS=0 可完全关闭截图。
  saveScreenshots: process.env.SAVE_SCREENSHOTS !== "0",

  // ---- 产物保留天数(统一由 lib/retention.mjs 执行)----
  // 规则:按**文件最后修改时间(mtime)** 判断过期,默认 7 天;设 0 = 不清理。
  // 可用环境变量覆盖:LOG_KEEP_DAYS(日志) / SHOT_KEEP_DAYS(截图)
  logRetentionDays: Number(process.env.LOG_KEEP_DAYS ?? 7),
  screenshotRetentionDays: Number(process.env.SHOT_KEEP_DAYS ?? 7),

  // 签到按钮文案(第一级:精确全等匹配,优先;第二级:包含匹配,要求文本短于 8 字,避免撞到标题)
  checkinExactTexts: ["立即签到", "今日签到", "签 到", "签到"],
  checkinSubTexts: ["checkin", "check-in", "check in"],

  // "已签到 / 签到成功" 命中模式(只要页面里出现这些文本,说明今日已打卡成功)
  alreadyCheckedInTexts: ["签到成功", "已签到", "今日已签到", "已打卡", "已领取"],

  // 登录页命中模式(命中即认为当前是登录页)
  loginPageTexts: [
    "密码登录",
    "邮箱登录",
    "验证码登录",
    "Sign in",
    "Log in",
    "Sign In",
  ],

  // Cloudflare 安全验证(人机校验)命中模式。
  // 站点从 2026-09-22 起在签到前挂了 Turnstile 校验:headless 必被拦,有头可自动通过。
  securityChallengeTexts: [
    "安全验证",
    "请完成安全验证",
    "正在验证",
    "Cloudflare",
  ],

  // 点击后等待"签到结果"的最长时间(ms)。需给 Cloudflare 自动验证留出时间。
  clickResultTimeoutMs: 20_000,

  // 一旦确认遇到 Cloudflare 人机验证,等待"自动点勾 / 人工点勾"的最长时间(ms)。
  // 站点 2026-09-27 起把验证升级成"要点勾"了(此前有头浏览器能自动静默通过),
  // 所以必须留出让人手动点的时间。设 0 表示不等待人工(遇到验证直接失败)。
  turnstileWaitMs: Number(process.env.TURNSTILE_WAIT_MS ?? 120_000),
};

// ---------- 工具 -----------------------------------------------------------

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 只在**失败路径**调用:把当前页面存成截图,返回路径。
// 截图关闭(SAVE_SCREENSHOTS=0)或截图本身失败时返回 null,绝不影响主流程。
async function captureFailure(page, suffix) {
  if (!CONFIG.saveScreenshots) return null;
  const shot = path.join(CONFIG.screenshotDir, `${todayStamp()}-${suffix}.png`);
  try {
    await page.screenshot({ path: shot, fullPage: true });
    return shot;
  } catch {
    return null; // 页面/frame 正在重建时截图会失败,不影响判定
  }
}

// 把可选截图路径拼成日志尾巴
function shotNote(shot) {
  return shot ? `截图: ${shot}` : "(未保存截图)";
}

// ---- 产物保留策略 ----
// 具体清理逻辑在 ./lib/retention.mjs。
// 新增需要清理的目录时,只要往下面这个数组里加一条即可。
function retentionRules() {
  return [
    {
      dir: CONFIG.logDir,
      days: CONFIG.logRetentionDays,
      match: MATCH.log, // 只认 .log / .log.1 / .log.gz 等,避免误删同目录其他文件
      label: "logs",
    },
    {
      dir: CONFIG.screenshotDir,
      days: CONFIG.screenshotRetentionDays,
      match: MATCH.image, // 只认图片
      label: "screenshots",
    },
  ];
}

// 建目录 + 按保留策略清理(每次启动自动执行;也可 --cleanup 单独跑)
function initDirs() {
  ensureDir(CONFIG.logDir);
  ensureDir(CONFIG.screenshotDir);
  cleanupAll(retentionRules(), logLine);
}

function logLine(...args) {
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${args.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(
      path.join(CONFIG.logDir, `${new Date().toISOString().slice(0, 10)}.log`),
      line + "\n",
      "utf8",
    );
  } catch {
    // 日志写不进不影响主流程
  }
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

// 在页面里找签到按钮:
// 1) 优先:文本(去空白后)与 exactTexts 全等
// 2) 其次:文本短(<=8 字)且包含 subTexts 里的英文
// 这样能避开"每日签到可获得随机额度奖励"这类标题文本
async function findCheckinButton(page, exactTexts, subTexts) {
  return page.evaluate(
    ({ exactTexts, subTexts }) => {
      const norm = (s) => (s || "").replace(/\s+/g, "").trim();
      const cands = [...document.querySelectorAll("button, a, [role='button']")];

      // 阶段 1:精确全等
      for (const el of cands) {
        const t = norm(el.textContent || "");
        if (!t) continue;
        if (exactTexts.some((w) => norm(w).toLowerCase() === t.toLowerCase())) {
          return { found: true, text: t, exact: true };
        }
      }
      // 阶段 2:短文本包含(英文候选)
      for (const el of cands) {
        const t = norm(el.textContent || "");
        if (!t || t.length > 8) continue;
        const tl = t.toLowerCase();
        if (subTexts.some((w) => norm(w).toLowerCase() && tl.includes(norm(w).toLowerCase()))) {
          return { found: true, text: t, exact: false };
        }
      }
      return { found: false };
    },
    { exactTexts, subTexts },
  );
}

// 页面 body 是否包含任意关键词
async function pageHasAny(page, needles) {
  return page.evaluate((needles) => {
    const text = (document.body?.innerText || "").replace(/\s+/g, "").toLowerCase();
    return needles.some((n) => text.includes((n || "").replace(/\s+/g, "").toLowerCase()));
  }, needles);
}

// ---------- Cloudflare 人机验证处理 ----------------------------------------
//
// 站点 2026-09-27 起把验证升级成"要手动点勾"(此前有头浏览器能静默自动通过)。
// 应对策略:① 先自动试着点一下复选框 ② 点不掉就保留窗口、等你手动点,最长 turnstileWaitMs
// 同时:验证过程中 iframe 会销毁重建,任何 page 操作都可能抛
//   "Attempted to use detached Frame" —— 所以读取一律走 safeReadState,失败当作"还没结果"。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一次读完三个判定信号;页面重建中读失败时返回 null(调用方继续等)
async function safeReadState(page) {
  try {
    return await page.evaluate(
      ({ doneTexts, challengeTexts, btnTexts }) => {
        const norm = (s) => (s || "").replace(/\s+/g, "").trim().toLowerCase();
        const body = norm(document.body?.innerText || "");
        const cands = [...document.querySelectorAll("button, a, [role='button']")];
        const btnGone = !cands.some((e) => btnTexts.some((w) => norm(w) === norm(e.textContent || "")));
        return {
          nowDone: doneTexts.some((t) => body.includes(norm(t))),
          challenged: challengeTexts.some((t) => body.includes(norm(t))),
          btnGone,
        };
      },
      {
        doneTexts: CONFIG.alreadyCheckedInTexts,
        challengeTexts: CONFIG.securityChallengeTexts,
        btnTexts: CONFIG.checkinExactTexts,
      },
    );
  } catch {
    return null; // detached Frame / 页面重建中
  }
}

// 尝试自动点掉 Turnstile 的复选框
async function tryClickTurnstile(page) {
  try {
    const frames = page
      .frames()
      .filter((f) => /challenges\.cloudflare\.com|turnstile/i.test(f.url() || ""));

    // 方式 1:在验证 iframe 里点真正的 checkbox
    for (const f of frames) {
      try {
        const el = await f.$('input[type="checkbox"], .ctp-checkbox, .ctp-checkbox-label');
        if (el) {
          await el.click({ delay: 60 });
          return true;
        }
      } catch {
        // 换下一个
      }
    }
    // 方式 2:按 iframe 的几何位置点左上角(复选框通常在那儿)
    for (const f of frames) {
      try {
        const handle = await f.frameElement();
        const b = await handle.boundingBox();
        if (b) {
          await page.mouse.click(
            b.x + Math.min(30, b.width / 2),
            b.y + Math.min(28, b.height / 2),
          );
          return true;
        }
      } catch {
        // 换下一个
      }
    }
  } catch {
    // 点不到就算了,后面还有人工兜底
  }
  return false;
}

// 轮询等待签到结果;遇到人机验证时放宽等待窗口并引导人工介入
async function waitForCheckinResult(page, headless) {
  const result = { nowDone: false, btnGone: false, challenged: false };
  let challengeLogged = false;
  let autoClicked = false;
  let promptedManual = false;

  const start = Date.now();
  let timeout = CONFIG.clickResultTimeoutMs;

  while (Date.now() - start < timeout) {
    await sleep(1000);
    const s = await safeReadState(page);
    if (!s) continue; // 页面/frame 重建中,继续等

    result.nowDone = s.nowDone;
    result.btnGone = s.btnGone;
    result.challenged = s.challenged;

    if (s.nowDone || s.btnGone) return result; // 成功

    if (s.challenged) {
      if (!challengeLogged) {
        logLine("🛡️ 检测到 Cloudflare 安全验证(需要点勾)");
        challengeLogged = true;
        // 遇到验证就放宽等待窗口,留出人工点击时间
        if (CONFIG.turnstileWaitMs > 0) timeout = CONFIG.turnstileWaitMs;
      }

      if (!autoClicked) {
        autoClicked = true;
        if (await tryClickTurnstile(page)) {
          logLine("   已尝试自动点击验证复选框,等待结果...");
        }
      }

      // 自动点没过 → 提示人工介入,并再试一次
      if (!promptedManual && Date.now() - start > 10_000) {
        promptedManual = true;
        logLine("   ⌛ 若还没通过,请在弹出的 Chrome 窗口里手动点一下那个勾,脚本继续等你...");
        await tryClickTurnstile(page);
      }

      // headless 下没法人工点,直接交给外层切有头重试
      if (headless) return result;
    }
  }
  return result;
}

async function launchBrowser(headless = CONFIG.headless) {
  if (!fs.existsSync(CONFIG.chromePath)) {
    throw new Error(`找不到 Chrome: ${CONFIG.chromePath},请设置 CHROME_PATH 环境变量`);
  }
  return puppeteer.launch({
    executablePath: CONFIG.chromePath,
    headless,
    defaultViewport: { width: 1280, height: 800 },
    userDataDir: CONFIG.userDataDir,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
    ],
  });
}

// ---------- setup 模式:首次登录 -------------------------------------------

async function runSetup() {
  initDirs();
  logLine("=== setup 模式:初始化登录态 ===");

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(CONFIG.url, { waitUntil: "networkidle2", timeout: 60_000 });

  console.log("");
  console.log("──────────────────────────────────────────────");
  console.log("已打开一个登录窗口。请在窗口里完成登录。");
  console.log("");
  console.log("登录成功后,回到这个终端按【回车】确认保存。");
  console.log("(也可以直接关掉浏览器窗口,登录态会自动保存)");
  console.log("──────────────────────────────────────────────");
  console.log("");

  // 两种退出方式,用 Promise.race 等:(1) 用户按回车 (2) 浏览器窗口被关闭
  const enterPromise = new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.once("line", () => { rl.close(); resolve("enter"); });
  });
  // 浏览器被用户手动关窗口时,page 会触发 close
  const closedPromise = new Promise((resolve) => {
    page.once("close", () => resolve("closed"));
  });

  const result = await Promise.race([enterPromise, closedPromise]);
  console.log(result === "closed" ? "\n检测到浏览器窗口已关闭" : "\n已收到确认");

  // 这里刻意不截图:setup 成功时页面就是你已登录的账号页,没必要落盘。
  try { await browser.close(); } catch {}
  logLine("✅ 登录态已写入项目内 chrome-profile 目录。以后每天跑 `npm start` 即可。");
  console.log("✅ 初始化完成。接下来直接 `npm start` 静默签到。");
  process.exit(0);
}

// ---------- 每日签到 --------------------------------------------------------

// 返回值(退出码):0 成功 | 1 异常 | 2 未登录 | 3 没找到按钮 | 4 点击后未确认 | 5 被 Cloudflare 安全验证拦截
async function runCheckin(headless = CONFIG.headless) {
  initDirs();

  logLine(`=== 启动(${headless ? "headless" : "有头"}模式)===`);
  logLine(`目标: ${CONFIG.url}`);
  logLine(`Chrome: ${CONFIG.chromePath}`);
  logLine(`UserData: ${CONFIG.userDataDir}`);

  const browser = await launchBrowser(headless);
  let exitCode = 0;
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60_000);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    logLine(`打开 ${CONFIG.url}`);
    await page.goto(CONFIG.url, { waitUntil: "networkidle2", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 1500));

    // 检测是否在登录页
    if (await pageHasAny(page, CONFIG.loginPageTexts)) {
      const shot = await captureFailure(page, "login");
      logLine(`❌ 检测到登录页(登录态失效或未初始化)。${shotNote(shot)}`);
      logLine("请先跑一次 `npm run setup` 完成登录,再跑 `npm start`。");
      exitCode = 2;
      return exitCode;
    }

    // 检测是否今日已签到 —— 成功路径,不留截图
    if (await pageHasAny(page, CONFIG.alreadyCheckedInTexts)) {
      logLine("✅ 今日已签到,跳过。");
      return 0;
    }

    // 找签到按钮
    logLine("寻找签到按钮...");
    let button = { found: false };
    const start = Date.now();
    while (Date.now() - start < CONFIG.clickTimeoutMs) {
      button = await findCheckinButton(page, CONFIG.checkinExactTexts, CONFIG.checkinSubTexts);
      if (button.found) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!button.found) {
      // 失败路径才截图:这张就是"点击前"的页面现场
      const shot = await captureFailure(page, "no-button");
      logLine(`❌ 没找到签到按钮(超时 ${CONFIG.clickTimeoutMs}ms)。${shotNote(shot)}`);
      logLine("可能今天已签到、页面改版或站点维护。请看截图人工核对。");
      exitCode = 3;
      return exitCode;
    }

    logLine(`找到按钮: "${button.text}"`);

    // 点击该按钮(精确全等优先,避免点到标题)
    await page.evaluate((exactTexts) => {
      const norm = (s) => (s || "").replace(/\s+/g, "").trim();
      const cands = [...document.querySelectorAll("button, a, [role='button']")];
      const el = cands.find((e) => {
        const t = norm(e.textContent || "");
        return exactTexts.some((w) => norm(w).toLowerCase() === t.toLowerCase());
      });
      el?.click();
    }, CONFIG.checkinExactTexts);

    // 等待签到结果(内含 Cloudflare 人机验证的处理)
    const st = await waitForCheckinResult(page, headless);
    const nowDone = st.nowDone;
    const btnGone = st.btnGone;
    const challenged = st.challenged;

    if (nowDone || btnGone) {
      // 成功路径:不截图,日志里也不提截图
      logLine(`✅ 签到完成(${nowDone ? "命中成功文案" : ""}${nowDone && btnGone ? " + " : ""}${btnGone ? "按钮已消失" : ""})。`);
    } else if (challenged) {
      const shot = await captureFailure(page, "after");
      logLine(`🛡️ 人机验证未通过(已等 ${Math.round(CONFIG.turnstileWaitMs / 1000)} 秒),本次未签到成功。`);
      logLine(`   原因二选一:自动点勾被风控拒绝 / 当时没人手动点。${shotNote(shot)}`);
      exitCode = 5;
    } else {
      const shot = await captureFailure(page, "after");
      logLine(`⚠️ 已点击,但未确认成功(无成功文案、按钮也未消失)。请人工核对。${shotNote(shot)}`);
      exitCode = 4;
    }
  } catch (err) {
    logLine(`❌ 异常: ${err?.message || err}`);
    exitCode = 1;
  } finally {
    try { await browser.close(); } catch {}
    logLine(`=== 结束 (exitCode=${exitCode}) ===`);
  }

  return exitCode;
}

// ---------- 入口 ------------------------------------------------------------

// 退出码 5 = 被 Cloudflare 安全验证拦截(headless 通不过)
const EXIT_SECURITY_CHALLENGE = 5;

async function main() {
  // 独立清理模式:只按保留策略清理产物,不签到。
  // 可挂计划任务单独跑(比如每周一次),即使签到脚本某天没跑也能清理。
  if (isCleanup) {
    ensureDir(CONFIG.logDir);
    ensureDir(CONFIG.screenshotDir);
    logLine("=== 清理模式(只清理,不签到)===");
    cleanupAll(retentionRules(), logLine);
    logLine("=== 清理完成 ===");
    return 0;
  }

  if (isSetup) {
    return await runSetup();
  }

  const code = await runCheckin(CONFIG.headless);

  // headless 被 Cloudflare 拦截时,自动切有头模式重试一次
  // (有头浏览器能自动通过 Turnstile 校验,无需人工干预)
  if (code === EXIT_SECURITY_CHALLENGE && CONFIG.headless) {
    logLine("↻ headless 被安全验证拦截,自动切换为有头模式重试一次...");
    return await runCheckin(false);
  }
  return code;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => { console.error(e); process.exit(1); });