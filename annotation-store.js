/**
 * 人工标注标准答案表（离线引擎「第二层接入」）
 *
 * 设计边界（重要）：
 *   - 这一层**只做查询**，不参与、不修改 offline-engine.js 里的任何判定逻辑。
 *   - 命中 = 直接返回人工确认过的标准答案；未命中 = 原样交回规则引擎。
 *   - 标注文件缺失 / 解析失败 / 题目对不上 → 一律静默降级，引擎行为与接入前完全一致。
 *
 * 数据来源（用户手写，视为只读）：
 *   annotations/soups.jsonl  题目池 {soupId,title,type,style,difficulty,face,bottom}
 *   annotations/qa.jsonl     标注   {id,soupId,question,expected,layer,note}
 *
 * 题目身份怎么对上：
 *   标注里的 soupId（s1…s6）是标注集内部编号，跟数据库主键无关，所以运行时
 *   用**题目文本指纹**识别：归一化后的 face（汤面）与 bottom（汤底）都可以作为指纹。
 *   offlineJudge 本来就收到 face / bottom 两个参数，因此**不需要改 server.js**。
 */

const fs = require('fs');
const path = require('path');

// 默认取项目下的 annotations/；可用环境变量覆盖（便于测试降级路径、或换数据集）。
// 注意必须在【每次构建时】解析，不能在模块加载时固化成常量，
// 否则运行时改 env 不生效（降级路径就测不到了）。
function annotationDir() {
  return process.env.ANNOTATIONS_DIR || path.join(__dirname, 'annotations');
}
const soupsFile = () => path.join(annotationDir(), 'soups.jsonl');
const qaFile = () => path.join(annotationDir(), 'qa.jsonl');

/* ------------------------------------------------------------------ *
 * 宽松 JSONL 解析
 *
 * 标注文件是手写的，汤底里常有真实换行（JSON 字符串不允许未转义换行）。
 * 容错策略：逐行累加 → 整段能解析就收一条 → 失败则把换行全部转义后重试
 * → 还不行就继续累加下一行。用户照常手写即可，不必手动写 \n。
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

/* ------------------------------------------------------------------ *
 * 答案归一：标注是手写的，允许「有 / 没有 / 不是 / 是或不是」等口语写法。
 * 归一后必定落在 server.js 的 answer 白名单内（是 / 否 / 无关紧要 / 是或不是）。
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

const VALID_ANSWERS = new Set(['是', '否', '无关紧要', '是或不是']);

/* ------------------------------------------------------------------ *
 * 文本指纹：只保留中英文数字，天然吃掉空白与中英文标点差异。
 * 「老大死了吗？」与「老大死了吗?」得到同一个指纹。
 * ------------------------------------------------------------------ */
function normText(s) {
  return String(s || '').replace(/[^一-龥a-zA-Z0-9]/g, '').toLowerCase();
}

/* ------------------------------------------------------------------ *
 * 提问的宽松变体：玩家不会一字不差照着标注问。
 * 去掉句尾/句中的疑问语气词后再比一次，扩大命中面。
 * 这是「查表的键更宽松」，不涉及判定逻辑；标注答案是人工确认过的，
 * 多命中只会让答案更准，不会引入新的错答方向。
 * ------------------------------------------------------------------ */
const QUESTION_TAIL_CHARS = /[吗么呢啊吧呀啦嘛呗咯喽]/g;

function questionKeys(question) {
  const keys = [];
  const a = normText(question);
  if (a) keys.push(a);
  const b = normText(String(question || '').replace(QUESTION_TAIL_CHARS, ''));
  if (b && b !== a) keys.push(b);
  return keys;
}

/* ------------------------------------------------------------------ *
 * 索引构建（进程内只建一次）
 *   key = 题目指纹 + '\u0001' + 提问指纹
 *   同一道题用 face / bottom 两种指纹各建一份，任一文本一致即可命中。
 * ------------------------------------------------------------------ */
let INDEX = null;
let LOAD_STATE = 'not-loaded'; // not-loaded | ok | missing | error
let LOAD_ERROR = null;
const STATS = { soups: 0, qa: 0, keys: 0, bad: 0 };

function readIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
}

function buildIndex() {
  const soupsText = readIfExists(soupsFile());
  const qaText = readIfExists(qaFile());

  if (!soupsText || !qaText) {
    LOAD_STATE = 'missing';
    INDEX = null;
    return;
  }

  const soupsParsed = parseJSONL(soupsText);
  const qaParsed = parseJSONL(qaText);
  STATS.bad = soupsParsed.bad.length + qaParsed.bad.length;

  const soups = new Map();
  soupsParsed.rows.forEach((s) => {
    if (s && s.soupId) soups.set(String(s.soupId), s);
  });
  STATS.soups = soups.size;

  const idx = new Map();

  const addKey = (soupKey, qKey, value) => {
    if (!soupKey || !qKey) return;
    const k = soupKey + '' + qKey;
    // 同一 key 已被占则保留先出现的那条（标注文件里靠前的为准）
    if (!idx.has(k)) idx.set(k, value);
  };

  qaParsed.rows.forEach((q) => {
    if (!q || !q.soupId || !q.question) return;
    const soup = soups.get(String(q.soupId));
    if (!soup) return; // soupId 在题目池里不存在 → 这条标注无法定位题目，跳过

    const answer = normalizeAnswer(q.expected);
    if (!VALID_ANSWERS.has(answer)) return; // 超出四档白名单的标注不生效，避免污染回答

    const value = {
      answer,
      id: q.id,
      layer: q.layer || '',
      note: q.note || '',
      title: soup.title || '',
      soupId: String(q.soupId),
    };

    const soupKeys = [normText(soup.face), normText(soup.bottom), normText(soup.title)]
      .filter(Boolean);
    const qKeys = questionKeys(q.question);

    for (const sk of soupKeys) {
      for (const qk of qKeys) addKey(sk, qk, value);
    }
    STATS.qa++;
  });

  STATS.keys = idx.size;
  INDEX = idx;
  LOAD_STATE = 'ok';
}

function ensureIndex() {
  if (LOAD_STATE === 'not-loaded') {
    try {
      buildIndex();
    } catch (e) {
      LOAD_STATE = 'error';
      LOAD_ERROR = e.message;
      INDEX = null;
    }
  }
  return INDEX;
}

/**
 * 查标准答案。
 * @param {{face?:string, bottom?:string, title?:string, question:string}} args
 * @returns {null|{answer:string,id:*,layer:string,note:string,title:string,soupId:string}}
 *          null = 未命中（或标注不可用），调用方应继续走规则引擎
 */
function lookupAnnotation(args) {
  const idx = ensureIndex();
  if (!idx || !idx.size) return null;

  const q = String((args && args.question) || '').trim();
  if (!q) return null;

  const soupKeys = [
    normText(args && args.face),
    normText(args && args.bottom),
    normText(args && args.title),
  ].filter(Boolean);
  if (!soupKeys.length) return null;

  const qKeys = questionKeys(q);
  for (const sk of soupKeys) {
    for (const qk of qKeys) {
      const hit = idx.get(sk + '' + qk);
      if (hit) return hit;
    }
  }
  return null;
}

function annotationStats() {
  ensureIndex();
  return {
    state: LOAD_STATE,
    error: LOAD_ERROR,
    soups: STATS.soups,
    qa: STATS.qa,
    keys: STATS.keys,
    badRecords: STATS.bad,
  };
}

/** 仅供测试：强制重新加载（改了标注文件后不想重启进程时用） */
function reloadAnnotations() {
  LOAD_STATE = 'not-loaded';
  INDEX = null;
  LOAD_ERROR = null;
  return ensureIndex();
}

module.exports = {
  lookupAnnotation,
  annotationStats,
  reloadAnnotations,
  normalizeAnswer,
  parseJSONL,
  normText,
  questionKeys,
};
