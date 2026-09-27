/**
 * 人工标注层（annotation-store.js）单测
 * 运行：node tests/annotation-store.test.js
 *
 * 这一层是「命中就直接返回人工答案」的查询层，风险集中在两处：
 *   ① 该命中时没命中（标注白标了）
 *   ② 不该命中时乱命中（题目认错、提问认错 → 会把别的题的答案安到这道题上）
 * 所以测试围绕「命中 / 不命中 / 可关闭 / 可降级」四件事展开。
 */

const path = require('path');

const {
  lookupAnnotation,
  annotationStats,
  reloadAnnotations,
  normalizeAnswer,
  normText,
  questionKeys,
} = require('../annotation-store.js');
const { offlineJudge } = require('../offline-engine.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push({ name, actual, expected });
    console.log(`  FAIL  ${name}\n        期望=${expected} 实际=${actual}`);
  }
}

// —— 从标注文件里取一道题的完整信息（测试直接用真实数据，避免手写副本走样）——
const fs = require('fs');
const { parseJSONL } = require('../annotation-store.js');
const ROOT = path.join(__dirname, '..');
const soups = parseJSONL(fs.readFileSync(path.join(ROOT, 'annotations', 'soups.jsonl'), 'utf8')).rows;
const qas = parseJSONL(fs.readFileSync(path.join(ROOT, 'annotations', 'qa.jsonl'), 'utf8')).rows;
const soupOf = (id) => soups.find((s) => String(s.soupId) === String(id));

console.log('\n[1] 文本归一');
check('normText 去掉标点与空白', normText('老大死了吗？  '), '老大死了吗');
check('normText 忽略全半角问号差异', normText('他死了么?'), normText('他死了么？'));
check('questionKeys 产出去语气词变体', questionKeys('老大死了吗').includes('老大死了'), true);
check('答案归一：不是 → 否', normalizeAnswer('不是'), '否');
check('答案归一：有 → 是', normalizeAnswer('有'), '是');
check('答案归一：是或不是 保持', normalizeAnswer('是或不是'), '是或不是');

console.log('\n[2] 命中：严格提问');
const s1 = soupOf('s1');
const hit6 = lookupAnnotation({ face: s1.face, bottom: s1.bottom, question: '他杀了人吗？' });
check('s1「他杀了人吗？」命中', !!hit6, true);
check('s1「他杀了人吗？」答案取标注值「不是」→ 否', hit6 && hit6.answer, '否');

const hit12 = lookupAnnotation({ face: s1.face, bottom: s1.bottom, question: '为什么他要自杀？' });
check('s1「为什么他要自杀？」答案 = 无关紧要', hit12 && hit12.answer, '无关紧要');

console.log('\n[3] 命中：玩家不会照抄标注（语气词变体）');
const s2 = soupOf('s2');
check(
  's2「老大死了么」（标注写「老大死了吗」）仍命中',
  !!lookupAnnotation({ face: s2.face, bottom: s2.bottom, question: '老大死了么' }),
  true
);
check(
  's2「老大死了吗？」（带问号）命中',
  !!lookupAnnotation({ face: s2.face, bottom: s2.bottom, question: '老大死了吗？' }),
  true
);

console.log('\n[4] 不命中：不能把别的题的答案安过来');
check(
  '提问不在标注里 → null',
  lookupAnnotation({ face: s1.face, bottom: s1.bottom, question: '汤里有乌龟吗？' }),
  null
);
check(
  '题目对不上（换一道完全不同的题）→ null',
  lookupAnnotation({
    face: '一个男人在沙漠里被发现，手里握着半根火柴。',
    bottom: '他和同伴乘热气球，超重要抽签跳下去。',
    question: '他杀了人吗？',
  }),
  null
);
check(
  '空提问 → null',
  lookupAnnotation({ face: s1.face, bottom: s1.bottom, question: '   ' }),
  null
);
check(
  '只给提问不给题目文本 → null（无法定位题目）',
  lookupAnnotation({ question: '他杀了人吗？' }),
  null
);
// 跨题错位：s3 的提问拿到 s1 的题上，必须不命中
const s3 = soupOf('s3');
const q11 = qas.find((q) => String(q.soupId) === 's3');
check(
  '跨题提问不会误命中（s3 的提问 + s1 的题）',
  lookupAnnotation({ face: s1.face, bottom: s1.bottom, question: q11.question }),
  null
);
check(
  's3 自己的题上能命中',
  !!lookupAnnotation({ face: s3.face, bottom: s3.bottom, question: q11.question }),
  true
);

console.log('\n[5] 引擎入口：命中走标注层，可关闭');
const rHit = offlineJudge(s1.face, s1.bottom, '他杀了人吗？', 0, { style: s1.style, type: s1.type });
check('引擎命中标注：answer = 否', rHit.answer, '否');
check('引擎命中标注：reason = annotation-hit', rHit.reason, 'annotation-hit');
check('引擎命中标注：进度有推进', rHit.progress > 0, true);
check('引擎命中标注：带上标注 id 便于排查', !!rHit.annotation, true);

const rOff = offlineJudge(
  s1.face,
  s1.bottom,
  '他杀了人吗？',
  0,
  { style: s1.style, type: s1.type },
  { annotations: false }
);
check('关闭标注层后不再命中', rOff.reason !== 'annotation-hit', true);
check('关闭标注层后回落到规则引擎（无关紧要）', rOff.answer, '无关紧要');

console.log('\n[6] 引擎入口：未命中不影响原有行为');
const rPlain = offlineJudge(s1.face, s1.bottom, '汤里有乌龟吗？', 0, {
  style: s1.style,
  type: s1.type,
});
check('未命中时 reason 不是 annotation-hit', rPlain.reason !== 'annotation-hit', true);

console.log('\n[7] 降级：标注目录缺失时不能影响游戏');
const realDir = process.env.ANNOTATIONS_DIR;
process.env.ANNOTATIONS_DIR = path.join(ROOT, 'annotations-does-not-exist');
reloadAnnotations();
const st = annotationStats();
check('缺失时状态 = missing', st.state, 'missing');
check('缺失时查表返回 null', lookupAnnotation({ face: s1.face, question: '他杀了人吗？' }), null);
const rMissing = offlineJudge(s1.face, s1.bottom, '他杀了人吗？', 0, {
  style: s1.style,
  type: s1.type,
});
check('缺失时引擎照常工作（不抛错、有答案）', typeof rMissing.answer === 'string', true);
check('缺失时不会命中标注层', rMissing.reason !== 'annotation-hit', true);

// 恢复
if (realDir === undefined) delete process.env.ANNOTATIONS_DIR;
else process.env.ANNOTATIONS_DIR = realDir;
reloadAnnotations();
check('恢复后重新加载成功', annotationStats().state, 'ok');
check('恢复后仍能命中', !!lookupAnnotation({ face: s1.face, question: '他杀了人吗？' }), true);

console.log('\n----------------------------------------');
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(`  - ${f.name}\n    期望=${f.expected} 实际=${f.actual}`));
  process.exit(1);
}
console.log('全部通过');
