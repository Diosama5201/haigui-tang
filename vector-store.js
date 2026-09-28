/**
 * 内嵌式向量库（Chroma 风格 API）
 *
 * 说明：真正的 Chroma 需要独立运行的 Python 服务端（chroma run）。
 * 本项目部署形态为「Windows Server + pm2 + 零额外进程」，为避免引入 Python 依赖，
 * 这里实现一个与 Chroma 语义对齐的内嵌向量库：
 *   - collection 管理 / add / deleteWhere / query / count
 *   - 向量 = 本地字符 n-gram 哈希嵌入（中文友好、确定性、零外部依赖）
 *   - 检索 = 余弦相似度 Top-K
 *   - 持久化 = data/chroma/<collection>.json（写入临时文件后原子替换，防写坏）
 *
 * 后续若部署真 Chroma 服务端，只需替换本文件内部实现，对 server.js 接口不变。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR_DEFAULT = path.join(__dirname, 'data', 'chroma');
const DIM = 1024; // 嵌入向量维度（1024 维显著降低短文本的哈希碰撞噪声）

// 落盘目录允许用环境变量覆盖（数据隔离），与 annotation-store.js 的 ANNOTATIONS_DIR 同一套约定。
// 必须在【每次访问时】解析，不能在模块加载时固化成常量，否则运行期改 env 不生效（测试就用不了隔离目录）。
function dataDir() {
  return process.env.CHROMA_DIR || DATA_DIR_DEFAULT;
}

// ==================== 本地嵌入：字符 unigram + bigram 哈希 ====================
// FNV-1a 32 位哈希，把每个字符/二元组映射到固定维度
function h32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 文本 → L2 归一化向量（1024 维）
 * unigram 权重 1，bigram 权重 1.6（中文语义更依赖相邻字组合）
 * 采用带符号哈希（特征哈希法）：碰撞项正负抵消，显著降低不相关文本的虚假相似度
 */
function embed(text) {
  const v = new Array(DIM).fill(0);
  const t = String(text || '').toLowerCase().replace(/\s+/g, '');
  const put = (s, w) => {
    const h = h32(s);
    v[h % DIM] += (h & 1 ? 1 : -1) * w;
  };
  for (let i = 0; i < t.length; i++) {
    put(t[i], 1);
    if (i + 1 < t.length) put(t.slice(i, i + 2), 1.6);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIM; i++) v[i] = v[i] / norm;
  return v.map((x) => Math.round(x * 1e5) / 1e5);
}

// 归一化向量的点积即余弦相似度
function cosine(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// ==================== collection 管理 ====================
const collections = new Map();

function colPath(name) {
  const safe = String(name).replace(/[^\w-]/g, ''); // 防路径穿越
  return path.join(dataDir(), safe + '.json');
}

function getCollection(name) {
  if (collections.has(name)) return collections.get(name);
  const p = colPath(name);
  let data = { name, embedding: 'local-ngram-1024', items: [] };
  try {
    if (fs.existsSync(p)) data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('[chroma] 读取向量库失败，使用空库:', e.message);
  }
  const col = { ...data, _path: p };
  collections.set(name, col);
  return col;
}

// 持久化：写临时文件再原子替换，避免写一半损坏
function persist(col) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const snapshot = {
      name: col.name,
      embedding: col.embedding,
      items: col.items,
    };
    const tmp = col._path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, col._path);
  } catch (e) {
    console.error('[chroma] 向量库持久化失败:', e.message);
  }
}

/**
 * 新增/覆盖文档（同 id 覆盖，天然去重）
 * @returns 当前 collection 内条目总数
 */
function add(name, { ids, documents, metadatas }) {
  if (!Array.isArray(documents) || documents.length === 0) return getCollection(name).items.length;
  const col = getCollection(name);
  for (let i = 0; i < documents.length; i++) {
    const id = ids[i];
    const idx = col.items.findIndex((it) => it.id === id);
    const item = {
      id,
      text: documents[i],
      embedding: embed(documents[i]),
      meta: metadatas && metadatas[i] ? metadatas[i] : {},
    };
    if (idx >= 0) col.items[idx] = item;
    else col.items.push(item);
  }
  persist(col);
  return col.items.length;
}

/** 按 meta 条件删除，返回删除条数 */
function deleteWhere(name, fn) {
  const col = getCollection(name);
  const before = col.items.length;
  col.items = col.items.filter((it) => !fn(it.meta || {}, it));
  if (col.items.length !== before) persist(col);
  return before - col.items.length;
}

function count(name) {
  return getCollection(name).items.length;
}

/**
 * 相似度检索 Top-K
 * @returns [{ text, meta, score }]，score 为余弦相似度（0~1）
 */
function query(name, { queryText, n = 4, where }) {
  const col = getCollection(name);
  const qv = embed(queryText);
  let items = col.items;
  if (where) items = items.filter((it) => where(it.meta || {}));
  return items
    .map((it) => ({ text: it.text, meta: it.meta, score: cosine(qv, it.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

// ==================== 文本切块 ====================
/**
 * 按固定长度切块，尽量在中文句末标点处断开，相邻块保留 overlap 字符
 */
function chunkText(text, size = 180, overlap = 30) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (t.length <= size) return [t];
  const chunks = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(t.length, start + size);
    if (end < t.length) {
      const seg = t.slice(start, end);
      const cut = Math.max(
        seg.lastIndexOf('。'),
        seg.lastIndexOf('！'),
        seg.lastIndexOf('？'),
        seg.lastIndexOf('；'),
        seg.lastIndexOf('.')
      );
      if (cut > size * 0.5) end = start + cut + 1;
    }
    chunks.push(t.slice(start, end).trim());
    if (end >= t.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

module.exports = { add, deleteWhere, query, count, chunkText, embed };
