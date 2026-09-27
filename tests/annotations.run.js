/**
 * 标注数据跑分器（只读 + 评估，不改动离线引擎的任何判定逻辑）
 *
 * 用法：node tests/annotations.run.js
 *     （或 npm run eval:annotations）
 *
 * 输入：
 *   annotations/soups.jsonl  题目池   {soupId,title,type,style,difficulty,face,bottom}
 *   annotations/qa.jsonl     标注     {id,soupId,question,expected,layer,note}
 *
 * 输出两组分数：
 *   ① 规则引擎基线（禁用标注层）——衡量规则本身的好坏，改判定逻辑时看这个
 *   ② 接入标注层后（启用标注层）——衡量玩家实际体验到的准确率
 *
 * 为什么要分两组：标注层是「命中就直接返回人工答案」的查询层，
 * 一旦启用这 12 条必然全对，会掩盖规则引擎的真实水平。
 * 所以默认两组都跑，改引擎看①，看线上效果看②。
 */

const fs = require('fs');
const path = require('path');
const { offlineJudge } = require('../offline-engine.js');
const { annotationStats } = require('../annotation-store.js');

const ROOT = path.join(__dirname, '..');
const SOUPS_FILE = path.join(ROOT, 'annotations', 'soups.jsonl');
const QA_FILE = path.join(ROOT, 'annotations', 'qa.jsonl');

/* ------------------------------------------------------------------ *
 * 宽松 JSONL 解析
 *
 * 标注文件是手写的，汤底里常有真实换行（JSON 字符串不允许未转义换行）。
 * 这里做容错：逐行累加，整段能解析就收一条；解析失败就把换行转义后重试，
 * 继续累加下一行。这样用户照常手写即可，不必手动写 \n。
 * ------------------------------------------------------------------ */
function parseJSONL(text) {
  const out = [];
  const bad = [];
  let buf = '';
  for (const rawLine of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const t = rawLine.trim();
    if (!t) continue;
    buf = buf ? buf + '\n' + t : t;
    let obj = null;
    try {
      obj = JSON.parse(buf);
    } catch (e) {
      // 可能是「字符串里有未转义换行」：全部转义后重试
      try {
        obj = JSON.parse(buf.replace(/\n/g, '\\n'));
      } catch (e2) {
        continue; // 还没凑够一条完整记录，继续累加
      }
    }
    if (obj && typeof obj === 'object') {
      out.push(obj);
      buf = '';
    }
  }
  if (buf.trim()) {
    try {
      out.push(JSON.parse(buf.replace(/\n/g, '\\n')));
    } catch (e) {
      bad.push(buf.slice(0, 60));
    }
  }
  return { rows: out, bad };
}

function readIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

/* ------------------------------------------------------------------ *
 * 答案归一：标注是手写的，允许「有 / 没有 / 不是 / 是或不是」等口语写法
 * ------------------------------------------------------------------ */
const ANSWER_MAP = {
  是: '是', 有: '是', 对的: '是', 没错: '是', yes: '是',
  否: '否', 不是: '否', 没有: '否', 没: '否', 不是的: '否', no: '否',
  无关紧要: '无关紧要', 无关: '无关紧要', 不重要: '无关紧要',
  是或不是: '是或不是', 是也不是: '是或不是', 部分: '是或不是',
};

function normalizeAnswer(raw) {
  if (raw == null) return '';
  const s = String(raw).trim().replace(/[。？?！!，,]$/, '');
  return ANSWER_MAP[s] || s;
}

/* ------------------------------------------------------------------ *
 * 判定分级
 *   correct  完全一致
 *   fallback 引擎答「无关紧要」而标注认为可答 —— 诚实兜底，不误导玩家
 *   wrong    答反了（是↔否），会带偏游戏，必须修
 * ------------------------------------------------------------------ */
function grade(actual, expected) {
  if (actual === expected) return 'correct';
  if (actual === '无关紧要') return 'fallback';
  return 'wrong';
}

const pct = (n, total) => (total ? Math.round((n / total) * 1000) / 10 : 0);

/* ================== 载入标注 ================== */
const soupsText = readIfExists(SOUPS_FILE);
const qaText = readIfExists(QA_FILE);
if (!soupsText || !qaText) {
  console.error('缺少标注文件：annotations/soups.jsonl 或 annotations/qa.jsonl');
  process.exit(1);
}

const soupsParsed = parseJSONL(soupsText);
const qaParsed = parseJSONL(qaText);

const soups = new Map();
soupsParsed.rows.forEach((s) => {
  if (s && s.soupId) soups.set(String(s.soupId), s);
});

if (soupsParsed.bad.length || qaParsed.bad.length) {
  console.log('⚠️  有记录无法解析（JSON 格式问题），已跳过：');
  soupsParsed.bad.concat(qaParsed.bad).forEach((b) => console.log('   - ' + b + '...'));
  console.log('');
}

console.log(`题目 ${soups.size} 道 · 标注 ${qaParsed.rows.length} 条`);

const st = annotationStats();
console.log(
  `标注层状态：${st.state === 'ok' ? '已加载' : st.state}` +
    `（题目 ${st.soups} · 生效标注 ${st.qa} · 索引 ${st.keys} 键` +
    (st.badRecords ? ` · 坏记录 ${st.badRecords}` : '') +
    (st.error ? ` · 错误 ${st.error}` : '') + '）\n'
);

/* ================== 跑分 ================== */
const skipped = [];

/**
 * @param {boolean} useAnnotations 是否启用人工标注层
 */
function evaluateAll(useAnnotations) {
  const results = [];
  for (const q of qaParsed.rows) {
    if (!q || !q.soupId || !q.question) {
      skipped.push({ q, why: '缺少 soupId 或 question' });
      continue;
    }
    const soup = soups.get(String(q.soupId));
    if (!soup) {
      skipped.push({ q, why: 'soupId 在 soups.jsonl 中不存在' });
      continue;
    }
    const expected = normalizeAnswer(q.expected);
    const r = offlineJudge(
      soup.face,
      soup.bottom,
      q.question,
      0,
      { style: soup.style, type: soup.type },
      { annotations: useAnnotations } // 第 6 参：控制标注层开关
    );
    const actual = normalizeAnswer(r.answer);
    results.push({
      id: q.id,
      soupId: q.soupId,
      title: soup.title,
      question: q.question,
      expected,
      actual,
      reason: r.reason,
      layer: q.layer || '未标注',
      note: q.note || '',
      grade: grade(actual, expected),
    });
  }
  return results;
}

const baseResults = evaluateAll(false); // ① 规则引擎基线
const annResults = evaluateAll(true); // ② 接入标注层后

if (skipped.length) {
  console.log('⏭️  跳过 ' + skipped.length + ' 条：');
  skipped.forEach((s) => console.log('   - ' + JSON.stringify(s.q) + ' → ' + s.why));
  console.log('');
}

function count(list) {
  const c = { correct: 0, fallback: 0, wrong: 0 };
  list.forEach((r) => { c[r.grade]++; });
  return c;
}

function printOverview(label, list) {
  const total = list.length;
  const c = count(list);
  console.log(`===== ${label} =====`);
  console.log(`  完全一致（正确）      ${c.correct}/${total}  ${pct(c.correct, total)}%`);
  console.log(`  兜底「无关紧要」      ${c.fallback}/${total}  ${pct(c.fallback, total)}%`);
  console.log(`  答反（会带偏游戏）    ${c.wrong}/${total}  ${pct(c.wrong, total)}%`);
  console.log(`  不误导率（正确+兜底）  ${pct(c.correct + c.fallback, total)}%`);
  console.log('');
  return c;
}

const baseCount = printOverview('① 规则引擎基线（标注层关闭）', baseResults);
const annCount = printOverview('② 接入标注层后（玩家实际体验）', annResults);

const baseTotal = baseResults.length;
const annTotal = annResults.length;
console.log(
  `提升：不误导率 ${pct(baseCount.correct + baseCount.fallback, baseTotal)}% → ` +
    `${pct(annCount.correct + annCount.fallback, annTotal)}%` +
    `（答反 ${baseCount.wrong} → ${annCount.wrong}）\n`
);

/* ================== 按 layer 分类（基于规则引擎基线） ================== */
const byLayer = new Map();
baseResults.forEach((r) => {
  if (!byLayer.has(r.layer)) byLayer.set(r.layer, []);
  byLayer.get(r.layer).push(r);
});

console.log('===== 按类别（规则引擎基线，按答反数排序）=====');
Array.from(byLayer.entries())
  .map(([layer, list]) => {
    const ok = list.filter((r) => r.grade === 'correct').length;
    const fb = list.filter((r) => r.grade === 'fallback').length;
    const bad = list.filter((r) => r.grade === 'wrong').length;
    return { layer, total: list.length, ok, fb, bad, rate: Math.round((ok / list.length) * 100) };
  })
  .sort((a, b) => b.bad - a.bad || a.rate - b.rate)
  .forEach((r) => {
    console.log(
      `  ${r.layer.padEnd(12, '　')} 正确 ${r.ok}/${r.total} (${r.rate}%)  兜底 ${r.fb}  答反 ${r.bad}`
    );
  });

/* ================== 待改进明细（规则引擎仍错的） ================== */
const problems = baseResults.filter((r) => r.grade !== 'correct');
if (problems.length) {
  console.log('\n===== 待改进明细（规则引擎基线，标注层只是掩盖而非修复）=====');
  problems.forEach((r) => {
    const rescued = annResults.find((x) => x.id === r.id);
    const tag = r.grade === 'wrong' ? '❌答反' : '⚠️兜底';
    const tail = rescued && rescued.grade === 'correct' ? '  → 已被标注层命中' : '';
    console.log(`  [${r.id}] ${tag} 《${r.title}》${tail}`);
    console.log(`      提问：${r.question}`);
    console.log(`      应为：${r.expected}    实际：${r.actual}    (${r.reason})`);
    if (r.note) console.log(`      备注：${r.note}`);
  });
}

console.log('\n----------------------------------------');
console.log(
  `跑分完成：${baseTotal} 条 ｜ 规则引擎不误导率 ` +
    `${pct(baseCount.correct + baseCount.fallback, baseTotal)}% ｜ ` +
    `接入标注层后 ${pct(annCount.correct + annCount.fallback, annTotal)}%`
);
