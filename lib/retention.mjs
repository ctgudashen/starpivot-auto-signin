// lib/retention.mjs
//
// 统一的「文件保留策略」模块 —— 负责按天数清理日志、截图等累积产物。
//
// 本项目为**自包含**的:此文件是 starpivot-auto-signin 的一部分,复制自原先的
// 公共模块,保证单独 clone 本仓库即可运行,不依赖仓库外的任何路径。
//
// 设计原则:
//   1. 只删**文件**,绝不碰子目录(避免误删 chrome-profile 这类目录)
//   2. 用**最后修改时间(mtime)** 判断过期,不靠文件名猜日期
//   3. 用**正则匹配文件名**,只清理该目录下对应类型的产物(日志/截图),
//      避免误删同目录里其他东西
//   4. 所有异常吞掉:清理失败绝不影响签到主流程
//   5. 返回被删清单,由调用方写进自己的日志,便于事后核对
//
// 新目录接入:在调用方的 retentionRules() 数组里加一条 { dir, days, match, label } 即可。

import fs from "node:fs";
import path from "node:path";

// 文件名匹配规则(调用方可覆盖)
export const MATCH = {
  // 日志:2026-09-04.log / 2026-09-04.log.1 / 2026-09-04.log.gz / .zip / .bz2
  log: /\.log(\.[0-9]+)?(\.gz|\.zip|\.bz2)?$/i,
  // 截图
  image: /\.(png|jpe?g|webp)$/i,
};

/**
 * 清理单个目录。
 * @param {object}   o
 * @param {string}   o.dir    目录绝对路径
 * @param {number}   o.days   保留天数(0 / 负数 = 不清理)
 * @param {RegExp}   o.match  文件名正则(只删命中的;不传 = 不限类型)
 * @param {string}   o.label  显示名(写日志用)
 * @returns {{dir,label,days,scanned,matched,removed,files:string[],error,skippedReason}}
 */
export function cleanupDir({ dir, days, match, label = "" }) {
  const result = {
    dir,
    label: label || dir,
    days,
    scanned: 0, // 目录下条目总数
    matched: 0, // 类型命中的文件数
    removed: 0, // 实际删除数
    files: [], // 被删文件名
    error: null,
    skippedReason: null,
  };

  try {
    if (!days || days <= 0) {
      result.skippedReason = "保留天数<=0,已跳过";
      return result;
    }
    if (!fs.existsSync(dir)) {
      result.skippedReason = "目录不存在";
      return result;
    }

    const cutoff = Date.now() - days * 86_400_000;

    for (const name of fs.readdirSync(dir)) {
      result.scanned++;
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue; // 子目录一律跳过
        if (match && !match.test(name)) continue; // 类型不匹配跳过
        result.matched++;
        if (st.mtimeMs >= cutoff) continue; // 未过期
        fs.unlinkSync(p);
        result.removed++;
        result.files.push(name);
      } catch {
        // 单个文件删不掉(占用/权限),跳过,不影响其他文件
      }
    }
  } catch (e) {
    result.error = e?.message || String(e);
  }
  return result;
}

/**
 * 按顺序清理多个目录,并通过 log() 回调输出一行摘要。
 * @param {Array} rules  [{ dir, days, match, label }]
 * @param {(msg:string)=>void} log
 * @returns {Array} 每个目录的结果
 */
export function cleanupAll(rules, log = () => {}) {
  const results = [];
  for (const rule of rules) {
    const r = cleanupDir(rule);
    results.push(r);

    if (r.error) {
      log(`清理[${r.label}] 失败(不影响主流程): ${r.error}`);
    } else if (r.skippedReason) {
      log(`清理[${r.label}] ${r.skippedReason}`);
    } else if (r.removed > 0) {
      const preview = r.files.slice(0, 20).join(", ");
      const more = r.files.length > 20 ? ` …等共 ${r.files.length} 个` : "";
      log(`清理[${r.label}] 保留${r.days}天 → 删除 ${r.removed} 个: ${preview}${more}`);
    } else {
      log(`清理[${r.label}] 保留${r.days}天 → 无需删除(扫描${r.scanned} 命中${r.matched})`);
    }
  }
  return results;
}
