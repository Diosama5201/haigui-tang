/**
 * 上传字节级工具单测
 * 运行：npm run test:upload   （或 node tests/upload-utils.test.js）
 *
 * 重点覆盖两类「会静默出错」的场景：
 *   1. GBK（Windows 记事本 ANSI）txt 的编码识别 —— 识别错就是一整篇乱码
 *   2. 多文件 multipart 解析 —— 旧实现按字符串切分，多文件时边界会被相邻内容污染
 */

const { parseMultipart, parseBoundary, sanitizeFilename, decodeTextBuffer } = require('../upload-utils.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push({ name, actual, expected });
    console.log(`  FAIL  ${name}\n        期望=${JSON.stringify(expected)} 实际=${JSON.stringify(actual)}`);
  }
}

function ok(name, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push({ name, actual: detail || '(条件不成立)', expected: 'true' });
    console.log(`  FAIL  ${name}  ${detail || ''}`);
  }
}

/* ==================== 构造 multipart 请求体 ==================== */
/**
 * 手工拼一个 multipart 请求体（与浏览器/curl 的输出格式一致，CRLF 分隔）。
 * @param {string} boundary
 * @param {Array<{name:string, filename:string, content:Buffer}>} files
 */
function buildMultipart(boundary, files) {
  const chunks = [];
  for (const f of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n` +
      'Content-Type: text/plain\r\n\r\n',
      'utf8'
    ));
    chunks.push(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

// GB2312 编码（Node 没有内置编码器，这里手工映射够用的字符，避免引入第三方依赖）
// 每个汉字 2 字节，取值来自 GB2312 码表
const GBK_MAP = {
  测: [0xb2, 0xe2], 试: [0xca, 0xd4], 题: [0xcc, 0xe2], 目: [0xc4, 0xbf],
  汤: [0xcc, 0xc0], 底: [0xb5, 0xd7], 面: [0xc3, 0xe6],
  归: [0xb9, 0xe9], 来: [0xc0, 0xb4], 渔: [0xd3, 0xe6], 船: [0xb4, 0xac],
  雪: [0xd1, 0xa9], 橇: [0xc7, 0xc1], 拉: [0xc0, 0xad], 走: [0xd7, 0xdf],
  的: [0xb5, 0xc4], 他: [0xcb, 0xfb], 是: [0xca, 0xc7], 被: [0xb1, 0xbb],
};
function toGBK(str) {
  const bytes = [];
  for (const ch of str) {
    if (GBK_MAP[ch]) bytes.push(...GBK_MAP[ch]);
    else if (ch.charCodeAt(0) < 128) bytes.push(ch.charCodeAt(0));
    else throw new Error('测试用 GBK 映射表未覆盖字符: ' + ch);
  }
  return Buffer.from(bytes);
}

/* ==================== 一、boundary 提取 ==================== */
console.log('\n===== 一、boundary 提取 =====');
{
  check('普通写法', parseBoundary('multipart/form-data; boundary=----WebKitFormBoundaryAbC123'), '----WebKitFormBoundaryAbC123');
  check('带引号写法', parseBoundary('multipart/form-data; boundary="abc123"'), 'abc123');
  check('末尾带分号', parseBoundary('multipart/form-data; boundary=abc123; charset=utf-8'), 'abc123');
  check('非 multipart 返回空串', parseBoundary('application/json'), '');
  check('空头返回空串', parseBoundary(''), '');
}

/* ==================== 二、multipart 解析 ==================== */
console.log('\n===== 二、multipart 解析 =====');
{
  const b = '----WebKitFormBoundaryTest01';
  const body = buildMultipart(b, [
    { name: 'file', filename: '结构化题库.txt', content: Buffer.from('汤面：一个人在雪地里留下两排脚印。', 'utf8') },
  ]);
  const parts = parseMultipart(body, b);
  check('单文件解析出 1 段', parts.length, 1);
  check('字段名正确', parts[0].name, 'file');
  check('中文文件名正确（UTF-8）', parts[0].filename, '结构化题库.txt');
  check('内容正确且不含尾部 CRLF', parts[0].body.toString('utf8'), '汤面：一个人在雪地里留下两排脚印。');
}

{
  // 多文件：旧实现（先 toString 再 split）在这里最容易出错
  const b = '----WebKitFormBoundaryTest02';
  const body = buildMultipart(b, [
    { name: 'files', filename: '甲.txt', content: Buffer.from('第一份内容', 'utf8') },
    { name: 'files', filename: '乙.txt', content: Buffer.from('第二份内容', 'utf8') },
    { name: 'files', filename: '丙.txt', content: Buffer.from('第三份内容', 'utf8') },
  ]);
  const parts = parseMultipart(body, b);
  check('三文件解析出 3 段', parts.length, 3);
  check('第 1 个文件名', parts[0].filename, '甲.txt');
  check('第 2 个文件名', parts[1].filename, '乙.txt');
  check('第 3 个文件名', parts[2].filename, '丙.txt');
  check('第 1 个内容', parts[0].body.toString('utf8'), '第一份内容');
  check('第 2 个内容', parts[1].body.toString('utf8'), '第二份内容');
  check('第 3 个内容（末段不被截断）', parts[2].body.toString('utf8'), '第三份内容');
}

{
  // 关键回归：文件内容里出现「与 boundary 形似的文本」，结构不能被破坏
  const b = '----WebKitFormBoundaryTest03';
  const tricky = '这段文字里故意写了 ----WebKitFormBoundaryTest03 但前面没有换行，不该被当成边界';
  const body = buildMultipart(b, [
    { name: 'files', filename: '干扰.txt', content: Buffer.from(tricky, 'utf8') },
    { name: 'files', filename: '正常.txt', content: Buffer.from('正常内容', 'utf8') },
  ]);
  const parts = parseMultipart(body, b);
  check('含干扰文本时仍解析出 2 段', parts.length, 2);
  check('干扰文件内容完整保留', parts[0].body.toString('utf8'), tricky);
  check('第二个文件内容不受影响', parts[1].body.toString('utf8'), '正常内容');
}

{
  // 二进制内容（防止把 Buffer 当字符串处理引入损坏）
  const b = '----WebKitFormBoundaryTest04';
  const bin = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x0d, 0x0a, 0x89, 0x50]);
  const body = buildMultipart(b, [{ name: 'files', filename: 'bin.txt', content: bin }]);
  const parts = parseMultipart(body, b);
  check('二进制内容字节数一致', parts[0].body.length, bin.length);
  ok('二进制内容逐字节一致', parts[0].body.equals(bin), parts[0].body.toString('hex'));
}

{
  const b = 'abc';
  check('空请求体 → 0 段', parseMultipart(Buffer.alloc(0), b).length, 0);
  check('无 boundary → 0 段', parseMultipart(Buffer.from('whatever'), '').length, 0);
  check('垃圾内容 → 0 段', parseMultipart(Buffer.from('not a multipart body'), b).length, 0);
  // 只有结束边界，没有有效片段
  check('只有结束边界 → 0 段', parseMultipart(Buffer.from('--abc--\r\n'), b).length, 0);
}

{
  // 中文 GBK 文件名：浏览器实际会按 UTF-8 发文件名，这里验证 GBK 字节的文件名不会让解析崩溃
  const b = '----WebKitFormBoundaryTest05';
  const filenameBytes = toGBK('题目');
  const head = Buffer.concat([
    Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="files"; filename="', 'utf8'),
    filenameBytes,
    Buffer.from('".txt"\r\n\r\n', 'utf8'),
  ]);
  const body = Buffer.concat([head, Buffer.from('内容', 'utf8'), Buffer.from('\r\n--' + b + '--\r\n', 'utf8')]);
  const parts = parseMultipart(body, b);
  check('GBK 文件名仍能解析出 1 段', parts.length, 1);
  ok('GBK 文件名已按 UTF-8 解码（可能含替换字符，但不抛异常）', typeof parts[0].filename === 'string', '');
  check('内容仍正确', parts[0].body.toString('utf8'), '内容');
}

/* ==================== 三、文件名净化 ==================== */
console.log('\n===== 三、文件名净化 =====');
{
  check('路径穿越（Unix）', sanitizeFilename('../../etc/passwd.txt'), 'passwd.txt');
  check('路径穿越（Windows）', sanitizeFilename('..\\..\\Windows\\win.ini'), 'win.ini');
  check('绝对路径', sanitizeFilename('/var/www/secret.txt'), 'secret.txt');
  check('中文名保留', sanitizeFilename('雪夜里的脚印.txt'), '雪夜里的脚印.txt');
  check('去控制字符', sanitizeFilename('a\u0000b\u001fc.txt'), 'abc.txt');
  check('空名字给默认值', sanitizeFilename(''), '未命名.txt');
  check('只有路径分隔符给默认值', sanitizeFilename('///'), '未命名.txt');
  check('超长名字被截断到 120 字', sanitizeFilename('x'.repeat(200) + '.txt').length, 120);
}

/* ==================== 四、编码识别（GBK 是重点） ==================== */
console.log('\n===== 四、编码识别 =====');

{
  const buf = Buffer.from('汤面：一个人在雪地里留下两排脚印。', 'utf8');
  const r = decodeTextBuffer(buf);
  check('纯 UTF-8 识别正确', r.encoding, 'utf-8');
  check('纯 UTF-8 内容正确', r.text, '汤面：一个人在雪地里留下两排脚印。');
}

{
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('汤底：他是被雪橇拉走的。', 'utf8')]);
  const r = decodeTextBuffer(buf);
  check('UTF-8 BOM 被识别', r.encoding, 'utf-8 (BOM)');
  check('BOM 已被剥掉（首字符不是不可见字符）', r.text.slice(0, 2), '汤底');
}

{
  // 核心回归：GBK（Windows 记事本 ANSI）必须被正确解码，而不是变成一整篇乱码
  const raw = '汤底他是被雪橇拉走的';
  const buf = toGBK(raw);
  const r = decodeTextBuffer(buf);
  check('GBK 被识别', r.encoding, 'gbk');
  check('GBK 内容正确解码', r.text, raw);
  ok('GBK 内容不含替换字符', !r.text.includes('\uFFFD'), r.text);
}

{
  // 混合：GBK 中文 + ASCII 换行（真实文件的样子）
  const buf = Buffer.concat([
    toGBK('归来渔船'),
    Buffer.from('\n', 'utf8'),
    toGBK('面归来的渔船'),
  ]);
  const r = decodeTextBuffer(buf);
  check('GBK 多行被识别', r.encoding, 'gbk');
  check('GBK 多行内容正确', r.text, '归来渔船\n面归来的渔船');
}

{
  const r = decodeTextBuffer(Buffer.alloc(0));
  check('空 buffer 不抛异常', typeof r.text, 'string');
  check('空 buffer 内容为空串', r.text, '');
}

{
  // 既不是合法 UTF-8 也不是合法 GBK 的字节：必须降级返回，不能让整条上传链路崩掉
  const weird = Buffer.from([0xff, 0xfe, 0x81, 0x40, 0xff, 0xfe]);
  let threw = false;
  let r = null;
  try { r = decodeTextBuffer(weird); } catch (e) { threw = true; }
  check('非法字节不抛异常', threw, false);
  ok('非法字节也返回 encoding 说明', !!(r && r.encoding), JSON.stringify(r));
}

/* ==================== 收尾 ==================== */
console.log('\n----------------------------------------');
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(`  - ${f.name}: 期望=${JSON.stringify(f.expected)} 实际=${JSON.stringify(f.actual)}`));
  process.exit(1);
}
console.log('全部通过');
