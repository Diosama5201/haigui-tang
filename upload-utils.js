/**
 * 上传相关的字节级工具
 *
 * 独立成模块的原因：这三件事都是「字节层面」的、极易静默出错、且与业务无关的处理，
 * 放在 server.js 里既没法单测，也很难在出问题时定位。
 * 历史事故：旧实现先把整个 multipart 请求体 toString('utf8') 再按 boundary 切字符串，
 * 于是 Windows 记事本存成「ANSI」(GBK) 的 txt 会被解成整篇乱码，
 * 而且解出来的乱码里一旦恰好含有 boundary 片段，切分边界还会被污染。
 */

/**
 * 二进制安全的 multipart/form-data 解析（支持一次上传多个文件）。
 *
 * 直接在 Buffer 上按 boundary 定位，只按字节切，任何内容（含二进制、
 * 含与 boundary 形似的文本）都不会破坏结构。
 *
 * @param {Buffer} buf      完整请求体
 * @param {string} boundary boundary 字符串（不含前缀 `--`）
 * @returns {Array<{name:string, filename:string, header:string, body:Buffer}>}
 */
function parseMultipart(buf, boundary) {
  const parts = [];
  if (!buf || !buf.length || !boundary) return parts;

  const delim = Buffer.from('--' + boundary, 'utf8');
  let idx = buf.indexOf(delim);

  while (idx !== -1) {
    const afterDelim = idx + delim.length;
    // 结束边界形如 `--boundary--`
    if (buf[afterDelim] === 0x2d && buf[afterDelim + 1] === 0x2d) break;

    let start = afterDelim;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2; // 跳过 boundary 后的 CRLF

    const headerEnd = buf.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;

    const header = buf.slice(start, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const next = buf.indexOf(delim, bodyStart);
    if (next === -1) break;

    // 片段末尾的 CRLF 属于分隔符，不属于内容
    let bodyEnd = next;
    if (buf[bodyEnd - 2] === 0x0d && buf[bodyEnd - 1] === 0x0a) bodyEnd -= 2;

    const nameMatch = header.match(/name="([^"]*)"/i);
    const fileMatch = header.match(/filename\*?=(?:"([^"]*)"|([^;\r\n]+))/i);

    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: fileMatch
        ? String(fileMatch[1] || fileMatch[2] || '').trim().replace(/^UTF-8''/i, '')
        : '',
      header,
      body: buf.slice(bodyStart, bodyEnd),
    });

    idx = next;
  }

  return parts;
}

/**
 * 从 Content-Type 头里取出 boundary。
 * 兼容 `boundary=xxx`、`boundary="xxx"`（带引号）两种写法。
 * @returns {string} 取不到返回空串
 */
function parseBoundary(contentType) {
  const m = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return m ? String(m[1] || m[2] || '').trim() : '';
}

/**
 * 文件名净化：只保留最后一段路径（杜绝 `../../etc/passwd` 这类穿越），
 * 去掉控制字符并限长。
 *
 * 说明：本项目从不拿上传文件名拼接磁盘路径（原始文件统一用 UUID 命名），
 * 这里只是把元数据收拾干净，避免脏数据进入日志与前端表格。
 */
function sanitizeFilename(name) {
  const base = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 120);
  return base || '未命名.txt';
}

/**
 * 上传文本的编码识别。
 *
 * Windows 记事本「另存为 → ANSI」的 txt 实际是 GBK 编码，直接按 UTF-8 解码会整篇乱码。
 * 策略（顺序确定，不做猜测）：
 *   ① 有 UTF-8 BOM → 按 UTF-8 解（BOM 是明确标识）
 *   ② 按 UTF-8 解出来不含替换字符 U+FFFD → 就是合法 UTF-8
 *   ③ 否则回落 GBK（Node 自带完整 ICU，TextDecoder('gbk') 可用）
 *
 * @param {Buffer} buf
 * @returns {{text:string, encoding:string}}
 */
function decodeTextBuffer(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');

  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return { text: b.slice(3).toString('utf8'), encoding: 'utf-8 (BOM)' };
  }

  const utf8 = b.toString('utf8');
  if (!utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf-8' };

  try {
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(b);
    if (gbk && !gbk.includes('\uFFFD')) return { text: gbk, encoding: 'gbk' };
    return { text: gbk || utf8, encoding: 'gbk (部分字符无法识别)' };
  } catch (e) {
    return { text: utf8, encoding: 'utf-8 (含无法识别的字节)' };
  }
}

module.exports = {
  parseMultipart,
  parseBoundary,
  sanitizeFilename,
  decodeTextBuffer,
};
