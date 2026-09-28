/**
 * 海龟汤网站 — 后端服务
 * 技术栈：Node.js 原生 http 模块 + MySQL（mysql2）
 * 功能：用户注册/登录（JWT 鉴权）、海龟汤的增删查（全局共享）、txt 文件上传
 * 数据：用户与海龟汤均存 MySQL；所有登录用户看到同一份全量海龟汤库，删除仅限创建者本人
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const chroma = require('./vector-store'); // 内嵌 Chroma 风格向量库
const knowledgeBase = require('./knowledge-base'); // 管理者知识库（RAG 第二层：汤面 / 汤底 / 推理逻辑）
const { parseMultipart, parseBoundary, sanitizeFilename, decodeTextBuffer } = require('./upload-utils'); // 上传字节级工具
const { parseProgressFromText, estimateProgressLocally } = require('./progress-utils'); // 进度智能体纯函数工具
const offlineEngine = require('./offline-engine'); // 内置离线推理引擎

// 向量库 collection 名称（汤类知识库统一存这里）
const VECTOR_COLLECTION = 'haigui_soups';

// 管理者口令：**只从环境变量读取，代码里不留任何默认值**。
// 本仓库是公开仓库，把口令写进源码等于对外公开；因此未配置时管理入口整体不可用（返回 503），
// 其余功能完全不受影响。配置方式见 README「管理者入口」一节。
// ⚠️ 变量本身必须在下方 loadEnv() 执行**之后**读取，否则本地 .env 里配的口令不会生效。
const ADMIN_TOKEN_EXPIRE = 2 * 60 * 60 * 1000; // 管理令牌 2 小时，短于普通登录令牌的 7 天
// 口令失败限流：同一 IP 15 分钟内连续失败 5 次即锁定到窗口结束
const ADMIN_FAIL_WINDOW = 15 * 60 * 1000;
const ADMIN_MAX_FAILS = 5;

// 请求体上限：普通 JSON 接口沿用 10MB；管理页批量上传 txt 放宽到 50MB
const MAX_JSON_BODY = 10 * 1024 * 1024;
const MAX_KB_BODY = 50 * 1024 * 1024;
// 单次上传的文件个数与单文件大小上限（防一次性灌爆内存）
const KB_MAX_FILES = 50;
const KB_MAX_FILE_BYTES = 8 * 1024 * 1024;
const KB_MAX_FILE_CHARS = 2 * 1024 * 1024;

// ==================== 加载 .env（若存在，不覆盖已有环境变量） ====================
(function loadEnv() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // 去掉首尾引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
})();

// ==================== 基础配置（环境变量优先） ====================
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'haigui-tang-secret-please-change-in-prod';
const TOKEN_EXPIRE = 7 * 24 * 60 * 60 * 1000; // 7 天

// 管理者口令（必须在 loadEnv() 之后读取，见文件上方说明）。
// 未配置 → 管理入口返回 503 并给出明确指引，而不是静默放行或崩溃。
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');

// MySQL 连接配置（通过环境变量注入，禁止硬编码）
const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'haiguitang',
  charset: 'utf8mb4',
  // 数字按 number 返回，避免 bigint 序列化问题
  decimalNumbers: true,
};

// 上传文件仍存本地磁盘（txt 内容解析后入库，原始文件留档）
const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 汤封面图目录（文件名为随机 UUID，URL 不可枚举）
const COVER_DIR = path.join(__dirname, 'data', 'uploads', 'covers');
if (!fs.existsSync(COVER_DIR)) fs.mkdirSync(COVER_DIR, { recursive: true });

// 允许的封面文件名格式（服务端生成的 uuid.ext，杜绝路径拼接注入）
const COVER_FILE_RE = /^[\w-]+\.(jpg|jpeg|png|webp)$/i;

// 封面图片魔数校验：不信任扩展名，只认文件头
function detectImageExt(buf) {
  if (!buf || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  // WEBP: 'RIFF' .... 'WEBP'
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

// 删除封面文件（存在才删，异常不中断主流程）
function removeCoverFile(file) {
  if (!file || !COVER_FILE_RE.test(file)) return;
  try {
    const p = path.join(COVER_DIR, file);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    console.error('remove cover file error:', e.message);
  }
}

// 由库内文件名拼出对外访问地址
function coverUrlOf(file) {
  return file ? '/covers/' + file : '';
}

// ==================== 密码加密（加盐 SHA256） ====================
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}
function genSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// ==================== JWT（简化自实现，HS256） ====================
function base64url(str) {
  return Buffer.from(str).toString('base64url');
}
function base64urlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}
function signToken(payload, ttlMs) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, exp: Date.now() + (ttlMs || TOKEN_EXPIRE) };
  const h = base64url(JSON.stringify(header));
  const b = base64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest('base64url');
  return `${h}.${b}.${sig}`;
}
function verifyToken(token) {
  try {
    const [h, b, sig] = token.split('.');
    if (!h || !b || !sig) return null;
    const expect = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest('base64url');
    if (expect !== sig) return null;
    const payload = JSON.parse(base64urlDecode(b));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// ==================== 数据库连接池与初始化 ====================
let pool = null;

/**
 * 初始化数据库：
 * 1. 若目标库不存在则创建
 * 2. 建 users / soups 表（IF NOT EXISTS）
 */
async function initDatabase() {
  // 先不带 database 连接，用于建库
  const { database, ...serverConfig } = DB_CONFIG;
  const conn = await mysql.createConnection(serverConfig);
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.end();

  // 用指定库建连接池
  pool = mysql.createPool({ ...DB_CONFIG, waitForConnections: true, connectionLimit: 10 });

  // 建表
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            VARCHAR(36)  PRIMARY KEY,
      username      VARCHAR(50)  NOT NULL UNIQUE,
      salt          VARCHAR(32)  NOT NULL,
      password_hash VARCHAR(64)  NOT NULL,
      created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 用户陪玩引擎设置：每用户独立配置大模型（未开启时使用内置离线引擎）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id       VARCHAR(36)  PRIMARY KEY,
      llm_enabled   TINYINT      NOT NULL DEFAULT 0,
      llm_base_url  VARCHAR(300) NOT NULL DEFAULT '',
      llm_model     VARCHAR(100) NOT NULL DEFAULT '',
      llm_api_key   VARCHAR(300) NOT NULL DEFAULT '',
      updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS soups (
      id          VARCHAR(36)  PRIMARY KEY,
      title       VARCHAR(200) NOT NULL,
      face        TEXT         NOT NULL,
      bottom      TEXT         NOT NULL,
      type        VARCHAR(10)  NOT NULL DEFAULT '清汤',
      style       VARCHAR(10)  NOT NULL DEFAULT '本格',
      difficulty  TINYINT      NOT NULL DEFAULT 1,
      author_id   VARCHAR(36)  NOT NULL,
      author_name VARCHAR(50)  NOT NULL,
      cover_file  VARCHAR(100) NOT NULL DEFAULT '',
      is_hidden   TINYINT      NOT NULL DEFAULT 0,
      created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created (created_at),
      INDEX idx_author (author_id),
      INDEX idx_hidden (is_hidden)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 存量表迁移：补 cover_file 列（已存在时忽略重复列错误 ER_DUP_FIELDNAME）
  try {
    await pool.query(`ALTER TABLE soups ADD COLUMN cover_file VARCHAR(100) NOT NULL DEFAULT ''`);
  } catch (e) {
    if (e && e.code !== 'ER_DUP_FIELDNAME') throw e;
  }

  // 存量表迁移：补 is_hidden 列（题库仅入库不上架时置 1，列表接口一律过滤）
  try {
    await pool.query(`ALTER TABLE soups ADD COLUMN is_hidden TINYINT NOT NULL DEFAULT 0`);
  } catch (e) {
    if (e && e.code !== 'ER_DUP_FIELDNAME') throw e;
  }

  // AI 陪玩存档：每用户每汤一份（覆盖式），保存后可继续游玩
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_saves (
      id                 VARCHAR(36)  PRIMARY KEY,
      user_id            VARCHAR(36)  NOT NULL,
      soup_id            VARCHAR(36)  NOT NULL,
      soup_title         VARCHAR(200) NOT NULL,
      face               TEXT         NOT NULL,
      bottom             TEXT         NOT NULL,
      type               VARCHAR(10)  NOT NULL DEFAULT '清汤',
      style              VARCHAR(10)  NOT NULL DEFAULT '本格',
      diff_key           VARCHAR(20)  NOT NULL DEFAULT 'easy',
      diff_label         VARCHAR(20)  NOT NULL DEFAULT '简单',
      total_questions    INT          NOT NULL DEFAULT 0,
      remaining_questions INT         NOT NULL DEFAULT 0,
      remaining_seconds  INT          NOT NULL DEFAULT 0,
      elapsed_seconds    INT          NOT NULL DEFAULT 0,
      last_progress      INT          NOT NULL DEFAULT 0,
      history_json       LONGTEXT,
      created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_user_soup (user_id, soup_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 知识库上传台账（RAG 第二层）：一行 = 一次成功入库的文件
  //   md5 唯一键 = 内容指纹去重（参考项目用 md5.text 文件实现，本项目按约定改为入库）
  //   向量本体在 vector-store 的 haigui_kb collection，本表只存可查询的元数据
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_documents (
      id            VARCHAR(36)  PRIMARY KEY,
      filename      VARCHAR(255) NOT NULL,
      md5           CHAR(32)     NOT NULL,
      blocks        INT          NOT NULL DEFAULT 0,
      chunks        INT          NOT NULL DEFAULT 0,
      chars         INT          NOT NULL DEFAULT 0,
      encoding      VARCHAR(30)  NOT NULL DEFAULT '',
      operator_id   VARCHAR(36)  NOT NULL,
      operator_name VARCHAR(50)  NOT NULL,
      created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_md5 (md5),
      INDEX idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  console.log(`✅ 数据库已就绪: ${database}@${DB_CONFIG.host}:${DB_CONFIG.port}`);
}

// ==================== 工具函数 ====================
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/**
 * 读取请求体。
 * @param {number} [maxBytes] 上限，缺省 10MB；管理页批量上传 txt 时放宽到 MAX_KB_BODY
 * @returns {Promise<Buffer>} 原始字节（二进制安全，调用方自行决定编码）
 */
function readBody(req, maxBytes) {
  const limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : MAX_JSON_BODY;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bodyToText(buf) {
  return buf.toString('utf8');
}

/**
 * 二进制安全的 multipart 解析、文件名净化、上传文本编码识别
 * 三者均已抽到 upload-utils.js（可单测），此处仅保留引用。
 * 见文件顶部的 require 与 tests/upload-utils.test.js。
 */

/* ==================== 管理者口令校验辅助 ==================== */

/** 定长比较：先各自 SHA256 再比，避免长度差异带来的信息泄露 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function clientIP(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// 口令失败计数：ip -> { count, firstAt, lockedUntil }
const adminFails = new Map();

function adminLockRemainMs(ip) {
  const r = adminFails.get(ip);
  if (!r || !r.lockedUntil) return 0;
  const remain = r.lockedUntil - Date.now();
  return remain > 0 ? remain : 0;
}

function adminRecordFail(ip) {
  const now = Date.now();
  let r = adminFails.get(ip);
  if (!r || now - r.firstAt > ADMIN_FAIL_WINDOW) r = { count: 0, firstAt: now, lockedUntil: 0 };
  r.count++;
  if (r.count >= ADMIN_MAX_FAILS) r.lockedUntil = r.firstAt + ADMIN_FAIL_WINDOW;
  adminFails.set(ip, r);
}

function adminClearFails(ip) {
  adminFails.delete(ip);
}

/**
 * 校验管理令牌（请求头 X-Admin-Token）。
 * 与用户登录令牌共用同一套 HMAC 签名，但额外要求 payload.role === 'admin'，
 * 因此普通用户的令牌无法访问管理接口。
 * @returns {null|object} 令牌 payload
 */
function requireAdminToken(req) {
  const raw = req.headers['x-admin-token'];
  if (!raw || typeof raw !== 'string') return null;
  const payload = verifyToken(raw);
  if (!payload || payload.role !== 'admin') return null;
  return payload;
}

function parseCookies(req) {
  const cookies = {};
  const raw = req.headers.cookie;
  if (!raw) return cookies;
  raw.split(';').forEach((kv) => {
    const idx = kv.indexOf('=');
    if (idx > 0) cookies[kv.slice(0, idx).trim()] = decodeURIComponent(kv.slice(idx + 1).trim());
  });
  return cookies;
}

function getAuthUser(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return verifyToken(auth.slice(7));
  }
  const cookies = parseCookies(req);
  if (cookies.token) {
    return verifyToken(cookies.token);
  }
  return null;
}

// 数据库未就绪时的兜底提示
function dbNotReady(res) {
  return sendJSON(res, 503, { code: 503, message: '数据库未连接，请稍后重试' });
}

// ==================== 向量库入库（txt 上传 / 汤创建后自动执行） ====================
/**
 * 把一段汤内容切块后写入向量库
 * @param {object} p { soupId, title, face, bottom, source: 'soup'|'upload', filename }
 * @returns 入库条数（失败返回 0，不阻塞主流程）
 */
function ingestSoupContent({ soupId, title, face, bottom, source, filename }) {
  try {
    const base = {
      soupId: soupId || null,
      title: title || '',
      source: source || 'soup',
      filename: filename || '',
    };
    const idBase = `${base.source}:${soupId || filename || 'anon'}`;
    const ids = [];
    const docs = [];
    const metas = [];

    const titleText = (title || '').trim();
    if (titleText) {
      ids.push(`${idBase}:title`);
      docs.push(titleText);
      metas.push({ ...base, kind: 'title' });
    }
    chroma.chunkText(face).forEach((c, i) => {
      ids.push(`${idBase}:face:${i}`);
      docs.push(c);
      metas.push({ ...base, kind: 'face' });
    });
    chroma.chunkText(bottom).forEach((c, i) => {
      ids.push(`${idBase}:bottom:${i}`);
      docs.push(c);
      metas.push({ ...base, kind: 'bottom' });
    });

    if (!docs.length) return 0;
    chroma.add(VECTOR_COLLECTION, { ids, documents: docs, metadatas: metas });
    console.log(`[chroma] 已入向量库 ${docs.length} 条（source=${base.source}）`);
    return docs.length;
  } catch (e) {
    console.error('[chroma] 入库失败:', e.message);
    return 0;
  }
}

// ==================== 路由分发 ====================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  try {
    // 健康检查
    if (method === 'GET' && pathname === '/healthz') {
      const dbOk = pool ? 'ok' : 'down';
      let kbVectors = null;
      try { kbVectors = knowledgeBase.count(); } catch (e) { kbVectors = null; }
      return sendJSON(res, 200, {
        code: 0,
        status: 'ok',
        db: dbOk,
        uptime: process.uptime(),
        kb: { collection: knowledgeBase.KB_COLLECTION, vectors: kbVectors, adminEnabled: !!ADMIN_PASSWORD },
      });
    }

    // 鉴权接口（无需登录）
    if (method === 'POST' && pathname === '/api/register') return await handleRegister(req, res);
    if (method === 'POST' && pathname === '/api/login') return await handleLogin(req, res);
    if (method === 'POST' && pathname === '/api/logout') return handleLogout(res);
    if (method === 'GET' && pathname === '/api/me') return handleMe(req, res);

    // 海龟汤接口（需登录）
    if (pathname.startsWith('/api/soups')) {
      const user = getAuthUser(req);
      if (!user) return sendJSON(res, 401, { code: 401, message: '未登录或登录已过期，请先登录' });
      req.authUser = user;

      if (method === 'GET' && pathname === '/api/soups') return handleListSoups(req, res, url);
      if (method === 'GET' && pathname === '/api/soups/types') return handleGetTypes(req, res);
      if (method === 'POST' && pathname === '/api/soups') return await handleCreateSoup(req, res);
      if (method === 'GET' && /^\/api\/soups\/[\w-]+$/.test(pathname)) {
        return handleGetSoup(req, res, pathname.split('/').pop());
      }
      if (method === 'PUT' && /^\/api\/soups\/[\w-]+$/.test(pathname)) {
        return await handleUpdateSoup(req, res, pathname.split('/').pop());
      }
      if (method === 'DELETE' && /^\/api\/soups\/[\w-]+$/.test(pathname)) {
        return handleDeleteSoup(req, res, pathname.split('/').pop());
      }
    }

    // 封面图上传（需登录；先传图拿文件名，创建/保存汤时再绑定）
    if (method === 'POST' && pathname === '/api/soup-cover') {
      const user = getAuthUser(req);
      if (!user) return sendJSON(res, 401, { code: 401, message: '未登录，请先登录' });
      return await handleCoverUpload(req, res);
    }

    // 封面图读取（公开：文件名为随机 UUID，不可枚举，等同于静态资源）
    if (method === 'GET' && pathname.startsWith('/covers/')) {
      return serveCover(res, pathname);
    }

    // 上传文件接口（需登录）
    if (method === 'POST' && pathname === '/api/upload') {
      const user = getAuthUser(req);
      if (!user) return sendJSON(res, 401, { code: 401, message: '未登录，请先登录' });
      return await handleUpload(req, res);
    }

    // ---------- AI 陪玩接口（需登录） ----------
    if (pathname.startsWith('/api/ai/')) {
      const user = getAuthUser(req);
      if (!user) return sendJSON(res, 401, { code: 401, message: '未登录，请先登录' });
      req.authUser = user; // 存档等接口需要 uid

      // 引擎设置（每用户独立配置大模型 / 离线引擎）
      if (method === 'GET' && pathname === '/api/ai/settings') {
        return await handleAIGetSettings(req, res);
      }
      if (method === 'PUT' && pathname === '/api/ai/settings') {
        return await handleAISaveSettings(req, res);
      }
      if (method === 'POST' && pathname === '/api/ai/settings/test') {
        return await handleAITestSettings(req, res);
      }

      if (method === 'POST' && pathname === '/api/ai/ask') {
        return await handleAIAsk(req, res);
      }
      if (method === 'POST' && pathname === '/api/ai/shorten') {
        return await handleAIShorten(req, res);
      }
      // 陪玩存档（保存进度 / 继续游玩）
      if (method === 'POST' && pathname === '/api/ai/save') {
        return await handleAISave(req, res);
      }
      if (method === 'GET' && pathname === '/api/ai/saves') {
        return await handleAIListSaves(req, res);
      }
      if (method === 'GET' && /^\/api\/ai\/save\/[\w-]+$/.test(pathname)) {
        return await handleAIGetSave(req, res, pathname.split('/').pop());
      }
    }

    // ---------- 管理者接口（需登录 + 管理者口令换取的令牌） ----------
    // 所有 /api/admin/* 的失败响应都带 admin:true 标记，
    // 前端据此区分「登录态过期」与「管理口令失效」，不会把用户踢出登录。
    if (pathname.startsWith('/api/admin/')) {
      const user = getAuthUser(req);
      if (!user) return sendJSON(res, 401, { code: 401, admin: true, message: '未登录，请先登录' });
      req.authUser = user; // 与 /api/ai/ 同样的约定：鉴权后立刻挂上，否则下游读 uid 会抛错

      // 口令校验（换取 2 小时有效的管理令牌），本身不需要管理令牌
      if (method === 'POST' && pathname === '/api/admin/login') {
        return await handleAdminLogin(req, res);
      }

      // 其余接口一律要求管理令牌
      if (!requireAdminToken(req)) {
        return sendJSON(res, 403, { code: 403, admin: true, message: '管理者身份已失效，请重新验证口令' });
      }

      if (method === 'GET' && pathname === '/api/admin/kb/stats') {
        return await handleAdminKbStats(req, res);
      }
      if (method === 'GET' && pathname === '/api/admin/kb/documents') {
        return await handleAdminKbDocuments(req, res, url);
      }
      if (method === 'POST' && pathname === '/api/admin/kb/upload') {
        return await handleAdminKbUpload(req, res);
      }
      if (method === 'POST' && pathname === '/api/admin/kb/search') {
        return await handleAdminKbSearch(req, res);
      }
      if (method === 'POST' && pathname === '/api/admin/kb/reset') {
        return await handleAdminKbReset(req, res);
      }
      if (method === 'DELETE' && /^\/api\/admin\/kb\/documents\/[\w-]+$/.test(pathname)) {
        return await handleAdminKbDeleteDocument(req, res, pathname.split('/').pop());
      }
    }

    // 静态资源
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error('server error:', e);
    return sendJSON(res, 500, { code: 500, message: '服务器内部错误' });
  }
});

// ==================== 用户注册 ====================
async function handleRegister(req, res) {
  if (!pool) return dbNotReady(res);
  const payload = safeJSON(bodyToText(await readBody(req)));
  if (payload === null) return sendJSON(res, 400, { code: 400, message: '请求格式错误' });

  const username = (payload.username || '').trim();
  const password = (payload.password || '');

  if (!username || !password) return sendJSON(res, 400, { code: 400, message: '用户名和密码不能为空' });
  if (username.length < 2 || username.length > 20) return sendJSON(res, 400, { code: 400, message: '用户名长度需在 2~20 个字符之间' });
  if (password.length < 4) return sendJSON(res, 400, { code: 400, message: '密码长度至少 4 位' });

  try {
    const [rows] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
    if (rows.length > 0) return sendJSON(res, 409, { code: 409, message: '该用户名已被注册' });

    const salt = genSalt();
    const id = crypto.randomUUID();
    await pool.query(
      'INSERT INTO users (id, username, salt, password_hash) VALUES (?, ?, ?, ?)',
      [id, username, salt, hashPassword(password, salt)]
    );
    return sendJSON(res, 200, { code: 0, message: '注册成功，请登录' });
  } catch (e) {
    console.error('register error:', e);
    return sendJSON(res, 500, { code: 500, message: '注册失败，请稍后重试' });
  }
}

// ==================== 用户登录 ====================
async function handleLogin(req, res) {
  if (!pool) return dbNotReady(res);
  const payload = safeJSON(bodyToText(await readBody(req)));
  if (payload === null) return sendJSON(res, 400, { code: 400, message: '请求格式错误' });

  const username = (payload.username || '').trim();
  const password = (payload.password || '');

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    const user = rows[0];
    if (!user || hashPassword(password, user.salt) !== user.password_hash) {
      return sendJSON(res, 401, { code: 401, message: '登录失败：用户名或密码错误' });
    }

    const token = signToken({ uid: user.id, username: user.username });
    res.setHeader('Set-Cookie', `token=${token}; HttpOnly; Path=/; Max-Age=${TOKEN_EXPIRE / 1000}; SameSite=Lax`);
    return sendJSON(res, 200, { code: 0, message: '登录成功', data: { token, username: user.username } });
  } catch (e) {
    console.error('login error:', e);
    return sendJSON(res, 500, { code: 500, message: '登录失败，请稍后重试' });
  }
}

function handleLogout(res) {
  res.setHeader('Set-Cookie', `token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  return sendJSON(res, 200, { code: 0, message: '已退出登录' });
}

function handleMe(req, res) {
  const user = getAuthUser(req);
  if (!user) return sendJSON(res, 401, { code: 401, message: '未登录' });
  return sendJSON(res, 200, { code: 0, data: { uid: user.uid, username: user.username } });
}

// ==================== 海龟汤 CRUD ====================
// 全局共享：不按用户过滤，所有登录用户看到同一份全量数据
// 分页：带 page/pageSize 参数时返回分页结果；不带参数时返回全量（兼容 AI 选汤页）
async function handleListSoups(req, res, url) {
  if (!pool) return dbNotReady(res);
  try {
    const qs = url && url.searchParams ? url.searchParams : new URLSearchParams();
    const hasPaging = qs.has('pageSize');
    let page = Math.max(1, parseInt(qs.get('page'), 10) || 1);
    const pageSize = hasPaging
      ? Math.min(50, Math.max(1, parseInt(qs.get('pageSize'), 10) || 10))
      : null;

    // 隐藏题（is_hidden = 1，例如批量导入的储备题库）不进任何列表。
    // 汤库页与 AI 选汤页共用本接口（带 pageSize = 汤库分页，不带 = AI 选汤全量），
    // 所以在这里过滤一处，两个页面都不会展示隐藏题。
    const selectFields =
      'SELECT id, title, face, type, style, difficulty, author_id, author_name, cover_file, created_at FROM soups WHERE is_hidden = 0';
    const orderClause = ' ORDER BY created_at DESC, id DESC';

    let rows;
    let total = 0;
    let totalPages = 1;
    if (hasPaging) {
      const [countRows] = await pool.query('SELECT COUNT(*) AS c FROM soups WHERE is_hidden = 0');
      total = Number(countRows[0].c) || 0;
      totalPages = Math.max(1, Math.ceil(total / pageSize));
      page = Math.min(page, totalPages);
      const [pageRows] = await pool.query(
        `${selectFields}${orderClause} LIMIT ? OFFSET ?`,
        [pageSize, (page - 1) * pageSize]
      );
      rows = pageRows;
    } else {
      const [allRows] = await pool.query(`${selectFields}${orderClause}`);
      rows = allRows;
      total = rows.length;
    }

    const list = rows.map((r) => ({
      id: r.id,
      title: r.title,
      face: r.face,
      type: r.type,
      style: r.style,
      difficulty: r.difficulty,
      authorId: r.author_id,
      author: r.author_name,
      coverUrl: coverUrlOf(r.cover_file),
      createdAt: r.created_at,
    }));
    return sendJSON(res, 200, {
      code: 0,
      data: { list, total, page: hasPaging ? page : 1, pageSize: hasPaging ? pageSize : total, totalPages },
    });
  } catch (e) {
    console.error('list error:', e);
    return sendJSON(res, 500, { code: 500, message: '查询失败' });
  }
}

function handleGetTypes(req, res) {
  return sendJSON(res, 200, { code: 0, data: { types: ['清汤', '红汤'], styles: ['本格', '变格'] } });
}

async function handleCreateSoup(req, res) {
  if (!pool) return dbNotReady(res);
  const payload = safeJSON(bodyToText(await readBody(req)));
  if (payload === null) return sendJSON(res, 400, { code: 400, message: '请求格式错误' });

  const title = (payload.title || '').trim();
  const face = (payload.face || '').trim();
  const bottom = (payload.bottom || '').trim();
  const type = payload.type || '清汤';
  const style = payload.style || '本格';
  const difficulty = Number(payload.difficulty) || 1;

  if (!title) return sendJSON(res, 400, { code: 400, message: '请填写汤名' });
  if (!face) return sendJSON(res, 400, { code: 400, message: '请填写汤面（谜面）' });
  if (!bottom) return sendJSON(res, 400, { code: 400, message: '请填写汤底（答案）' });
  if (!['清汤', '红汤'].includes(type)) return sendJSON(res, 400, { code: 400, message: '类型不正确' });
  if (!['本格', '变格'].includes(style)) return sendJSON(res, 400, { code: 400, message: '风格不正确' });
  if (difficulty < 1 || difficulty > 5) return sendJSON(res, 400, { code: 400, message: '难度需在 1~5 星之间' });

  // 封面绑定（可选）：必须是由 /api/soup-cover 上传生成的合法文件名，且文件真实存在
  let coverFile = '';
  if (payload.coverFile) {
    if (typeof payload.coverFile !== 'string' || !COVER_FILE_RE.test(payload.coverFile)) {
      return sendJSON(res, 400, { code: 400, message: '封面文件无效，请重新上传' });
    }
    if (!fs.existsSync(path.join(COVER_DIR, payload.coverFile))) {
      return sendJSON(res, 400, { code: 400, message: '封面文件不存在，请重新上传' });
    }
    coverFile = payload.coverFile;
  }

  const id = crypto.randomUUID();
  try {
    await pool.query(
      `INSERT INTO soups (id, title, face, bottom, type, style, difficulty, author_id, author_name, cover_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, title, face, bottom, type, style, difficulty, req.authUser.uid, req.authUser.username, coverFile]
    );
    // 汤入库的同时自动入向量库
    ingestSoupContent({ soupId: id, title, face, bottom, source: 'soup' });
    return sendJSON(res, 200, { code: 0, message: '添加成功', data: { id } });
  } catch (e) {
    console.error('create error:', e);
    return sendJSON(res, 500, { code: 500, message: '添加失败' });
  }
}

async function handleGetSoup(req, res, id) {
  if (!pool) return dbNotReady(res);
  try {
    const [rows] = await pool.query(
      `SELECT id, title, face, bottom, type, style, difficulty, author_id, author_name, cover_file, is_hidden, created_at
       FROM soups WHERE id = ?`,
      [id]
    );
    const s = rows[0];
    if (!s) return sendJSON(res, 404, { code: 404, message: '未找到该海龟汤' });
    // 隐藏题只对作者本人可见：列表已过滤，这里再挡一道，防止有人直接拼 id 访问未上架的题
    if (Number(s.is_hidden) === 1 && s.author_id !== (req.authUser && req.authUser.uid)) {
      return sendJSON(res, 404, { code: 404, message: '未找到该海龟汤' });
    }
    return sendJSON(res, 200, {
      code: 0,
      data: {
        id: s.id,
        title: s.title,
        face: s.face,
        bottom: s.bottom,
        type: s.type,
        style: s.style,
        difficulty: s.difficulty,
        authorId: s.author_id,
        author: s.author_name,
        coverUrl: coverUrlOf(s.cover_file),
        createdAt: s.created_at,
      },
    });
  } catch (e) {
    console.error('get error:', e);
    return sendJSON(res, 500, { code: 500, message: '查询失败' });
  }
}

async function handleDeleteSoup(req, res, id) {
  if (!pool) return dbNotReady(res);
  try {
    const [rows] = await pool.query('SELECT author_id FROM soups WHERE id = ?', [id]);
    if (rows.length === 0) return sendJSON(res, 404, { code: 404, message: '未找到该海龟汤' });
    // 仅创建者本人可删除
    if (rows[0].author_id !== req.authUser.uid) {
      return sendJSON(res, 403, { code: 403, message: '只能删除自己添加的海龟汤' });
    }
    await pool.query('DELETE FROM soups WHERE id = ?', [id]);
    // 顺手清理封面文件（删除失败不影响主流程）
    removeCoverFile(rows[0].cover_file);
    return sendJSON(res, 200, { code: 0, message: '删除成功' });
  } catch (e) {
    console.error('delete error:', e);
    return sendJSON(res, 500, { code: 500, message: '删除失败' });
  }
}

async function handleUpdateSoup(req, res, id) {
  if (!pool) return dbNotReady(res);
  const payload = safeJSON(bodyToText(await readBody(req)));
  if (payload === null) return sendJSON(res, 400, { code: 400, message: '请求格式错误' });

  const title = (payload.title || '').trim();
  const face = (payload.face || '').trim();
  const bottom = (payload.bottom || '').trim();
  const type = payload.type || '清汤';
  const style = payload.style || '本格';
  const difficulty = Number(payload.difficulty) || 1;

  if (!title) return sendJSON(res, 400, { code: 400, message: '请填写汤名' });
  if (!face) return sendJSON(res, 400, { code: 400, message: '请填写汤面（谜面）' });
  if (!bottom) return sendJSON(res, 400, { code: 400, message: '请填写汤底（答案）' });
  if (!['清汤', '红汤'].includes(type)) return sendJSON(res, 400, { code: 400, message: '类型不正确' });
  if (!['本格', '变格'].includes(style)) return sendJSON(res, 400, { code: 400, message: '风格不正确' });
  if (difficulty < 1 || difficulty > 5) return sendJSON(res, 400, { code: 400, message: '难度需在 1~5 星之间' });

  try {
    const [rows] = await pool.query('SELECT author_id, cover_file FROM soups WHERE id = ?', [id]);
    if (rows.length === 0) return sendJSON(res, 404, { code: 404, message: '未找到该海龟汤' });
    // 仅创建者本人可修改
    if (rows[0].author_id !== req.authUser.uid) {
      return sendJSON(res, 403, { code: 403, message: '只能修改自己添加的海龟汤' });
    }

    // 封面变更：换图 / 移除时清理旧文件，新文件名必须合法且真实存在
    const oldCover = rows[0].cover_file || '';
    let coverFile = oldCover;
    if (payload.coverClear === true) {
      coverFile = '';
    } else if (typeof payload.coverFile === 'string' && payload.coverFile && payload.coverFile !== oldCover) {
      if (!COVER_FILE_RE.test(payload.coverFile)) {
        return sendJSON(res, 400, { code: 400, message: '封面文件无效，请重新上传' });
      }
      if (!fs.existsSync(path.join(COVER_DIR, payload.coverFile))) {
        return sendJSON(res, 400, { code: 400, message: '封面文件不存在，请重新上传' });
      }
      coverFile = payload.coverFile;
    }

    await pool.query(
      `UPDATE soups SET title = ?, face = ?, bottom = ?, type = ?, style = ?, difficulty = ?, cover_file = ?
       WHERE id = ?`,
      [title, face, bottom, type, style, difficulty, coverFile, id]
    );
    // 封面换了才删旧文件（内容未变时不重复清理）
    if (coverFile !== oldCover) removeCoverFile(oldCover);
    // 汤内容变更：先清掉旧向量再重新入库
    chroma.deleteWhere(VECTOR_COLLECTION, (meta) => meta && meta.soupId === id);
    ingestSoupContent({ soupId: id, title, face, bottom, source: 'soup' });
    return sendJSON(res, 200, { code: 0, message: '保存成功' });
  } catch (e) {
    console.error('update error:', e);
    return sendJSON(res, 500, { code: 500, message: '保存失败' });
  }
}

// ==================== txt 文件上传（解析为汤面+汤底） ====================
async function handleUpload(req, res) {
  const contentType = req.headers['content-type'] || '';
  const boundary = parseBoundary(contentType);
  if (!contentType.includes('multipart/form-data') || !boundary) {
    return sendJSON(res, 400, { code: 400, message: '请以 multipart/form-data 上传文件' });
  }

  // 二进制安全解析：旧实现先把整个请求体 toString('utf8') 再按 boundary 切字符串，
  // GBK 编码的 txt 会在这一步被解成乱码（解出来再切，边界也会被污染）
  const buf = await readBody(req);
  const filePart = parseMultipart(buf, boundary).find((p) => p.filename);
  if (!filePart) return sendJSON(res, 400, { code: 400, message: '未检测到文件内容' });

  const filename = sanitizeFilename(filePart.filename);
  const ext = path.extname(filename).toLowerCase();
  if (ext !== '.txt') return sendJSON(res, 400, { code: 400, message: '仅支持 .txt 格式的文件' });

  // 编码识别（UTF-8 / UTF-8 BOM / GBK），避免 Windows 记事本「ANSI」txt 整篇乱码
  const decoded = decodeTextBuffer(filePart.body);

  // 保存原始文件：直接落原始字节，不做编码转换，便于事后追溯
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, `${crypto.randomUUID()}${ext}`), filePart.body);

  // 解析文本
  const content = knowledgeBase.normalizeText(decoded.text);
  let face = content;
  let bottom = '';
  let title = '';

  const sepPattern = /(?:^|\n)(?:汤底|答案|谜底)\s*[:：]?\s*\n|(?:^|\n)={3,}\s*\n|(?:^|\n)-{3,}\s*\n/;
  const sepMatch = content.match(sepPattern);
  if (sepMatch) {
    const idx = content.indexOf(sepMatch[0]);
    face = content.slice(0, idx).trim();
    bottom = content.slice(idx + sepMatch[0].length).trim();
  }

  const lines = face.split('\n').filter((l) => l.trim());
  if (lines.length > 0 && lines[0].trim().length <= 30) {
    title = lines[0].trim();
    face = lines.slice(1).join('\n').trim();
  }
  face = face.replace(/^(汤面|谜面)\s*[:：]\s*/i, '').trim();

  return sendJSON(res, 200, {
    code: 0,
    message: '上传成功，已解析',
    data: { title, face, bottom, filename, encoding: decoded.encoding },
  });
}

// ==================== 封面图上传（原始字节流，魔数校验） ====================
async function handleCoverUpload(req, res) {
  try {
    const buf = await readBody(req); // 上限 10MB，由 readBody 兜底
    if (!buf || buf.length === 0) return sendJSON(res, 400, { code: 400, message: '未检测到图片内容' });
    if (buf.length > 5 * 1024 * 1024) return sendJSON(res, 413, { code: 413, message: '封面图片不能超过 5MB' });

    const ext = detectImageExt(buf);
    if (!ext) return sendJSON(res, 400, { code: 400, message: '仅支持 jpg / png / webp 格式的图片' });

    const file = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(COVER_DIR, file), buf);
    return sendJSON(res, 200, { code: 0, message: '封面上传成功', data: { file, url: coverUrlOf(file) } });
  } catch (e) {
    console.error('cover upload error:', e);
    return sendJSON(res, 500, { code: 500, message: '封面上传失败，请稍后重试' });
  }
}

// ==================== 封面图读取（公开，文件名随机不可枚举） ====================
function serveCover(res, pathname) {
  const file = decodeURIComponent(pathname.slice('/covers/'.length));
  if (!COVER_FILE_RE.test(file)) return sendJSON(res, 400, { code: 400, message: '非法的封面地址' });
  const fullPath = path.join(COVER_DIR, file);
  if (!fullPath.startsWith(COVER_DIR)) return sendJSON(res, 403, { code: 403, message: '禁止访问' });
  fs.readFile(fullPath, (err, data) => {
    if (err) return sendJSON(res, 404, { code: 404, message: '封面不存在' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable', // 文件名唯一，可永久缓存
    });
    res.end(data);
  });
}

// ==================== 工具：安全 JSON 解析 ====================
function safeJSON(str) {
  try {
    return JSON.parse(str || '{}');
  } catch (e) {
    return null;
  }
}

// ==================== 静态资源服务 ====================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(__dirname, 'public', filePath);

  if (!fullPath.startsWith(path.join(__dirname, 'public'))) {
    return sendJSON(res, 403, { code: 403, message: '禁止访问' });
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, html) => {
        if (err2) return sendJSON(res, 404, { code: 404, message: 'Not Found' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // 页面与前端脚本要求即时生效（改完刷新即见），不做启发式缓存
      'Cache-Control': ['.html', '.css', '.js', '.json'].includes(ext) ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

// ==================== AI 陪玩 ====================
// 调用用户指定的 OpenAI 兼容 LLM（用户提供 base url + api key）
// 职责：扮演汤主回答问题（只答是/否/无关紧要/是或不是），并评估推理进度

// 调用 OpenAI 兼容的 Chat Completions 接口
// opts: { temperature, maxTokens, timeoutMs } — 进度智能体等调用方可用小参数，缺省与原逻辑一致
async function callLLM(baseUrl, apiKey, model, messages, opts) {
  const temperature = opts && typeof opts.temperature === 'number' ? opts.temperature : 0.3;
  const maxTokens = opts && opts.maxTokens ? opts.maxTokens : 500;
  const timeoutMs = opts && opts.timeoutMs ? opts.timeoutMs : 60000;

  let url = baseUrl.trim();
  // 去掉末尾斜杠
  url = url.replace(/\/+$/, '');
  // 若用户给的是完整 chat/completions 路径则直接用，否则拼接
  if (!/\/chat\/completions$/.test(url)) {
    if (/\/v1$/.test(url)) {
      url = url + '/chat/completions';
    } else {
      url = url + '/v1/chat/completions';
    }
  }

  const body = JSON.stringify({
    model: model || 'gpt-4o-mini',
    messages,
    temperature,
    max_tokens: maxTokens,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey.trim(),
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('AI 接口返回错误 ' + res.status + (text ? '：' + text.slice(0, 200) : ''));
    }
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    return String(content || '').trim();
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('AI 请求超时，请稍后重试');
    throw e;
  }
}

// 构建汤主系统提示词
function buildHostPrompt(face, bottom) {
  return `你正在主持一场「海龟汤」情境推理游戏，你是出题人（汤主）。

【汤面】（你只向玩家公布这段事件摘要）：
${face}

【汤底】（这是完整的故事真相，只有你知道，绝不能直接告诉玩家）：
${bottom}

【你的职责】
玩家会通过「是/否」封闭式提问来逐步还原事件真相。你需要根据汤底，对玩家的问题做出判断并回答。

【回答规范——只能从以下四种中选择一种，严格执行】
- 回答「是」：玩家的说法符合汤底事实
- 回答「否」：玩家的说法与汤底事实相反
- 回答「无关紧要」：该信息不影响故事主线，知不知道都不影响推出汤底
- 回答「是或不是」：问题半对半错，一部分成立一部分不成立

【严格禁止】
- 禁止直接说出汤底、人物动机、关键事件、结局的直接原因
- 禁止主动提示线索、禁止补充解释、禁止长篇回答
- 只回答上面四种中的一种，不要展开任何额外说明
- 玩家问开放式问题（如"为什么""他是谁"等）时，不要回答具体内容，引导玩家改成是/否问题，或者回答「无关紧要」

【输出格式】
你必须严格输出如下 JSON（不要输出 JSON 以外的任何文字、不要用代码块包裹）：
{"answer":"是/否/无关紧要/是或不是 四选一","progress":0到100的整数}

其中 progress 是你对玩家当前已还原真相程度的评估（0 表示毫无头绪，100 表示完整还原了人物、核心动机、关键触发事件、结局直接原因）。progress 根据玩家累计的提问内容综合判断。`;
}

// 玩家累计对话转 messages
function buildMessages(history) {
  const messages = [];
  for (const turn of history) {
    messages.push({ role: 'user', content: turn.question });
    messages.push({ role: 'assistant', content: turn.answer });
  }
  return messages;
}

// ==================== 推理进度智能体 ====================
// 独立的轻量 Agent：职责单一——根据玩家累计问答，实时评估推理还原进度（0~100）。
// 与汤主回答完全解耦（原回答逻辑不变）；失败自动降级链：
//   智能体评估 → 汤主回答自带的 progress → 本地启发式估算 → 前端保留上一次进度
// 解析与本地估算的纯函数实现见 progress-utils.js

async function runProgressAgent(baseUrl, apiKey, model, face, bottom, history) {
  const convo = history
    .slice(-20) // 控制上下文长度，最近的 20 轮问答足以评估
    .map((t, i) => `${i + 1}. 玩家问：${t.question}\n   汤主答：${t.answer}`)
    .join('\n');

  const messages = [
    {
      role: 'system',
      content: `你是「海龟汤」游戏的推理进度评估智能体。你的唯一职责：根据玩家的全部问答记录，评估玩家对汤底真相的还原程度，输出 0~100 的整数进度。

【评估检查表】逐项判断玩家是否已通过提问获得确定性确认：
1. 核心人物 / 对象的身份
2. 关键动机
3. 关键事件的经过
4. 结局的直接原因
5. 决定性的转折点

【评分规则】
- 玩家每获得一个与主线相关的「是」确认，进度至少前进 8~12 分，禁止在已有相关确认时输出 0
- 毫无头绪：0~15
- 仅触及表面事实：16~25
- 已确认 1 个关键点：26~50
- 已确认 2~3 个关键点：51~75
- 已确认 4 个以上关键点：76~90
- 关键点基本全部确认，只差完整还原：91~100
- 只统计玩家从回答中获得的确定性信息，不要因提问次数多而虚高
- 玩家得到「否 / 无关紧要」的回答同样排除了错误方向，可小幅加分

【输出格式】直接输出 JSON（尽量简短，确保完整）：{"progress": 整数}，禁止输出任何其他文字或代码块`,
    },
    {
      role: 'user',
      content: `【汤面】\n${face}\n\n【汤底】\n${bottom}\n\n【玩家问答记录（最新在最后）】\n${convo || '（暂无问答）'}\n\n只输出：{"progress": 数字}`,
    },
  ];

  // 失败重试 1 次，再失败返回 null（由调用方降级）
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await callLLM(baseUrl, apiKey, model, messages, {
        temperature: 0.2,
        maxTokens: 500,   // 此前 120 会把回复截断成残缺 JSON，导致解析必然失败
        timeoutMs: 45000,
      });
      const p = parseProgressFromText(raw);
      if (p !== null) return p;
      console.error(`progress agent: attempt ${attempt} 无法从回复中解析进度，原文片段: ${String(raw).slice(0, 120)}`);
    } catch (e) {
      console.error(`progress agent error (attempt ${attempt}):`, e.message);
    }
  }
  return null;
}

async function handleAIAsk(req, res) {
  const payload = safeJSON(bodyToText(await readBody(req)));
  if (payload === null) return sendJSON(res, 400, { code: 400, message: '请求格式错误' });

  const { face, bottom, history } = payload;
  const soupId = payload.soupId || null; // 当前游玩的汤 id，用于检索时优先本汤内容
  const question = (payload.question || '').trim();
  if (!face || !bottom) {
    return sendJSON(res, 400, { code: 400, message: '缺少汤面或汤底' });
  }
  if (!question) {
    return sendJSON(res, 400, { code: 400, message: '问题不能为空' });
  }

  // —— 引擎选择：优先读服务端每用户设置；前端仍可传 baseUrl/apiKey 作为兜底 ——
  // 1) 服务端 user_settings 里开启了 llm 且有完整配置 → 用大模型
  // 2) 否则用 payload 里带的大模型配置（兼容旧前端 / 未配置设置页时）
  // 3) 都没有 → 离线引擎
  let llmCfg = null;
  try {
    const [rows] = await pool.query(
      'SELECT llm_enabled, llm_base_url, llm_model, llm_api_key FROM user_settings WHERE user_id = ?',
      [req.authUser.uid]
    );
    const s = rows[0];
    if (s && s.llm_enabled && s.llm_base_url && s.llm_api_key) {
      llmCfg = { baseUrl: s.llm_base_url, apiKey: s.llm_api_key, model: s.llm_model || '' };
    }
  } catch (e) {
    console.error('read user_settings error:', e.message);
  }
  if (!llmCfg) {
    // 兜底：前端传的配置
    if (payload.baseUrl && payload.apiKey) {
      llmCfg = { baseUrl: payload.baseUrl, apiKey: payload.apiKey, model: payload.model || '' };
    }
  }

  const baseUrl = llmCfg ? llmCfg.baseUrl : '';
  const apiKey = llmCfg ? llmCfg.apiKey : '';
  const model = llmCfg ? llmCfg.model : '';

  // 上一轮进度（离线引擎需要，用于进度单调递增）
  let prevProgress = 0;
  try {
    prevProgress = Number(payload.lastProgress) || 0;
  } catch (e) { prevProgress = 0; }
  const fullHistory = (Array.isArray(history) ? history : []).concat([{ question, answer: '是' }]);

  // —— 题目分类字段（style / type）：离线引擎回答「这是本格吗」「是红汤吗」时必须用到 ——
  // 前端会带上；缺失时（旧存档 / 兼容前端）按 soupId 回查题库兜底
  let soupMeta = {
    style: payload.style || null,
    type: payload.type || null,
  };
  if ((!soupMeta.style || !soupMeta.type) && soupId) {
    try {
      const [rows] = await pool.query('SELECT style, type FROM soups WHERE id = ? LIMIT 1', [soupId]);
      if (rows[0]) {
        soupMeta.style = soupMeta.style || rows[0].style;
        soupMeta.type = soupMeta.type || rows[0].type;
      }
    } catch (e) {
      console.error('read soup meta error:', e.message); // 读不到就靠文本推断兜底，不影响主流程
    }
  }

  // —— 路径 A：离线引擎（未配大模型，或大模型失败时回退到这里）——
  if (!llmCfg) {
    try {
      const r = offlineEngine.offlineJudge(face, bottom, question, prevProgress, soupMeta);
      return sendJSON(res, 200, {
        code: 0,
        data: {
          answer: r.answer,
          progress: r.progress,
          engine: 'offline',
          agentProgress: null,
          raw: '',
        },
      });
    } catch (e) {
      console.error('offline engine error:', e.message);
      return sendJSON(res, 500, { code: 500, message: '离线引擎异常' });
    }
  }

  // —— 路径 B：大模型引擎（失败回退离线）——
  try {
    // —— 向量相似检索：用玩家问题在向量库中召回语义最相关的文本片段 ——
    // 检索失败不影响主流程（降级为无检索参考，原回答逻辑兜底）
    let contextBlock = '';
    try {
      const hits = chroma.query(VECTOR_COLLECTION, { queryText: question, n: 8 });
      if (hits.length) {
        // 当前这碗汤的片段优先，其次按相似度
        hits.sort((a, b) => {
          const am = a.meta && a.meta.soupId && a.meta.soupId === soupId ? 1 : 0;
          const bm = b.meta && b.meta.soupId && b.meta.soupId === soupId ? 1 : 0;
          if (am !== bm) return bm - am;
          return b.score - a.score;
        });
        const seen = new Set();
        const picked = [];
        for (const h of hits) {
          const key = String(h.text).slice(0, 60);
          if (seen.has(key)) continue;
          seen.add(key);
          picked.push(h);
          if (picked.length >= 4) break;
        }
        const kindMap = { title: '汤名', face: '汤面', bottom: '汤底' };
        const lines = picked
          .filter((h) => h.score > 0.12) // 过滤弱相关的召回（实测强相关 >0.3，不相关 <0.1）
          .map((h, i) => {
            const kind = h.meta && h.meta.kind ? kindMap[h.meta.kind] || '片段' : '片段';
            return `${i + 1}. [${kind}] ${h.text}`;
          });
        if (lines.length) {
          contextBlock =
            '\n\n【向量库检索参考】（以下是从海龟汤知识库中按语义相似度召回的片段，供你判断玩家问题时对照事实使用，不得直接照读给玩家）：\n' +
            lines.join('\n');
        }
      }
    } catch (e) {
      console.error('vector retrieval error:', e.message);
    }

    // —— 知识库检索（管理者上传的汤面 / 汤底 / 推理逻辑，全站共享）——
    // 与上面的题库检索相互独立：知识库为空或检索异常都不影响主流程。
    // 因为检索与注入都发生在服务端，用户各自配置的大模型自动共享同一份知识库，用户侧零配置。
    let kbBlock = '';
    try {
      const kbHits = knowledgeBase.search(question, { n: knowledgeBase.DEFAULT_TOP_K });
      if (kbHits.length) {
        kbBlock = knowledgeBase.buildContextBlock(kbHits, '海龟汤知识库参考');
        console.log(`[kb] 命中 ${kbHits.length} 条，最高分 ${kbHits[0].score.toFixed(3)}`);
      }
    } catch (e) {
      console.error('knowledge base retrieval error:', e.message);
    }

    // —— 汤主回答（原逻辑不变，仅追加了检索参考上下文）——
    const sysPrompt = buildHostPrompt(face, bottom) + contextBlock + kbBlock;
    const messages = [
      { role: 'system', content: sysPrompt },
      ...buildMessages(Array.isArray(history) ? history : []),
      { role: 'user', content: question },
    ];

    const raw = await callLLM(baseUrl, apiKey, model, messages);

    // 解析 AI 返回的 JSON
    let parsed = null;
    try {
      // 去除可能的代码块包裹
      let cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) cleaned = match[0];
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // 解析失败：退回保守处理，answer 取原文，progress 给 -1 表示未知
    }

    let answer = parsed && parsed.answer ? String(parsed.answer) : '无关紧要';
    let progress = parsed && typeof parsed.progress === 'number' ? parsed.progress : -1;

    // 规范化 answer
    if (!['是', '否', '无关紧要', '是或不是'].includes(answer)) {
      if (/是或不是|半对|部分/.test(answer)) answer = '是或不是';
      else if (/无关|不重要|无关紧要/.test(answer)) answer = '无关紧要';
      else if (/^否/.test(answer)) answer = '否';
      else answer = '是';
    }
    if (progress < 0 || progress > 100) progress = -1;

    // —— 推理进度智能体：独立实时评估（汤主回答逻辑不受影响）——
    let agentProgress = null;
    try {
      const h2 = (Array.isArray(history) ? history : []).concat([{ question, answer }]);
      agentProgress = await runProgressAgent(baseUrl, apiKey, model, face, bottom, h2);
    } catch (e) {
      agentProgress = null;
    }

    // 三级进度来源取最大值：进度代表"已还原的信息量"，已确认的事实不会消失，因此单调不减。
    // 智能体评估（最准）> 汤主自带评估 > 本地启发式估算（保证进度条永远会动）
    const candidates = [estimateProgressLocally((Array.isArray(history) ? history : []).concat([{ question, answer }]))];
    if (agentProgress !== null) candidates.push(agentProgress);
    if (progress >= 0 && progress <= 100) candidates.push(progress); // 汤主自带的
    progress = Math.max(...candidates);
    if (progress < 0 || progress > 100) progress = -1;

    return sendJSON(res, 200, {
      code: 0,
      data: { answer, progress, engine: 'llm', agentProgress, raw },
    });
  } catch (e) {
    // 大模型失败 → 回退离线引擎（不影响游戏）
    console.error('llm ask error, fallback to offline:', e.message);
    try {
      const r = offlineEngine.offlineJudge(face, bottom, question, prevProgress, soupMeta);
      return sendJSON(res, 200, {
        code: 0,
        data: { answer: r.answer, progress: r.progress, engine: 'offline', agentProgress: null, raw: '', fallback: true },
      });
    } catch (e2) {
      console.error('offline fallback error:', e2.message);
      return sendJSON(res, 502, { code: 502, message: 'AI 调用失败：' + e.message });
    }
  }
}

// ==================== 陪玩引擎设置（每用户） ====================
async function handleAIGetSettings(req, res) {
  if (!pool) return dbNotReady(res);
  try {
    const [rows] = await pool.query(
      'SELECT llm_enabled, llm_base_url, llm_model, llm_api_key FROM user_settings WHERE user_id = ?',
      [req.authUser.uid]
    );
    const s = rows[0] || { llm_enabled: 0, llm_base_url: '', llm_model: '', llm_api_key: '' };
    return sendJSON(res, 200, {
      code: 0,
      data: {
        settings: {
          enabled: !!s.llm_enabled,
          llmBaseUrl: s.llm_base_url || '',
          llmModel: s.llm_model || '',
          llmApiKey: s.llm_api_key || '',
          hasKey: !!s.llm_api_key,
        },
      },
    });
  } catch (e) {
    console.error('get settings error:', e);
    return sendJSON(res, 500, { code: 500, message: '读取设置失败' });
  }
}

async function handleAISaveSettings(req, res) {
  if (!pool) return dbNotReady(res);
  const payload = safeJSON(bodyToText(await readBody(req)));
  if (payload === null) return sendJSON(res, 400, { code: 400, message: '请求格式错误' });
  const enabled = payload.enabled ? 1 : 0;
  const llmBaseUrl = String(payload.llmBaseUrl || '').trim().slice(0, 300);
  const llmModel = String(payload.llmModel || '').trim().slice(0, 100);
  const llmApiKey = String(payload.llmApiKey || '').trim().slice(0, 300);

  if (enabled && (!llmBaseUrl || !llmApiKey)) {
    return sendJSON(res, 400, { code: 400, message: '开启大模型主持需填写接口地址和 API Key' });
  }

  try {
    await pool.query(
      `INSERT INTO user_settings (user_id, llm_enabled, llm_base_url, llm_model, llm_api_key)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         llm_enabled = VALUES(llm_enabled), llm_base_url = VALUES(llm_base_url),
         llm_model = VALUES(llm_model), llm_api_key = VALUES(llm_api_key)`,
      [req.authUser.uid, enabled, llmBaseUrl, llmModel, llmApiKey]
    );
    return sendJSON(res, 200, { code: 0, message: '设置已保存' });
  } catch (e) {
    console.error('save settings error:', e);
    return sendJSON(res, 500, { code: 500, message: '保存设置失败' });
  }
}

// 测试大模型连接：用最小请求验证 baseUrl + key + model 是否可用
async function handleAITestSettings(req, res) {
  const payload = safeJSON(bodyToText(await readBody(req)));
  if (payload === null) return sendJSON(res, 400, { code: 400, message: '请求格式错误' });
  const baseUrl = String(payload.llmBaseUrl || '').trim();
  const apiKey = String(payload.llmApiKey || '').trim();
  const model = String(payload.llmModel || '').trim();
  if (!baseUrl || !apiKey) return sendJSON(res, 400, { code: 400, message: '缺少接口地址或 API Key' });
  try {
    const reply = await callLLM(baseUrl, apiKey, model, [
      { role: 'user', content: '请只回复「ok」两个字。' },
    ], { temperature: 0, maxTokens: 10, timeoutMs: 20000 });
    return sendJSON(res, 200, { code: 0, message: '连接成功', data: { reply: String(reply || '').slice(0, 20) } });
  } catch (e) {
    console.error('test settings error:', e.message);
    return sendJSON(res, 502, { code: 502, message: '连接失败：' + e.message });
  }
}

// ==================== AI 陪玩存档（保存进度 / 继续游玩） ====================
// 每用户每汤一份存档（覆盖式 upsert），保存聊天记录、推理进度、用时、剩余次数
async function handleAISave(req, res) {
  if (!pool) return dbNotReady(res);
  const payload = safeJSON(bodyToText(await readBody(req)));
  if (payload === null) return sendJSON(res, 400, { code: 400, message: '请求格式错误' });

  const soupId = (payload.soupId || '').trim();
  const face = (payload.face || '');
  const bottom = (payload.bottom || '');
  if (!soupId) return sendJSON(res, 400, { code: 400, message: '缺少汤 ID' });
  if (!face || !bottom) return sendJSON(res, 400, { code: 400, message: '存档缺少汤面或汤底' });

  const history = Array.isArray(payload.history) ? payload.history : [];
  const row = {
    id: crypto.randomUUID(),
    user_id: req.authUser.uid,
    soup_id: soupId,
    soup_title: String(payload.soupTitle || '未命名海龟汤').slice(0, 200),
    face,
    bottom,
    type: ['清汤', '红汤'].includes(payload.type) ? payload.type : '清汤',
    style: ['本格', '变格'].includes(payload.style) ? payload.style : '本格',
    diff_key: String(payload.diffKey || 'easy').slice(0, 20),
    diff_label: String(payload.diffLabel || '简单').slice(0, 20),
    total_questions: Number(payload.totalQuestions) || 0,
    remaining_questions: Number(payload.remainingQuestions) || 0,
    remaining_seconds: Math.max(0, Number(payload.remainingSeconds) || 0),
    elapsed_seconds: Math.max(0, Number(payload.elapsedSeconds) || 0),
    last_progress: Math.min(100, Math.max(0, Number(payload.lastProgress) || 0)),
    history_json: JSON.stringify(history).slice(0, 4 * 1024 * 1024), // 上限 4MB
  };

  try {
    await pool.query(
      `INSERT INTO game_saves
        (id, user_id, soup_id, soup_title, face, bottom, type, style, diff_key, diff_label,
         total_questions, remaining_questions, remaining_seconds, elapsed_seconds, last_progress, history_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         soup_title = VALUES(soup_title), face = VALUES(face), bottom = VALUES(bottom),
         type = VALUES(type), style = VALUES(style), diff_key = VALUES(diff_key),
         diff_label = VALUES(diff_label), total_questions = VALUES(total_questions),
         remaining_questions = VALUES(remaining_questions), remaining_seconds = VALUES(remaining_seconds),
         elapsed_seconds = VALUES(elapsed_seconds), last_progress = VALUES(last_progress),
         history_json = VALUES(history_json)`,
      [row.id, row.user_id, row.soup_id, row.soup_title, row.face, row.bottom, row.type, row.style,
       row.diff_key, row.diff_label, row.total_questions, row.remaining_questions,
       row.remaining_seconds, row.elapsed_seconds, row.last_progress, row.history_json]
    );
    return sendJSON(res, 200, { code: 0, message: '进度已保存', data: { soupId } });
  } catch (e) {
    console.error('ai save error:', e);
    return sendJSON(res, 500, { code: 500, message: '保存失败，请稍后重试' });
  }
}

// 当前用户全部存档列表（用于选汤页显示「继续游玩」按钮）
async function handleAIListSaves(req, res) {
  if (!pool) return dbNotReady(res);
  try {
    const [rows] = await pool.query(
      `SELECT soup_id, last_progress, remaining_questions, updated_at
       FROM game_saves WHERE user_id = ?`,
      [req.authUser.uid]
    );
    const list = rows.map((r) => ({
      soupId: r.soup_id,
      lastProgress: r.last_progress,
      remainingQuestions: r.remaining_questions,
      updatedAt: r.updated_at,
    }));
    return sendJSON(res, 200, { code: 0, data: { list } });
  } catch (e) {
    console.error('ai saves list error:', e);
    return sendJSON(res, 500, { code: 500, message: '查询存档失败' });
  }
}

// 读取某汤的存档详情（恢复游戏现场）
async function handleAIGetSave(req, res, soupId) {
  if (!pool) return dbNotReady(res);
  try {
    const [rows] = await pool.query(
      `SELECT soup_id, soup_title, face, bottom, type, style, diff_key, diff_label,
              total_questions, remaining_questions, remaining_seconds, elapsed_seconds,
              last_progress, history_json
       FROM game_saves WHERE user_id = ? AND soup_id = ?`,
      [req.authUser.uid, soupId]
    );
    const s = rows[0];
    if (!s) return sendJSON(res, 404, { code: 404, message: '该汤没有保存的进度' });
    let history = [];
    try { history = JSON.parse(s.history_json || '[]'); } catch (e) { history = []; }
    return sendJSON(res, 200, {
      code: 0,
      data: {
        soupId: s.soup_id,
        soupTitle: s.soup_title,
        face: s.face,
        bottom: s.bottom,
        type: s.type,
        style: s.style,
        diffKey: s.diff_key,
        diffLabel: s.diff_label,
        totalQuestions: s.total_questions,
        remainingQuestions: s.remaining_questions,
        remainingSeconds: s.remaining_seconds,
        elapsedSeconds: s.elapsed_seconds,
        lastProgress: s.last_progress,
        history: Array.isArray(history) ? history : [],
      },
    });
  } catch (e) {
    console.error('ai get save error:', e);
    return sendJSON(res, 500, { code: 500, message: '读取存档失败' });
  }
}

// 福尔摩斯难度：让 AI 在不影响故事真实的前提下酌情删减汤面文字
async function handleAIShorten(req, res) {  const payload = safeJSON(bodyToText(await readBody(req)));
  if (payload === null) return sendJSON(res, 400, { code: 400, message: '请求格式错误' });

  const face = payload.face;
  if (!face) return sendJSON(res, 400, { code: 400, message: '缺少汤面' });

  // 读取服务端引擎设置（删减汤面依赖大模型；未配置则降级返回原汤面）
  let llmCfg = null;
  try {
    const [rows] = await pool.query(
      'SELECT llm_enabled, llm_base_url, llm_model, llm_api_key FROM user_settings WHERE user_id = ?',
      [req.authUser.uid]
    );
    const s = rows[0];
    if (s && s.llm_enabled && s.llm_base_url && s.llm_api_key) {
      llmCfg = { baseUrl: s.llm_base_url, apiKey: s.llm_api_key, model: s.llm_model || '' };
    }
  } catch (e) {
    console.error('read user_settings (shorten) error:', e.message);
  }
  if (!llmCfg) {
    // 未配大模型：降级返回原汤面，不报错
    return sendJSON(res, 200, { code: 0, data: { face, degraded: true } });
  }

  try {
    const messages = [
      {
        role: 'system',
        content: '你是一个海龟汤游戏的出题助手。下面给出一段海龟汤的「汤面」（事件摘要）。请在不改变故事事实、不影响玩家推理的前提下，酌情删减掉一些文字（保留关键事实，删去冗余描述），让汤面更简短、更有挑战性。直接输出删减后的汤面文字，不要任何解释、不要代码块。',
      },
      { role: 'user', content: face },
    ];
    const shortened = await callLLM(llmCfg.baseUrl, llmCfg.apiKey, llmCfg.model, messages);
    return sendJSON(res, 200, { code: 0, data: { face: shortened || face } });
  } catch (e) {
    console.error('ai shorten error:', e.message);
    // 删减失败降级返回原汤面
    return sendJSON(res, 200, { code: 0, data: { face, degraded: true } });
  }
}

// ==================== 管理者：口令校验 ====================
// 设计要点：
//   1. 口令只从环境变量 ADMIN_PASSWORD 读取，未配置则整体返回 503（不静默放行）
//   2. 同一 IP 连续失败 5 次锁定 15 分钟，抵御口令爆破
//   3. 失败日志只记录 IP 与用户名，绝不打印口令本身
//   4. 失败返回 401 而非 200+错误码，但带 admin:true，前端不会误判成「登录过期」
async function handleAdminLogin(req, res) {
  if (!ADMIN_PASSWORD) {
    return sendJSON(res, 503, {
      code: 503,
      admin: true,
      message: '管理者入口未启用：服务器未配置 ADMIN_PASSWORD 环境变量（见 README「管理者入口」）',
    });
  }

  const ip = clientIP(req);
  const lockedMs = adminLockRemainMs(ip);
  if (lockedMs > 0) {
    return sendJSON(res, 429, {
      code: 429,
      admin: true,
      message: `口令错误次数过多，请 ${Math.ceil(lockedMs / 60000)} 分钟后再试`,
    });
  }

  const payload = safeJSON(bodyToText(await readBody(req)));
  if (payload === null) return sendJSON(res, 400, { code: 400, admin: true, message: '请求格式错误' });

  const password = String(payload.password || '');
  if (!password) return sendJSON(res, 400, { code: 400, admin: true, message: '请输入管理者口令' });

  if (!safeEqual(password, ADMIN_PASSWORD)) {
    adminRecordFail(ip);
    const r = adminFails.get(ip);
    console.warn(`[admin] 口令校验失败 ip=${ip} user=${req.authUser.username} 连续失败=${r ? r.count : 1}`);
    return sendJSON(res, 401, { code: 401, admin: true, message: '口令不正确' });
  }

  adminClearFails(ip);
  const adminToken = signToken(
    { uid: req.authUser.uid, username: req.authUser.username, role: 'admin' },
    ADMIN_TOKEN_EXPIRE
  );
  console.log(`[admin] 口令校验通过 user=${req.authUser.username} ip=${ip}`);
  return sendJSON(res, 200, {
    code: 0,
    message: '验证通过',
    data: { adminToken, expiresIn: ADMIN_TOKEN_EXPIRE, username: req.authUser.username },
  });
}

// ==================== 管理者：知识库概览 ====================
async function handleAdminKbStats(req, res) {
  if (!pool) return dbNotReady(res);
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS files,
              COALESCE(SUM(blocks), 0) AS blocks,
              COALESCE(SUM(chars), 0) AS chars,
              MAX(created_at) AS last_at
       FROM kb_documents`
    );
    const r = rows[0] || {};
    return sendJSON(res, 200, {
      code: 0,
      data: {
        files: Number(r.files) || 0,
        blocks: Number(r.blocks) || 0,
        chars: Number(r.chars) || 0,
        lastUploadAt: r.last_at || null,
        vectors: knowledgeBase.count(),        // 向量库实际条数，可与 blocks 对不上时用来排查
        collection: knowledgeBase.KB_COLLECTION,
        topK: knowledgeBase.DEFAULT_TOP_K,
        minScore: knowledgeBase.DEFAULT_MIN_SCORE,
      },
    });
  } catch (e) {
    console.error('admin kb stats error:', e.message);
    return sendJSON(res, 500, { code: 500, admin: true, message: '读取知识库概览失败' });
  }
}

// ==================== 管理者：已上传文件列表（分页） ====================
async function handleAdminKbDocuments(req, res, url) {
  if (!pool) return dbNotReady(res);
  try {
    const qs = url && url.searchParams ? url.searchParams : new URLSearchParams();
    let page = Math.max(1, parseInt(qs.get('page'), 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(qs.get('pageSize'), 10) || 20));

    const [countRows] = await pool.query('SELECT COUNT(*) AS c FROM kb_documents');
    const total = Number(countRows[0].c) || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    page = Math.min(page, totalPages);

    const [rows] = await pool.query(
      `SELECT id, filename, md5, blocks, chunks, chars, encoding, operator_name, created_at
       FROM kb_documents
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [pageSize, (page - 1) * pageSize]
    );

    return sendJSON(res, 200, {
      code: 0,
      data: {
        list: rows.map((r) => ({
          id: r.id,
          filename: r.filename,
          blocks: r.blocks,
          chunks: r.chunks,
          chars: r.chars,
          encoding: r.encoding || '',
          operator: r.operator_name,
          createdAt: r.created_at,
        })),
        total,
        page,
        pageSize,
        totalPages,
      },
    });
  } catch (e) {
    console.error('admin kb documents error:', e.message);
    return sendJSON(res, 500, { code: 500, admin: true, message: '读取文件列表失败' });
  }
}

/**
 * 单个文件的入库流程（幂等）。步骤与参考项目一致，但两处按本项目约定调整：
 *   ① 去重记录进 MySQL（kb_documents.md5 唯一键）而不是 md5.text 文件
 *   ② 先写向量、再写台账；台账唯一键冲突（并发重复上传）时回滚刚写入的向量，
 *      保证「向量库里有、台账里没有」的孤儿数据不会出现
 *
 * @returns {{filename, status:'ok'|'skipped'|'rejected', message?, blocks?, chunks?, chars?, encoding?}}
 */
async function ingestKnowledgeFile({ filename, buffer, user }) {
  const safeName = sanitizeFilename(filename);

  if (!/\.txt$/i.test(safeName)) {
    return { filename: safeName, status: 'rejected', message: '仅支持 .txt 文件' };
  }
  if (buffer.length > KB_MAX_FILE_BYTES) {
    return {
      filename: safeName,
      status: 'rejected',
      message: `文件超过 ${Math.round(KB_MAX_FILE_BYTES / 1024 / 1024)}MB 上限`,
    };
  }

  const decoded = decodeTextBuffer(buffer);
  const text = knowledgeBase.normalizeText(decoded.text);
  if (!text) {
    return { filename: safeName, status: 'rejected', message: '文件内容为空', encoding: decoded.encoding };
  }
  if (text.length > KB_MAX_FILE_CHARS) {
    return {
      filename: safeName,
      status: 'rejected',
      message: `解析后文本超过 ${Math.round(KB_MAX_FILE_CHARS / 10000)} 万字上限，请拆分后上传`,
      encoding: decoded.encoding,
    };
  }

  const fp = knowledgeBase.fingerprint(text);
  const [dupRows] = await pool.query(
    'SELECT filename FROM kb_documents WHERE md5 = ? LIMIT 1',
    [fp]
  );
  if (dupRows.length) {
    return {
      filename: safeName,
      status: 'skipped',
      message: `内容与「${dupRows[0].filename}」重复，已跳过`,
      encoding: decoded.encoding,
    };
  }

  const blocks = knowledgeBase.parseKnowledgeFile(text, safeName);
  if (!blocks.length) {
    return { filename: safeName, status: 'rejected', message: '未解析出可入库的内容', encoding: decoded.encoding };
  }

  const docId = crypto.randomUUID();
  const { chunks } = knowledgeBase.ingestBlocks({
    docId,
    filename: safeName,
    blocks,
    operator: user && user.username ? user.username : '',
  });

  try {
    await pool.query(
      `INSERT INTO kb_documents
        (id, filename, md5, blocks, chunks, chars, encoding, operator_id, operator_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        docId, safeName, fp, blocks.length, chunks, text.length, decoded.encoding,
        (user && user.uid) || '', (user && user.username) || '',
      ]
    );
  } catch (e) {
    // 并发重复上传会撞唯一键：把刚写入的向量撤掉，保持与台账一致
    knowledgeBase.deleteByDocument(docId);
    if (e && e.code === 'ER_DUP_ENTRY') {
      return { filename: safeName, status: 'skipped', message: '内容已存在（并发重复上传），已跳过', encoding: decoded.encoding };
    }
    throw e;
  }

  return {
    filename: safeName,
    status: 'ok',
    blocks: blocks.length,
    chunks,
    chars: text.length,
    encoding: decoded.encoding,
    message: `已入库 ${blocks.length} 个知识单元`,
  };
}

// ==================== 管理者：批量上传 txt 入知识库 ====================
async function handleAdminKbUpload(req, res) {
  if (!pool) return dbNotReady(res);

  const contentType = req.headers['content-type'] || '';
  const boundary = parseBoundary(contentType);
  if (!contentType.includes('multipart/form-data') || !boundary) {
    return sendJSON(res, 400, { code: 400, admin: true, message: '请以 multipart/form-data 上传文件' });
  }

  let buf;
  try {
    buf = await readBody(req, MAX_KB_BODY);
  } catch (e) {
    return sendJSON(res, 413, {
      code: 413,
      admin: true,
      message: `单次上传内容超过 ${Math.round(MAX_KB_BODY / 1024 / 1024)}MB，请分批上传`,
    });
  }

  const files = parseMultipart(buf, boundary).filter((p) => p.filename);
  if (!files.length) {
    return sendJSON(res, 400, { code: 400, admin: true, message: '未检测到文件内容' });
  }
  if (files.length > KB_MAX_FILES) {
    return sendJSON(res, 400, {
      code: 400,
      admin: true,
      message: `单次最多上传 ${KB_MAX_FILES} 个文件，当前 ${files.length} 个，请分批上传`,
    });
  }

  const results = [];
  for (const f of files) {
    try {
      results.push(await ingestKnowledgeFile({ filename: f.filename, buffer: f.body, user: req.authUser }));
    } catch (e) {
      console.error('kb ingest error:', e.message);
      results.push({
        filename: sanitizeFilename(f.filename),
        status: 'rejected',
        message: '入库失败：' + e.message,
      });
    }
  }

  const okCount = results.filter((r) => r.status === 'ok').length;
  const skipCount = results.filter((r) => r.status === 'skipped').length;
  const failCount = results.filter((r) => r.status === 'rejected').length;
  console.log(`[admin] 知识库上传 user=${req.authUser.username} 成功=${okCount} 跳过=${skipCount} 失败=${failCount}`);

  return sendJSON(res, 200, {
    code: 0,
    message: `成功 ${okCount} 个，跳过 ${skipCount} 个，失败 ${failCount} 个`,
    data: { results, summary: { ok: okCount, skipped: skipCount, failed: failCount }, vectors: knowledgeBase.count() },
  });
}

// ==================== 管理者：检索测试（用于校准 top-k 与门槛） ====================
// 刻意不套门槛，把原始分数与「是否过门槛」一并返回，
// 让管理员能按自己语料的真实分数分布来决定门槛该调高还是调低。
async function handleAdminKbSearch(req, res) {
  const payload = safeJSON(bodyToText(await readBody(req)));
  if (payload === null) return sendJSON(res, 400, { code: 400, admin: true, message: '请求格式错误' });

  const question = String(payload.question || '').trim();
  if (!question) return sendJSON(res, 400, { code: 400, admin: true, message: '请输入测试问题' });
  if (question.length > 500) {
    return sendJSON(res, 400, { code: 400, admin: true, message: '测试问题不超过 500 字' });
  }

  const n = Math.min(20, Math.max(1, Number(payload.n) || knowledgeBase.DEFAULT_TOP_K));
  const minScore = typeof payload.minScore === 'number' && payload.minScore >= 0 && payload.minScore <= 1
    ? payload.minScore
    : knowledgeBase.DEFAULT_MIN_SCORE;

  try {
    const raw = chroma.query(knowledgeBase.KB_COLLECTION, { queryText: question, n });
    return sendJSON(res, 200, {
      code: 0,
      data: {
        question,
        n,
        minScore,
        hits: raw.map((h) => ({
          score: Math.round(h.score * 1000) / 1000,
          pass: h.score > minScore,
          title: (h.meta && h.meta.title) || '',
          filename: (h.meta && h.meta.filename) || '',
          kind: (h.meta && h.meta.kind) || 'note',
          text: h.text,
        })),
      },
    });
  } catch (e) {
    console.error('admin kb search error:', e.message);
    return sendJSON(res, 500, { code: 500, admin: true, message: '检索失败' });
  }
}

// ==================== 管理者：删除某个文件的知识（连带向量） ====================
// 顺序：先删向量，再删台账。反过来的话，一旦向量删除失败就会留下
// 「台账里看不见、检索却仍会命中」的脏数据。
async function handleAdminKbDeleteDocument(req, res, id) {
  if (!pool) return dbNotReady(res);
  try {
    const [rows] = await pool.query('SELECT id, filename FROM kb_documents WHERE id = ?', [id]);
    if (!rows.length) return sendJSON(res, 404, { code: 404, admin: true, message: '未找到该文件记录' });

    const removed = knowledgeBase.deleteByDocument(id);
    await pool.query('DELETE FROM kb_documents WHERE id = ?', [id]);
    console.log(`[admin] 删除知识库文件 ${rows[0].filename} 向量 ${removed} 条 user=${req.authUser.username}`);
    return sendJSON(res, 200, {
      code: 0,
      message: `已删除「${rows[0].filename}」及其 ${removed} 条向量`,
      data: { removed, vectors: knowledgeBase.count() },
    });
  } catch (e) {
    console.error('admin kb delete error:', e.message);
    return sendJSON(res, 500, { code: 500, admin: true, message: '删除失败' });
  }
}

// ==================== 管理者：清空知识库 ====================
// 破坏性操作：要求请求体显式带上 confirm 文本，防止误触/CSRF 式的一键清空。
async function handleAdminKbReset(req, res) {
  if (!pool) return dbNotReady(res);
  const payload = safeJSON(bodyToText(await readBody(req)));
  if (payload === null) return sendJSON(res, 400, { code: 400, admin: true, message: '请求格式错误' });
  if (payload.confirm !== '清空知识库') {
    return sendJSON(res, 400, { code: 400, admin: true, message: '请在确认框中输入「清空知识库」以执行' });
  }
  try {
    // 恒真条件 = 清空整个 collection（向量库按 collection 隔离，不会波及题库向量 haigui_soups）
    const removed = chroma.deleteWhere(knowledgeBase.KB_COLLECTION, () => true);
    await pool.query('DELETE FROM kb_documents');
    console.warn(`[admin] 清空知识库，删除向量 ${removed} 条 user=${req.authUser.username}`);
    return sendJSON(res, 200, { code: 0, message: `已清空知识库（${removed} 条向量）`, data: { removed } });
  } catch (e) {
    console.error('admin kb reset error:', e.message);
    return sendJSON(res, 500, { code: 500, admin: true, message: '清空失败' });
  }
}

// ==================== 启动 ====================
(async function start() {
  try {
    await initDatabase();
  } catch (e) {
    console.error('❌ 数据库初始化失败:', e.code, e.message);
    console.error('   请检查 MySQL 是否已启动，以及连接配置是否正确（DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME）');
    // 数据库不可用时仍启动 HTTP 服务，接口会返回 503，方便排障
  }
  server.listen(PORT, () => {
    console.log(`✅ 海龟汤网站后端已启动: http://localhost:${PORT}`);
  });
})();
