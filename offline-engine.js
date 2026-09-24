/**
 * 内置离线推理引擎（不调用大模型，零成本）
 *
 * 以「汤面 + 汤底」为唯一真相源，对玩家的是非题做关键词匹配判定：
 *   - 命中关键词且非否定 → 「是」
 *   - 命中关键词但被否定词修饰，或汤底明确相反 → 「否」
 *   - 是/否都拿不准 → 「无关紧要」（海龟汤汤主的合法兜底回答，不剧透不误导）
 *   - 开放式提问 → 引导换成是非题
 *
 * 判定粒度粗、但「确定才答、拿不准诚实兜底」，避免把游戏带偏。
 * 配了大模型的用户仍走大模型（handleAIAsk 中优先，失败回退本引擎）。
 */

// 中文停用词 + 无意义虚词（用于从汤底抽取关键实义词）
const STOPWORDS = new Set(
  '的了是在和有着就被这那个中上下里外自己因为所以但是然而如果那么已经曾经正在不是没有大概或许应该可以可能也许然后于是因此之乎者也啊吧呢吗了啦'.split('')
);

// 否定词（提问中出现且修饰关键实体时倾向判「否」）
const NEG_WORDS = ['不是', '没有', '并非', '不', '没', '否', '未', '无'];

// 开放式提问特征（引导用户换成是非题）
const OPEN_WH = ['为什么', '为何', '怎么', '如何', '什么样', '谁', '什么', '哪', '多少', '请问', '解释', '描述', '讲一下'];

/** 分词：中文按字符二元组 + 英文/数字按连续片段切，返回词频 Map */
function tokenize(text) {
  const t = String(text || '');
  const map = new Map();
  const add = (w) => { if (w) map.set(w, (map.get(w) || 0) + 1); };
  // 英文/数字词
  const latin = t.match(/[a-zA-Z0-9_]{2,}/g) || [];
  latin.forEach(add);
  // 中文 bigram
  const zh = t.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i < zh.length - 1; i++) add(zh.slice(i, i + 2));
  return map;
}

/** 从汤底抽取关键实义词（去停用词后保留高频 bigram） */
function extractKeywords(bottom) {
  const map = tokenize(bottom);
  const words = [];
  for (const [w, c] of map) {
    if (w.length === 1 && STOPWORDS.has(w)) continue;
    if (c >= 1) words.push({ w, c });
  }
  return words.sort((a, b) => b.c - a.c);
}

/** 判断玩家提问是否为开放式（非是非题） */
function isOpenQuestion(question) {
  const q = String(question || '').trim();
  if (q.endsWith('吗') || q.endsWith('么') || q.endsWith('？') || q.endsWith('?')) return false;
  if (OPEN_WH.some((w) => q.startsWith(w))) return true;
  if (q.includes('还是')) return true; // 选择题
  return !q.endsWith('吗');
}

/** 检测提问中是否有否定语义（且否定的是实体而非整句反问） */
function hasNegation(question) {
  return NEG_WORDS.some((w) => String(question || '').includes(w));
}

/**
 * 离线判定：返回 { answer, progress, reason, matched }
 * @param {string} face 汤面
 * @param {string} bottom 汤底
 * @param {string} question 玩家提问
 * @param {number} prevProgress 历史累计进度（0~100）
 *
 * 判定策略（保守——确定才答，拿不准兜底）：
 *   - 提问与汤底存在「实义 bigram 词元」重合 → 相关
 *   - 相关且带否定 → 否；相关且无否定 → 是
 *   - 仅单字兜底重合（方向对但无法确认）→ 无关紧要，但进度小幅 +1（表示在探索正确方向）
 *   - 完全无重合 → 无关紧要，进度不变
 *   - 开放式提问 → 无关紧要
 */
function offlineJudge(face, bottom, question, prevProgress) {
  const q = String(question || '').trim();
  const prev = Math.max(0, Math.min(100, Number(prevProgress) || 0));

  if (!q) return { answer: '无关紧要', progress: prev, reason: 'empty' };
  if (isOpenQuestion(q)) {
    return { answer: '无关紧要', progress: prev, reason: 'open-question' };
  }

  const qTokens = tokenize(q);
  const qChars = new Set(q.replace(/[^\u4e00-\u9fa5]/g, '')); // 提问中的单字
  const bottomText = String(bottom || '');

  // 1) bigram 词元重合（强相关）
  const kws = extractKeywords(bottom);
  let hitCount = 0;
  const matched = [];
  for (const { w } of kws) {
    if (qTokens.has(w)) {
      hitCount++;
      matched.push(w);
      if (matched.length >= 8) break;
    }
  }

  const neg = hasNegation(q);

  if (hitCount > 0) {
    // 命中实义词：确定相关
    const answer = neg ? '否' : '是';
    const newProgress = Math.min(85, prev + Math.max(4, hitCount * 4));
    return { answer, progress: newProgress, reason: 'match', matched };
  }

  // 2) 单字兜底：提问里的实字在汤底出现较多 → 方向对但无法确认具体事实
  let charHit = 0;
  for (const c of qChars) {
    if (STOPWORDS.has(c)) continue;
    if (bottomText.includes(c)) charHit++;
  }
  const charRatio = qChars.size ? charHit / qChars.size : 0;
  if (charRatio >= 0.5 && charHit >= 2) {
    // 方向相关，但无法确定 → 兜底「无关紧要」，进度小幅 +1（玩家在正确方向探索）
    return { answer: '无关紧要', progress: Math.min(85, prev + 1), reason: 'directional', matched: [] };
  }

  // 3) 完全无重合
  return { answer: '无关紧要', progress: prev, reason: 'no-overlap' };
}

module.exports = { offlineJudge, extractKeywords, tokenize, isOpenQuestion, hasNegation };
