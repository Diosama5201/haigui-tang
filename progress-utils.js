/**
 * 推理进度智能体的纯函数工具（无外部依赖，可独立单测）
 */

/**
 * 从模型输出中稳健地提取 progress 数字（容忍截断的 JSON / 代码块包裹 / 额外文字）
 * @returns 0~100 的整数，无法解析返回 null
 */
function parseProgressFromText(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  // 1) 标准 JSON 提取；若花括号未闭合（输出被截断），补一个右花括号再试
  const braceStart = cleaned.indexOf('{');
  if (braceStart !== -1) {
    const raw = cleaned.slice(braceStart);
    const candidates = [];
    const closed = raw.match(/\{[\s\S]*\}/);
    if (closed) candidates.push(closed[0]);
    candidates.push(raw + '}');
    for (const c of candidates) {
      try {
        const p = Number(JSON.parse(c).progress);
        if (Number.isFinite(p) && p >= 0 && p <= 100) return Math.round(p);
      } catch (e) { /* 换下一种方式 */ }
    }
  }
  // 2) 正则兜底：JSON 残缺也能直接抓到 progress 字段的数字
  const r = cleaned.match(/["']?progress["']?\s*[:：=]\s*(\d{1,3})/i);
  if (r) {
    const p = Number(r[1]);
    if (p >= 0 && p <= 100) return p;
  }
  return null;
}

/**
 * 本地启发式估算（最终兜底，保证进度条永远会动）：
 * 每个「是」= 1 个确认事实点，「是或不是」= 0.5，「否」= 0.3（排除错误方向也有价值），
 * 对数增长：首个确认约 14%，四个「是」约 32%，封顶 85
 */
function estimateProgressLocally(history) {
  const list = Array.isArray(history) ? history : [];
  if (!list.length) return 0;
  let score = 0;
  for (const t of list) {
    if (t.answer === '是') score += 1;
    else if (t.answer === '是或不是') score += 0.5;
    else if (t.answer === '否') score += 0.3;
    else score += 0.15;
  }
  return Math.max(0, Math.min(85, Math.round(20 * Math.log(1 + score))));
}

module.exports = { parseProgressFromText, estimateProgressLocally };
