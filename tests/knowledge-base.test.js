/**
 * 知识库（RAG 第二层）单测 + 检索评测集
 * 运行：npm run test:kb   （或 node tests/knowledge-base.test.js）
 *
 * 覆盖三层：
 *   一、解析器单测：各种 txt 排版能否稳定切出「一题一块」
 *   二、边界 / 对抗输入：空文件、无结构长文、路径穿越文件名、超长提问
 *   三、检索评测集：24 条提问 → 目标题目是否被召回（命中率）
 *
 * 隔离：通过 CHROMA_DIR 指向临时目录，绝不写进项目的 data/chroma。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠️ 必须在 require vector-store 之前设好，否则会读到项目真实向量库
const TMP_DIR = path.join(os.tmpdir(), 'haigui-kb-test-' + process.pid + '-' + Date.now());
process.env.CHROMA_DIR = TMP_DIR;

const KB = require('../knowledge-base.js');
const chroma = require('../vector-store.js');

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

/* ================================================================== *
 * 一、解析器单测
 * ================================================================== */
console.log('\n===== 一、解析器：经典三段式 =====');

const classic = `雪夜里的脚印
一个人在雪地里留下两排脚印，却没有往回走的痕迹。
汤底
他是被雪橇拉走的，回来的是雪橇，不是他的脚。`;

{
  const blocks = KB.parseKnowledgeFile(classic, '雪夜里的脚印.txt');
  check('经典三段式切出 1 块', blocks.length, 1);
  check('标题取首行', blocks[0].title, '雪夜里的脚印');
  check('汤面取首行之后、汤底之前', blocks[0].face, '一个人在雪地里留下两排脚印，却没有往回走的痕迹。');
  check('汤底正确', blocks[0].bottom, '他是被雪橇拉走的，回来的是雪橇，不是他的脚。');
  check('无推理逻辑时为空', blocks[0].reasoning, '');
  check('kind = soup', blocks[0].kind, 'soup');
}

console.log('\n===== 一、解析器：全标签式 =====');
{
  const text = `汤名：半夜的敲门声
汤面：女子独自住在老宅，每晚十二点都会听见敲门声，开门却没有人。
汤底：敲门的是她失明的母亲，白天躲在阁楼，只在深夜摸索着下楼。
推理逻辑：线索是「只有敲门声、没有人影」加上「老宅有阁楼」。`;
  const blocks = KB.parseKnowledgeFile(text, 'a.txt');
  check('全标签式切出 1 块', blocks.length, 1);
  check('汤名标签', blocks[0].title, '半夜的敲门声');
  check('汤面标签', blocks[0].face, '女子独自住在老宅，每晚十二点都会听见敲门声，开门却没有人。');
  check('汤底标签', blocks[0].bottom, '敲门的是她失明的母亲，白天躲在阁楼，只在深夜摸索着下楼。');
  check('推理逻辑标签', blocks[0].reasoning, '线索是「只有敲门声、没有人影」加上「老宅有阁楼」。');
}

console.log('\n===== 一、解析器：标签单独成行 =====');
{
  const text = `最后一通电话
男子在电话里笑着对妻子说别担心。
汤底
他早已失明且身患绝症。
推理逻辑
笑着与坠楼并不矛盾。`;
  const blocks = KB.parseKnowledgeFile(text, 'b.txt');
  check('单独标签行切出 1 块', blocks.length, 1);
  check('单独标签行 → 汤底', blocks[0].bottom, '他早已失明且身患绝症。');
  check('单独标签行 → 推理逻辑', blocks[0].reasoning, '笑着与坠楼并不矛盾。');
  check('汤面只含标题之后的一行', blocks[0].face, '男子在电话里笑着对妻子说别担心。');
}

console.log('\n===== 一、解析器：标签误判防护 =====');
{
  check(
    '「真相就是没有人杀他。」不当标签',
    KB.matchFieldLabel('真相就是没有人杀他。'),
    null
  );
  check('「解析一下」不当标签', KB.matchFieldLabel('解析一下'), null);
  check('「汤底」单独成行当标签', KB.matchFieldLabel('汤底') !== null, true);
  check('「汤底：」带冒号当标签', KB.matchFieldLabel('汤底：') !== null, true);
  check('「思路：」带冒号当标签', KB.matchFieldLabel('思路：') !== null, true);
  check(
    '「汤底：他是被雪橇拉走的。」取到内容',
    KB.matchFieldLabel('汤底：他是被雪橇拉走的。').rest,
    '他是被雪橇拉走的。'
  );
}

console.log('\n===== 一、解析器：分隔线多题 =====');
{
  const text = `1. 谜泪
汤面：我在午夜听见窗外金属碰撞声。
汤底：是收废品的人在楼下拖动铁皮。
推理逻辑：声音位置在窗外，说明来源不在屋内。
====
2. 牧场
汤面：牧场主每天清晨都会数一遍羊。
汤底：他数的是自己的幻觉。
推理逻辑：重复计数说明他在确认不存在的数量。`;
  const blocks = KB.parseKnowledgeFile(text, 'c.txt');
  check('分隔线切出 2 块', blocks.length, 2);
  check('第 1 块题号前缀被剥离', blocks[0].title, '谜泪');
  check('第 2 块题号前缀被剥离', blocks[1].title, '牧场');
  check('第 2 块汤底正确', blocks[1].bottom, '他数的是自己的幻觉。');
}

console.log('\n===== 一、解析器：题号起始多题（无分隔线）=====');
{
  const text = `【1】空房间里的血滴
汤面：房间空无一物，地板中央有一滴血。
汤底：死者被吊在房梁上，血从脚底滴落。
【2】消失的第七个人
汤面：六个人围坐吃饭，桌上摆了七副碗筷。
汤底：第七个人是孩子的遗像。`;
  const blocks = KB.parseKnowledgeFile(text, 'd.txt');
  check('题号切出 2 块', blocks.length, 2);
  check('【】前缀被剥离', blocks[0].title, '空房间里的血滴');
  check('第 2 块标题', blocks[1].title, '消失的第七个人');
}

console.log('\n===== 一、解析器：stripNumberPrefix =====');
{
  check('「1. 谜泪」剥离题号', KB.stripNumberPrefix('1. 谜泪'), '谜泪');
  check('「第3题 宿舍」剥离题号', KB.stripNumberPrefix('第3题 宿舍'), '宿舍');
  check('「【2】牧场」剥离题号', KB.stripNumberPrefix('【2】牧场'), '牧场');
  check('无题号时原样保留', KB.stripNumberPrefix('雪夜里的脚印'), '雪夜里的脚印');
}

console.log('\n===== 二、边界 / 对抗输入 =====');

{
  check('空字符串 → 0 块', KB.parseKnowledgeFile('', 'x.txt').length, 0);
  check('纯空白 → 0 块', KB.parseKnowledgeFile('   \n\n  \t ', 'x.txt').length, 0);
  check('纯分隔线 → 0 块', KB.parseKnowledgeFile('====\n----\n', 'x.txt').length, 0);
}

{
  // 无结构散文本 > 1000 字 → 走兜底定长切分（不能只产出 1 块，否则整篇稀释成一个向量）
  const long = '这是一段没有任何结构的说明性长文，用于验证兜底切片路径。'.repeat(60); // ≈ 1560 字
  const blocks = KB.parseKnowledgeFile(long, 'notes.txt');
  ok('超长无结构文本走兜底切片（块数 > 1）', blocks.length > 1, `实际块数=${blocks.length}`);
  check('兜底块 kind = note', blocks[0].kind, 'note');
  ok('兜底块标题带文件名或续号', blocks[0].title.includes('notes'), `实际=${blocks[0].title}`);
}

{
  // 路径穿越文件名：文件名只作为元数据，绝不能被当作路径拼接
  const blocks = KB.parseKnowledgeFile('汤底\n随便一段内容。', '../../etc/passwd.txt');
  check('路径穿越文件名不影响解析', blocks.length, 1);
  const r = KB.ingestBlocks({ docId: 'doc-evil', filename: '../../etc/passwd.txt', blocks, operator: 'tester' });
  check('路径穿越文档入库 1 条', r.chunks, 1);
  const hits = chroma.query('haigui_kb', { queryText: '随便一段内容' });
  check('元数据里的文件名原样保留（不参与路径）', hits[0].meta.filename, '../../etc/passwd.txt');
  ok('未在向量库目录外写出任何文件', !fs.existsSync(path.join(TMP_DIR, '..', 'etc')), '');
  // 清掉这条对抗用例的向量，避免影响后面的计数断言
  check('清理对抗用例向量', KB.deleteByDocument('doc-evil'), 1);
  check('清理后知识库为空', KB.count(), 0);
}

{
  // 指纹：换行符差异必须识别为同一份内容
  const a = '汤底\n他是被雪橇拉走的。';
  const b = '汤底\r\n他是被雪橇拉走的。\r\n';
  check('CRLF 与 LF 指纹一致（去重生效）', KB.fingerprint(a), KB.fingerprint(b));
  check('不同内容指纹不同', KB.fingerprint(a) === KB.fingerprint('汤底\n别的。'), false);
}

/* ================================================================== *
 * 三、检索评测集
 * ================================================================== */
console.log('\n===== 三、检索评测集（24 条提问）=====');

// 6 道知识库题目，每题一个「上传文件」
const DOCS = [
  {
    name: '雪夜里的脚印.txt',
    text: `雪夜里的脚印
一个人在雪地里留下两排脚印，却没有往回走的痕迹。
汤底
他是被雪橇拉走的，回来的是雪橇，不是他的脚。
推理逻辑
关键在「只有两排脚印」而不是「四排」——说明他离开时不是走回来的，而是被交通工具带走的。`,
  },
  {
    name: '半夜的敲门声.txt',
    text: `半夜的敲门声
女子独自住在老宅，每晚十二点都会听见敲门声，开门却没有人。
汤底
敲门的是她失明的母亲，白天躲在阁楼，只在深夜摸索着下楼。
推理逻辑
线索是「只有敲门声、没有人影」加上「老宅有阁楼」，指向屋内还有第二个人。`,
  },
  {
    name: '最后一通电话.txt',
    text: `最后一通电话
男子在电话里笑着对妻子说别担心，随后坠楼身亡。
汤底
他早已失明且身患绝症，笑着是为了让妻子记住他开心的样子。
推理逻辑
笑着与坠楼并不矛盾，电话里的声音无法传递表情的真实原因。`,
  },
  {
    name: '空房间里的血滴.txt',
    text: `空房间里的血滴
房间空无一物，地板中央有一滴血，门窗从内部反锁。
汤底
死者被吊在房梁上，血从脚底滴落，房梁上有摩擦痕迹。
推理逻辑
反锁意味着没有外人进出，血滴落在地板中央指向垂直方向上的来源。`,
  },
  {
    name: '消失的第七个人.txt',
    text: `消失的第七个人
六个人围坐吃饭，桌上摆了七副碗筷。
汤底
第七个人是孩子的遗像，家人为纪念他仍摆着一副碗筷。
推理逻辑
多出的碗筷不是为活人准备的，指向已故家人的纪念仪式。`,
  },
  {
    name: '归来的渔船.txt',
    text: `归来的渔船
渔船清晨回港，船员都在，船长却不见了。
汤底
船长在夜里心脏病发作去世，船员按海上习俗把遗体冷藏运回港口。
推理逻辑
船员完好无损而船长失踪，说明船长并非被加害，而是自然死亡。`,
  },
];

// 逐文件入库（模拟管理页一次上传一个文件），并记录指纹去重
const md5Seen = new Set();
DOCS.forEach((d, i) => {
  const fp = KB.fingerprint(d.text);
  check(`【去重】${d.name} 首次入库指纹未重复`, md5Seen.has(fp), false);
  md5Seen.add(fp);
  const blocks = KB.parseKnowledgeFile(d.text, d.name);
  const r = KB.ingestBlocks({ docId: 'doc' + i, filename: d.name, blocks, operator: 'tester' });
  check(`【入库】${d.name} 块数 = 1`, r.blocks, 1);
  check(`【入库】${d.name} 向量条数 = 1`, r.chunks, 1);
});

// 重复上传同一份内容 → 指纹一致，调用方据此跳过（服务端行为）
{
  const dup = KB.fingerprint(DOCS[0].text);
  ok('【去重】重复上传第一个文件指纹一致', md5Seen.has(dup), '');
}

check('知识库向量总数 = 6', KB.count(), 6);

// 24 条提问：targetIdx 指向期望命中的文档下标
const CASES = [
  { q: '雪地里只有两排脚印，没有往回走的痕迹吗', target: 0 },
  { q: '他是被雪橇拉走的吗', target: 0 },
  { q: '雪橇回来的时候他还在上面吗', target: 0 },
  { q: '半夜十二点听见敲门声，开门却没有人', target: 1 },
  { q: '敲门声是失明的母亲弄出来的吗', target: 1 },
  { q: '老宅的阁楼里藏着人吗', target: 1 },
  { q: '男子在电话里笑着对妻子说别担心', target: 2 },
  { q: '他是不是早就失明而且身患绝症了', target: 2 },
  { q: '妻子在电话里听到的是真笑吗', target: 2 },
  { q: '空房间里地板中央有一滴血吗', target: 3 },
  { q: '门窗从内部反锁，说明没有外人进出吗', target: 3 },
  { q: '死者被吊在房梁上，血从脚底滴落吗', target: 3 },
  { q: '六个人围坐吃饭，桌上摆了七副碗筷', target: 4 },
  { q: '第七个人是孩子的遗像吗', target: 4 },
  { q: '多出来的碗筷是给已故家人准备的吗', target: 4 },
  { q: '渔船清晨回港，船员都在，船长却不见了', target: 5 },
  { q: '船长是心脏病发作去世的吗', target: 5 },
  { q: '船员把船长的遗体冷藏运回港口了吗', target: 5 },
  { q: '雪橇 脚印', target: 0 },
  { q: '敲门 阁楼 母亲', target: 1 },
  { q: '绝症 坠楼 电话', target: 2 },
  { q: '房梁 反锁 血滴', target: 3 },
  { q: '碗筷 遗像 纪念', target: 4 },
  { q: '渔船 船长 心脏病', target: 5 },
];

let hitTop1 = 0;
let hitTop3 = 0;
const missList = [];

CASES.forEach((c) => {
  const hits = KB.search(c.q, { n: 3 });
  const names = hits.map((h) => h.filename);
  const targetName = DOCS[c.target].name;
  const rank = names.indexOf(targetName);
  if (rank === 0) hitTop1++;
  if (rank >= 0 && rank < 3) hitTop3++;
  else missList.push(`「${c.q}」→ 期望 ${targetName}，实际前 3 = ${names.join(' / ') || '(无命中)'}`);
});

const top1Rate = hitTop1 / CASES.length;
const top3Rate = hitTop3 / CASES.length;
console.log(`  top-1 命中率：${(top1Rate * 100).toFixed(1)}%（${hitTop1}/${CASES.length}）`);
console.log(`  top-3 命中率：${(top3Rate * 100).toFixed(1)}%（${hitTop3}/${CASES.length}）`);

// 通过线：top-3 命中率 ≥ 80%（低于此值说明切片或门槛出了问题，必须先修再上线）
ok('检索 top-3 命中率 ≥ 80%', top3Rate >= 0.8, `实际 ${(top3Rate * 100).toFixed(1)}%`);
ok('检索 top-1 命中率 ≥ 60%', top1Rate >= 0.6, `实际 ${(top1Rate * 100).toFixed(1)}%`);

// 边界：空提问 / 超长提问 / 无关提问 都不能崩
{
  ok('空提问不抛异常', Array.isArray(KB.search('', { n: 3 })), '');
  ok('纯标点提问不抛异常', Array.isArray(KB.search('？？？', { n: 3 })), '');
  ok('超长提问不抛异常', Array.isArray(KB.search('雪橇'.repeat(1000), { n: 3 })), '');
  const far = KB.search('量子物理与黎曼猜想的关系', { n: 3 });
  ok('无关提问分数不超过 1', far.every((h) => h.score <= 1), JSON.stringify(far.map((h) => h.score)));
  ok('无关提问不会返回全部 6 条', far.length <= 3, `实际 ${far.length}`);
}

// 按文档删除：只删目标文档，其余不受影响
{
  const removed = KB.deleteByDocument('doc0');
  check('按文档删除返回条数 = 1', removed, 1);
  check('删除后总数 = 5', KB.count(), 5);
  const r = KB.parseKnowledgeFile(DOCS[0].text, DOCS[0].name);
  KB.ingestBlocks({ docId: 'doc0b', filename: '重新上传.txt', blocks: r, operator: 'tester' });
  check('重新入库后总数回到 6', KB.count(), 6);
}

// 上下文块渲染
{
  const hits = KB.search('雪橇 脚印', { n: 2 });
  const block = KB.buildContextBlock(hits, '海龟汤知识库参考');
  ok('参考块含标题「海龟汤知识库参考」', block.includes('海龟汤知识库参考'), block.slice(0, 80));
  ok('参考块含防泄露约束', block.includes('绝对不可'), '');
  ok('参考块含「以本题汤底为准」约束', block.includes('唯一事实来源'), '');
  check('无命中时返回空串', KB.buildContextBlock([], 'x'), '');
}

/* ================================================================== *
 * 收尾
 * ================================================================== */
try {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
} catch (e) { /* 清理失败不影响结论 */ }

console.log('\n----------------------------------------');
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`);
if (missList.length) {
  console.log(`\n检索未命中明细（${missList.length} 条）：`);
  missList.forEach((m) => console.log('  - ' + m));
}
if (failed > 0) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(`  - ${f.name}: 期望=${JSON.stringify(f.expected)} 实际=${JSON.stringify(f.actual)}`));
  process.exit(1);
}
console.log('全部通过');
