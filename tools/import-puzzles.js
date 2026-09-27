#!/usr/bin/env node
/**
 * 题库导入脚本 —— 把 seed/puzzles.json 里的题目批量写入 soups 表
 *
 * 用法：
 *   node tools/import-puzzles.js --dry-run     # 只读，报告会插入几条（不改库）
 *   node tools/import-puzzles.js              # 真正写入
 *   node tools/import-puzzles.js --file seed/puzzles.json
 *   node tools/import-puzzles.js --unhide     # 导入为「上架」状态（默认导入即隐藏）
 *
 * 设计要点：
 *   - **幂等**：按 title 去重，重复运行不会产生重复题目
 *   - **默认隐藏**：写入 is_hidden = 1，列表接口一律过滤，页面上看不到这些题
 *     （想上架时把 is_hidden 改成 0 即可，无需改代码）
 *   - **作者固定**：author_id = 'system-import'，便于一键筛选/回滚
 *     回滚命令：DELETE FROM soups WHERE author_id = 'system-import';
 *   - 数据库配置复用项目 .env（DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');

// —— 复用 server.js 的 .env 加载逻辑（自己实现一份，避免 require server.js 把服务拉起来）——
(function loadEnv() {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
})();

const IMPORT_AUTHOR_ID = 'system-import';
const IMPORT_AUTHOR_NAME = '经典题库';

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] || fallback;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const unhide = process.argv.includes('--unhide');
  const seedFile = path.resolve(ROOT, argValue('--file', path.join('seed', 'puzzles.json')));
  const isHidden = unhide ? 0 : 1;

  if (!fs.existsSync(seedFile)) {
    console.error(`种子文件不存在：${seedFile}`);
    process.exit(1);
  }

  let items;
  try {
    items = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  } catch (e) {
    console.error(`种子文件不是合法 JSON：${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(items) || !items.length) {
    console.error('种子文件里没有题目');
    process.exit(1);
  }

  console.log(`种子文件：${path.relative(ROOT, seedFile)}  共 ${items.length} 题`);
  console.log(`写入状态：is_hidden = ${isHidden}（${isHidden ? '隐藏，不在页面展示' : '上架，页面可见'}）`);
  console.log(dryRun ? '模式：DRY-RUN（只读，不写库）\n' : '模式：实际写入\n');

  const pool = await mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'haiguitang',
    waitForConnections: true,
    connectionLimit: 4,
  });

  // 表结构兜底：老库可能还没有 is_hidden 列
  try {
    await pool.query('ALTER TABLE soups ADD COLUMN is_hidden TINYINT NOT NULL DEFAULT 0');
    console.log('已为 soups 表补充 is_hidden 列\n');
  } catch (e) {
    if (e && e.code !== 'ER_DUP_FIELDNAME') throw e;
  }

  const stats = { added: 0, skipped: 0, invalid: 0 };
  const skippedTitles = [];

  for (const it of items) {
    const title = String(it.title || '').trim();
    const face = String(it.face || '').trim();
    const bottom = String(it.bottom || '').trim();
    if (!title || !face || !bottom) {
      stats.invalid++;
      console.log(`  ✗ 跳过（字段不完整）：${title || '(无题名)'}`);
      continue;
    }

    // 幂等：题名已存在就不重复插入（无论它是导入的还是用户自己建的）
    const [exist] = await pool.query('SELECT id, is_hidden FROM soups WHERE title = ? LIMIT 1', [title]);
    if (exist.length) {
      stats.skipped++;
      skippedTitles.push(`${title}（已存在，is_hidden=${exist[0].is_hidden}）`);
      continue;
    }

    if (dryRun) {
      stats.added++;
      continue;
    }

    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO soups (id, title, face, bottom, type, style, difficulty, author_id, author_name, cover_file, is_hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        title,
        face,
        bottom,
        it.type || '清汤',
        it.style || '本格',
        Number(it.difficulty) || 3,
        IMPORT_AUTHOR_ID,
        IMPORT_AUTHOR_NAME,
        '',
        isHidden,
      ]
    );
    stats.added++;
  }

  console.log('===== 结果 =====');
  console.log(`  ${dryRun ? '待插入' : '已插入'}    ${stats.added}`);
  console.log(`  已存在跳过    ${stats.skipped}`);
  if (stats.invalid) console.log(`  字段不完整    ${stats.invalid}`);
  if (skippedTitles.length) {
    console.log('\n已存在的题目：');
    skippedTitles.slice(0, 10).forEach((t) => console.log('  - ' + t));
    if (skippedTitles.length > 10) console.log(`  ... 其余 ${skippedTitles.length - 10} 条`);
  }

  const [cnt] = await pool.query(
    'SELECT COUNT(*) AS total, SUM(is_hidden = 1) AS hidden FROM soups'
  );
  console.log(`\n库中现有题目：${cnt[0].total} 道（隐藏 ${Number(cnt[0].hidden) || 0} 道）`);

  if (dryRun) console.log('\n这是 DRY-RUN，没有写入任何数据。去掉 --dry-run 即真正导入。');
  await pool.end();
}

main().catch((e) => {
  console.error('\n导入失败：' + e.message);
  process.exit(1);
});
