/**
 * 海龟汤知识库 —— 管理者上传的「汤面 / 汤底 / 推理逻辑」语料
 *
 * 定位（对应需求第 2、3 条）：
 *   管理者在管理页批量上传 txt → 解析成「一道汤 = 一个检索单元」→ 写入向量库 collection
 *   `haigui_kb`。玩家在 AI 陪玩中提问时，服务端用提问做向量检索，把命中的知识库题目作为
 *   **判题参考**注入汤主的 system prompt。
 *   因为检索与注入全部发生在服务端，所有用户各自配置的大模型（OpenAI 兼容接口）
 *   天然共享同一份知识库，用户侧零配置 —— 这就是需求第 3 条的落地方式。
 *
 * 与参考项目（Diosama5201/Rag）的链路对齐，但有两处刻意改造：
 *   1. 切片粒度：参考项目用 RecursiveCharacterTextSplitter(chunk 1000 / overlap 100) 定长切。
 *      海龟汤语料是「一题一块」的结构化文本，定长切会把一道题从中间劈开、检索出来是半道题。
 *      这里改为「按题目结构化切分」——一道汤 = 一个检索单元；解析不出结构的散文本才
 *      回落到 1000/100 的定长切分（兜底，不是主路径）。
 *   2. MD5 去重记录：参考项目写 md5.text 文件；本项目约定业务数据一律进 MySQL，
 *      故指纹与上传台账写入 `kb_documents` 表（见 server.js 的 initDatabase）。
 *
 * 依赖：vector-store.js（进程内 1024 维向量库）。
 * 向量落盘在 data/chroma/haigui_kb.json，与题库向量 haigui_soups 分属不同 collection，互不污染。
 */
const crypto = require('crypto');
const chroma = require('./vector-store');

// 知识库专用 collection（题库用 haigui_soups，两者分开，可独立清空/删除）
const KB_COLLECTION = 'haigui_kb';

// 检索默认返回条数与最低相似度门槛。
// 说明：知识库单个单元的文本明显长于题库切片（一题含面+底+推理），
// 长文本在 1024 维归一化向量里会被稀释，实测分数整体低于题库切片，
// 因此门槛取 0.08（低于 server.js 里题库用的 0.12）。
// 管理页提供「检索测试」，可看到真实分数，便于按语料实际情况微调。
const DEFAULT_TOP_K = 4;
const DEFAULT_MIN_SCORE = 0.08;

// 单个检索单元的字数上限：超过则再定长切（防御性，正常一道汤远低于此值）
const MAX_BLOCK_CHARS = 1200;
// 兜底定长切片参数，与参考项目一致
const FALLBACK_CHUNK_SIZE = 1000;
const FALLBACK_CHUNK_OVERLAP = 100;

/* ================================================================== *
 * 一、文本规范化与指纹
 * ================================================================== */

/** 统一差异：去 BOM、统一换行、去掉行尾空白、折叠 3 个以上空行 */
function normalizeText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 内容指纹（MD5）。
 * 参考项目直接对原始字符串取 MD5；这里先做规范化再取，
 * 这样「同一份文件用 Windows 换行 / Unix 换行分别保存」也能识别为重复，不会重复入库。
 */
function fingerprint(text) {
  return crypto.createHash('md5').update(normalizeText(text), 'utf8').digest('hex');
}

/* ================================================================== *
 * 二、字段标签识别
 * ================================================================== */

// 字段标签：按「长的在前」排列，避免「推理」抢先匹配掉「推理逻辑」
const FIELD_LABEL_RE = new RegExp(
  '^(汤名|标题|题目名称|名称' +
  '|汤面|谜面|题干|故事|事件' +
  '|汤底|答案|谜底|真相|解答' +
  '|推理逻辑|推理过程|推理思路|推理解析|推理|解析|思路|分析)' +
  '([:：]?)(.*)$'
);

const LABEL_TO_FIELD = {
  汤名: 'title', 标题: 'title', 题目名称: 'title', 名称: 'title',
  汤面: 'face', 谜面: 'face', 题干: 'face', 故事: 'face', 事件: 'face',
  汤底: 'bottom', 答案: 'bottom', 谜底: 'bottom', 真相: 'bottom', 解答: 'bottom',
  推理逻辑: 'reasoning', 推理过程: 'reasoning', 推理思路: 'reasoning', 推理解析: 'reasoning',
  推理: 'reasoning', 解析: 'reasoning', 思路: 'reasoning', 分析: 'reasoning',
};

/**
 * 判断一行是不是字段标签行。
 *
 * 只有两种形态算标签行，避免把正文误判成标签（例如「真相就是没有人杀他。」）：
 *   ① 带冒号：`汤底：他是被雪橇拉走的。` / `汤面 :`
 *   ② 整行只有标签本身（允许结尾一个标点）：单独成行的 `汤底`
 * 「解析一下」「真相就是没有人杀他。」都不满足，按正文处理。
 *
 * @returns {null|{field:string, rest:string}}
 */
function matchFieldLabel(line) {
  const raw = String(line == null ? '' : line);
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const m = trimmed.match(FIELD_LABEL_RE);
  if (!m) return null;

  const label = m[1];
  const colon = m[2];
  const rest = m[3].trim();
  const field = LABEL_TO_FIELD[label];
  if (!field) return null;

  if (colon) return { field, rest };                       // 形态①
  // 形态②：剩下的部分必须为空或只有一个结尾标点
  if (!rest || /^[。！？；，、,.!?;:]+$/.test(rest)) return { field, rest: '' };
  return null;
}

/* ================================================================== *
 * 三、题块切分
 * ================================================================== */

// 分隔线：==== / ---- / **** / ~~~~ / ———— 等三个以上重复符号
const SEPARATOR_RE = /^\s*[-=*_~—]{3,}\s*$/;

// 题号起始：第1题 / 第 一 碗 / 【3】 / 3. / 3、
const QUESTION_START_RE = /^\s*(?:第\s*[0-9一二三四五六七八九十百]+\s*[碗题则个]|[【\[]\s*[0-9]+\s*[】\]]|[0-9]+\s*[.、．)]\s*\S)/;

/**
 * 把整篇文本切成「原始题块」。
 *
 * 三条规则，按优先级落地（确定性，不做模糊猜测）：
 *   ① 文件里出现分隔线 → 只按分隔线切（显式结构优先于任何推断）
 *   ② 否则，若出现 ≥2 个题号起始行，且文件里存在字段标签 → 按题号起始行切
 *   ③ 否则整篇当作一块
 */
function splitRawBlocks(text) {
  const lines = normalizeText(text).split('\n');
  if (!lines.length) return [];

  const hasSeparator = lines.some((l) => SEPARATOR_RE.test(l));
  const hasLabel = lines.some((l) => matchFieldLabel(l));
  const startIdx = lines.map((l, i) => (QUESTION_START_RE.test(l) ? i : -1)).filter((i) => i >= 0);

  let boundaries;
  if (hasSeparator) {
    boundaries = lines.map((l, i) => (SEPARATOR_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  } else if (hasLabel && startIdx.length >= 2) {
    boundaries = startIdx;
  } else {
    boundaries = [];
  }

  if (!boundaries.length) {
    const whole = lines.join('\n').trim();
    return whole ? [whole] : [];
  }

  const blocks = [];
  let cur = [];
  for (let i = 0; i < lines.length; i++) {
    if (boundaries.includes(i)) {
      const done = cur.join('\n').trim();
      if (done) blocks.push(done);
      cur = [];
      // 分隔线自身丢弃；题号起始行属于新块，保留
      if (!SEPARATOR_RE.test(lines[i])) cur.push(lines[i]);
    } else {
      cur.push(lines[i]);
    }
  }
  const tail = cur.join('\n').trim();
  if (tail) blocks.push(tail);
  return blocks;
}

/* ================================================================== *
 * 四、题块 → 结构化字段
 * ================================================================== */

/** 去掉标题里的题号前缀：`1. 谜泪` → `谜泪`、`【3】宿舍` → `宿舍` */
function stripNumberPrefix(title) {
  return String(title || '')
    .replace(/^\s*(?:第\s*[0-9一二三四五六七八九十百]+\s*[碗题则个]|[【\[]\s*[0-9]+\s*[】\]]|[0-9]+\s*[.、．)])\s*/, '')
    .trim();
}

/**
 * 解析单个原始题块 → { title, face, bottom, reasoning, kind, text }
 *   kind = 'soup'（含汤底/推理逻辑，一道完整可判题的参考）
 *        | 'note'（只有说明性文本）
 */
function extractFields(rawBlock) {
  const lines = String(rawBlock || '').split('\n');
  const buckets = { preamble: [], title: [], face: [], bottom: [], reasoning: [] };
  let cur = 'preamble';

  for (const line of lines) {
    const hit = matchFieldLabel(line);
    if (hit) {
      cur = hit.field;
      if (hit.rest) buckets[cur].push(hit.rest);
      continue;
    }
    buckets[cur].push(line);
  }

  const join = (arr) => arr.join('\n').trim();

  let title = join(buckets.title);
  let face = join(buckets.face);
  let bottom = join(buckets.bottom);
  const reasoning = join(buckets.reasoning);

  // 没有显式「汤面」标签时，前言部分按「首行是标题、其余是汤面」处理
  // （与 server.js 里 txt 上传的既有启发式保持一致）
  if (!face) {
    const preamble = buckets.preamble.map((l) => l.trim()).filter(Boolean);
    if (!title && preamble.length && preamble[0].length <= 30) {
      title = preamble.shift();
    }
    face = preamble.join('\n').trim();
  } else if (!title) {
    const preamble = buckets.preamble.map((l) => l.trim()).filter(Boolean);
    if (preamble.length && preamble[0].length <= 30) title = preamble.shift();
  }

  title = stripNumberPrefix(title);

  const kind = (bottom || reasoning) ? 'soup' : 'note';

  // 检索单元正文：带字段标签，便于注入 prompt 后大模型直接读懂结构
  const parts = [];
  if (title) parts.push(`题目：${title}`);
  if (face) parts.push(`汤面：${face}`);
  if (bottom) parts.push(`汤底：${bottom}`);
  if (reasoning) parts.push(`推理逻辑：${reasoning}`);
  let text = parts.join('\n').trim();
  if (!text) text = String(rawBlock || '').trim();

  return { title, face, bottom, reasoning, kind, text };
}

/* ================================================================== *
 * 五、对外：解析整份文件
 * ================================================================== */

/**
 * 把一份 txt 文件解析成检索单元数组。
 *
 * @param {string} text     文件全文
 * @param {string} filename 文件名（仅用于兜底标题，不参与路径拼接）
 * @returns {Array<{title,face,bottom,reasoning,kind,text}>}
 */
function parseKnowledgeFile(text, filename) {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const raws = splitRawBlocks(normalized);
  const blocks = [];
  for (const r of raws) {
    const b = extractFields(r);
    if (b.text) blocks.push(b);
  }
  if (!blocks.length) return [];

  // 兜底：整份文件没有任何可识别的结构（既无汤底/推理逻辑，也无字段标签），
  // 且篇幅超长 → 按参考项目的 1000/100 定长切分，至少让长文可被检索到。
  const onlyOne = blocks.length === 1;
  const noStructure = blocks.every((b) => b.kind === 'note');
  if (onlyOne && noStructure && blocks[0].text.length > FALLBACK_CHUNK_SIZE) {
    const baseName = String(filename || '').replace(/\.txt$/i, '');
    return chroma
      .chunkText(blocks[0].text, FALLBACK_CHUNK_SIZE, FALLBACK_CHUNK_OVERLAP)
      .map((t, i) => ({
        title: i === 0 ? baseName : `${baseName}（续 ${i + 1}）`,
        face: '', bottom: '', reasoning: '', kind: 'note', text: t,
      }));
  }

  return blocks;
}

/* ================================================================== *
 * 六、入库 / 删除 / 检索
 * ================================================================== */

/**
 * 把一个文档的所有检索单元批量写入向量库。
 * 每个单元超过 MAX_BLOCK_CHARS 才继续定长切（防御病态长块）。
 *
 * 注意：这里对每个文档只调用一次 chroma.add（批量），
 * 因为 vector-store 每次 add 都会整体重写 JSON 文件，逐块调用会退化成 O(n²)。
 *
 * @returns {{blocks:number, chunks:number}}
 */
function ingestBlocks({ docId, filename, blocks, operator }) {
  const ids = [];
  const docs = [];
  const metas = [];

  (blocks || []).forEach((b, i) => {
    const pieces = b.text.length > MAX_BLOCK_CHARS
      ? chroma.chunkText(b.text, FALLBACK_CHUNK_SIZE, FALLBACK_CHUNK_OVERLAP)
      : [b.text];
    pieces.forEach((t, j) => {
      ids.push(`${docId}:${i}:${j}`);
      docs.push(t);
      metas.push({
        docId,
        filename: filename || '',
        kind: b.kind,
        title: b.title || '',
        blockIndex: i,
        pieceIndex: j,
        operator: operator || '',
      });
    });
  });

  if (docs.length) {
    chroma.add(KB_COLLECTION, { ids, documents: docs, metadatas: metas });
  }
  return { blocks: (blocks || []).length, chunks: docs.length };
}

/** 按文档 id 删除该文档的全部向量（上传后回滚 / 管理员删文件时用） */
function deleteByDocument(docId) {
  if (!docId) return 0;
  return chroma.deleteWhere(KB_COLLECTION, (meta) => meta && meta.docId === docId);
}

/**
 * 按提问检索知识库。
 * @returns [{ text, meta, score }]
 */
function search(question, opts) {
  const o = opts || {};
  const n = o.n || DEFAULT_TOP_K;
  const minScore = typeof o.minScore === 'number' ? o.minScore : DEFAULT_MIN_SCORE;
  const hits = chroma.query(KB_COLLECTION, { queryText: question, n, where: o.where });
  return hits
    .filter((h) => h.score > minScore)
    .map((h) => ({
      text: h.text,
      score: h.score,
      title: (h.meta && h.meta.title) || '',
      filename: (h.meta && h.meta.filename) || '',
      kind: (h.meta && h.meta.kind) || 'note',
    }));
}

/** 知识库当前向量条数 */
function count() {
  return chroma.count(KB_COLLECTION);
}

/**
 * 把检索结果渲染成注入 system prompt 的参考块。
 * @returns {string} 无命中时返回空串（调用方据此不追加任何内容）
 */
function buildContextBlock(hits, label) {
  if (!hits || !hits.length) return '';
  const lines = hits.map((h, i) => {
    const head = h.title ? `参考资料 ${i + 1}（题目：${h.title}）` : `参考资料 ${i + 1}`;
    return `${head}：\n${h.text}`;
  });
  return `\n\n【${label || '海龟汤知识库参考'}】\n` +
    '以下内容来自管理者上传的海龟汤知识库，是出题人内部使用的判题参考（可能包含**其他题目**的汤底与推理逻辑）。\n' +
    '用途：帮你理解同类谜题的常见设定与推理范式，从而更准确地判断玩家当前的提问。\n' +
    '【硬性要求】这些内容只供你内部对照，**绝对不可**向玩家复述、引用或暗示；也**不得**用其中的情节替换当前这碗汤的事实；当前这碗汤的汤底才是唯一事实来源。\n' +
    lines.join('\n');
}

module.exports = {
  KB_COLLECTION,
  DEFAULT_TOP_K,
  DEFAULT_MIN_SCORE,
  normalizeText,
  fingerprint,
  matchFieldLabel,
  splitRawBlocks,
  extractFields,
  stripNumberPrefix,
  parseKnowledgeFile,
  ingestBlocks,
  deleteByDocument,
  search,
  count,
  buildContextBlock,
};
