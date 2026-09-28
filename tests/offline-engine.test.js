/**
 * 离线引擎单测基线
 * 运行：npm test   （或 node tests/offline-engine.test.js）
 *
 * 作用：改动判定逻辑前先固化期望行为，改完跑一遍，
 *       确认「该答对的答对了、该兜底的没乱答」。
 */

const {
  offlineJudge,
  extractKeywords,
  isNoiseToken,
  splitClauses,
  splitSentences,
  clauseHasNegation,
  detectMixedPolarity,
  detectThemeQuestion,
  analyzeNegation,
  tokenize,
  canonicalize,
  conceptKeys,
  matchConcepts,
} = require('../offline-engine.js');

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

/** 断言判定结果：只比对 answer（必要时比对 reason） */
function judgeIs(name, args, expectedAnswer, expectedReason) {
  const r = offlineJudge(args.face, args.bottom, args.question, args.prev || 0, args.soupMeta);
  check(name, r.answer, expectedAnswer);
  if (expectedReason) {
    check(`${name} [reason]`, r.reason, expectedReason);
  }
  return r;
}

console.log('\n===== 一、关键词去噪（改动 1）=====');

// 虚词不该成为关键词
check('「因为」被判为噪音', isNoiseToken('因为'), true);
check('「所以」被判为噪音', isNoiseToken('所以'), true);
check('「这个」被判为噪音', isNoiseToken('这个'), true);
check('「死了」被判为噪音（了 是虚词字）', isNoiseToken('死了'), true);
check('「自杀」保留为实义词', isNoiseToken('自杀'), false);
check('「上吊」保留为实义词', isNoiseToken('上吊'), false);
check('「中毒」保留为实义词', isNoiseToken('中毒'), false);
check('「心脏病」保留为实义词', isNoiseToken('心脏病'), false);

const kws = extractKeywords('他因为心脏病突发死了，但没有留下遗书。');
const kwWords = kws.map((k) => k.w);
check('关键词不含「因为」', kwWords.includes('因为'), false);
check('关键词不含「没有」', kwWords.includes('没有'), false);
check('关键词含「心脏」', kwWords.includes('心脏'), true);
check('关键词含「遗书」', kwWords.includes('遗书'), true);
check('关键词按 score 降序', kws.every((k, i) => i === 0 || kws[i - 1].score >= k.score), true);

console.log('\n===== 二、噪音不再导致误判「是」（改动 1 的效果）=====');

// 这条在改动前会误判「是」：提问里的「因为/这是」命中了汤底的虚词 bigram
judgeIs(
  '提问只有虚词重合 → 不再误判「是」',
  {
    face: '他死了。',
    bottom: '他因为心脏病突发死亡。',
    question: '这是因为意外吗？',
  },
  '无关紧要'
);

// 对照：有真实关键词重合时，仍然要答「是」
judgeIs(
  '真实关键词重合 → 仍判「是」',
  {
    face: '他死了。',
    bottom: '他因为心脏病突发死亡。',
    question: '他是死于心脏病吗？',
  },
  '是'
);

console.log('\n===== 三、「是或不是」混合极性（改动 2）=====');

// 汤底：杀了妻子（肯定分句）+ 没杀孩子（否定分句）
// 提问同时问妻子和孩子 → 一部分对一部分错 → 「是或不是」
const mixedR = judgeIs(
  '同时命中肯定/否定分句 → 「是或不是」',
  {
    face: '一家三口只剩他活着。',
    bottom: '男子杀死了妻子。他没有杀孩子，孩子只是晕倒了。',
    question: '他把妻子和孩子都杀了吗？',
  },
  '是或不是',
  'mixed-polarity'
);
check('「是或不是」带出命中的分句', Array.isArray(mixedR.matched) && mixedR.matched.length >= 2, true);

// 只命中单条分句时不得触发「是或不是」
judgeIs(
  '只命中一条分句 → 不触发「是或不是」',
  {
    face: '一家三口只剩他活着。',
    bottom: '男子杀死了妻子。',
    question: '他杀了妻子吗？',
  },
  '是'
);

// 两条分句都命中、但极性相同（都肯定）→ 不该触发「是或不是」
judgeIs(
  '命中两条同极性分句 → 判「是」而非「是或不是」',
  {
    face: '现场很乱。',
    bottom: '他打碎了花瓶。他划破了沙发。',
    question: '他打碎了花瓶和沙发吗？',
  },
  '是'
);

// 只命中两条分句但都是否定 → 不触发「是或不是」；
// 且按改动 4 的极性对比，提问肯定 vs 汤底否定 → 应判「否」
// （改动 4 之前这里会错答「是」：汤底说没杀，问「杀了吗」却答是）
judgeIs(
  '命中两条否定分句 → 判「否」（改动 4 修正单向肯定）',
  {
    face: '一家三口都活着。',
    bottom: '他没有杀妻子。他也没有伤害孩子。',
    question: '他杀了妻子和孩子吗？',
  },
  '否'
);

console.log('\n===== 四、既有行为回归（必须保持不变）=====');

judgeIs('元信息：本格', {
  face: '他死了。',
  bottom: '他心脏病发作死了。',
  question: '这个汤是本格吗',
  soupMeta: { style: '本格' },
}, '是');

judgeIs('元信息：变格（含超自然词）', {
  face: '他回来了。',
  bottom: '他已经死了，回来的是他的灵魂。',
  question: '这个汤是本格吗',
  soupMeta: { style: '变格' },
}, '否');

judgeIs('元信息：红汤（含死亡词）', {
  face: '他死了。',
  bottom: '他被人杀害。',
  question: '这是红汤吗',
  soupMeta: { type: '红汤' },
}, '是');

judgeIs('开放式提问 → 无关紧要', {
  face: '他死了。',
  bottom: '他跳楼自杀。',
  question: '他为什么要这么做',
}, '无关紧要', 'open-question');

judgeIs('开放式提问带问号 → 无关紧要（不因句尾？误判是非题）', {
  face: '他死了。',
  bottom: '他跳楼自杀。',
  question: '他为什么要这么做？',
}, '无关紧要', 'open-question');

// —— 句尾疑问标记不影响判定（2026-09-28 修复）——
// 同一句话带不带问号，答案必须一致且正确
judgeIs('带/不带问号结果一致（带？）→ 是', {
  face: '一个牧场。',
  bottom: '这个牧场拥有特殊的能力。',
  question: '这个牧场是不是不是没有特殊的能力？',
}, '是');

judgeIs('带/不带问号结果一致（不带？）→ 是', {
  face: '一个牧场。',
  bottom: '这个牧场拥有特殊的能力。',
  question: '这个牧场是不是不是没有特殊的能力',
}, '是');

judgeIs('陈述式是非题（无任何疑问标记）→ 是', {
  face: '一个牧场。',
  bottom: '这个牧场拥有特殊的能力。',
  question: '这个牧场有特殊能力',
}, '是');

judgeIs('「是不是」封闭标记 → 非开放式（走判定层）', {
  face: '一个牧场。',
  bottom: '这个牧场没有特殊的能力。',
  question: '这个牧场是不是有特殊能力',
}, '否');

// 「不是……吗」是中文反问句，语气是肯定：汤底确实是自杀 → 应答「是」
// （改动 3 之前会被粗暴判成「否」，把玩家带偏）
judgeIs('反问句「不是……吗」→ 是（改动 3）', {
  face: '他死了。',
  bottom: '他跳楼自杀，当场身亡。',
  question: '他不是自杀的吗？',
}, '是');

// 真正的否定提问：汤底说没杀 → 「他没有杀妻子吗」应答「是」
judgeIs('否定提问 + 汤底否定 → 是', {
  face: '妻子没事。',
  bottom: '他没有杀妻子，妻子只是晕倒了。',
  question: '他没有杀妻子吗？',
}, '是');

// 真正的否定提问，但汤底是肯定 → 应答「否」（改动 4 的极性对比）
judgeIs('否定提问 + 汤底肯定 → 否（改动 4）', {
  face: '妻子死了。',
  bottom: '他杀死了妻子。',
  question: '他没有杀妻子吗？',
}, '否');

judgeIs('完全无关 → 无关紧要', {
  face: '他死了。',
  bottom: '他跳楼自杀，当场身亡。',
  question: '今天股票涨了吗？',
}, '无关紧要', 'no-overlap');

judgeIs('空提问 → 无关紧要', {
  face: '他死了。',
  bottom: '他跳楼自杀。',
  question: '   ',
}, '无关紧要', 'empty');

console.log('\n===== 四之二、改动 4：单向肯定修正 =====');

// 这是长期存在的错答：汤底明确说妈妈活下来，旧实现仍答「是」
judgeIs(
  '汤底否定 + 提问肯定 → 「否」（不再是「是」）',
  {
    face: '一家人都平安。',
    bottom: '妈妈没有死，她只是受了重伤，最后活了下来。',
    question: '妈妈死了吗？',
  },
  '否',
  'clause-negated'
);

// 反向：汤底肯定 + 提问肯定 → 仍是「是」
judgeIs(
  '汤底肯定 + 提问肯定 → 「是」',
  {
    face: '妈妈出事了。',
    bottom: '妈妈当场死亡，死因是车祸。',
    question: '妈妈死了吗？',
  },
  '是',
  'clause-affirmed'
);

console.log('\n===== 四之三、改动 3：双重否定与反问句 =====');

// 「不是没有 X」= 双重否定，语义是肯定 X。
// 旧实现只要见到「不/没」就判否 → 会答反成「否」
judgeIs(
  '双重否定「不是没有自杀」→ 按肯定处理',
  {
    face: '他死了。',
    bottom: '他是自杀的，不是意外。',
    question: '他不是没有自杀吗？',
  },
  '是'
);

judgeIs(
  '否定词在作用域外 → 不判否',
  {
    face: '现场很乱。',
    bottom: '他打碎了花瓶，还划破了沙发。',
    question: '不是我说，他打碎了花瓶吗？',
  },
  '是'
);

console.log('\n===== 四之四、主题问答：死人 / 灵异 =====');

// 改动前这些都答「无关紧要」——汤底写「死亡」，提问是「有人死吗」，字面永远对不上
const DEATH_FACE = '小强养了一只很忠诚的狗，今天他牵着狗上街，然后小强死了。为什么？';
const DEATH_BOTTOM = '小强这次上街突发心脏病，狗不让其他人靠近主人包括医生。耽误了治疗时间，导致了小强的死亡。';

judgeIs('故事里有人死了吗 → 是', {
  face: DEATH_FACE,
  bottom: DEATH_BOTTOM,
  question: '这个故事里有人死了吗？',
}, '是', 'theme-death');

judgeIs('有人死了吗（无标点）→ 是', {
  face: DEATH_FACE,
  bottom: DEATH_BOTTOM,
  question: '有人死了吗',
}, '是');

judgeIs('故事里有死人吗 → 是', {
  face: DEATH_FACE,
  bottom: DEATH_BOTTOM,
  question: '故事里有死人吗？',
}, '是');

judgeIs('这个汤有没有死人（开放式口吻）→ 是', {
  face: DEATH_FACE,
  bottom: DEATH_BOTTOM,
  question: '这个汤有没有死人',
}, '是');

judgeIs('清汤（无人死亡）问有人死吗 → 否', {
  face: '他丢了钱包。',
  bottom: '他把钱包忘在了出租车上，司机后来还给了他。',
  question: '这个故事里有人死了吗？',
}, '否', 'theme-death');

judgeIs('本格汤问是不是灵异 → 否', {
  face: DEATH_FACE,
  bottom: DEATH_BOTTOM,
  question: '这是灵异故事吗？',
}, '否');

judgeIs('变格汤（有灵魂）问是不是灵异 → 是', {
  face: '他死后第三天，家里又响起了他的脚步声。',
  bottom: '他已经死了，回来的是他的灵魂，因为还有心愿未了。',
  question: '这是灵异故事吗？',
}, '是');

console.log('\n===== 四之五、本格 / 变格 / 清红汤（元信息）=====');

judgeIs('本格汤问本格 → 是', {
  face: DEATH_FACE,
  bottom: DEATH_BOTTOM,
  question: '这个故事是本格吗？',
  soupMeta: { style: '本格' },
}, '是', 'meta-style');

judgeIs('本格汤问变格 → 否', {
  face: DEATH_FACE,
  bottom: DEATH_BOTTOM,
  question: '这个故事是变格吗？',
  soupMeta: { style: '本格' },
}, '否');

judgeIs('变格汤问本格 → 否（靠文本推断）', {
  face: '他死后第三天，家里又响起了他的脚步声。',
  bottom: '他已经死了，回来的是他的灵魂，因为还有心愿未了。',
  question: '这个故事是本格吗？',
  soupMeta: {},
}, '否');

judgeIs('红汤判定（汤底含死亡词）', {
  face: DEATH_FACE,
  bottom: DEATH_BOTTOM,
  question: '这是红汤吗？',
  soupMeta: {},
}, '是');

judgeIs('清汤判定（无死亡词）', {
  face: '他丢了钱包。',
  bottom: '他把钱包忘在了出租车上，司机后来还给了他。',
  question: '这是清汤吗？',
  soupMeta: {},
}, '是');

console.log('\n===== 四之六、改动 5：同义词归一（概念匹配）=====');

// 归一函数本身
check('「死亡」归一为 DEATH', canonicalize('他死亡了').includes('DEATH'), true);
check('「去世」归一为 DEATH', canonicalize('他去世了').includes('DEATH'), true);
check('「丈夫」归一为 PMALE', canonicalize('丈夫').includes('PMALE'), true);
check('「男子」归一为 PMALE', canonicalize('男子').includes('PMALE'), true);
// 长词优先：不能让「死」先把「死亡」拆坏
check('长词优先：死亡 → DEATH 而非 DEATHDEATH', canonicalize('死亡'), ' DEATH ');
check('概念抽取：丈夫+死亡', Array.from(conceptKeys('丈夫死亡')).sort().join(','), 'DEATH,PMALE');

// 核心 bug：汤底写「男子」，玩家问「丈夫」，字面永不对上
judgeIs(
  '「丈夫死了吗」vs 汤底「男子当场死亡」→ 是',
  {
    face: '一名男子死在自家客厅。',
    bottom: '男子在家中突发心脏病，当场死亡。',
    question: '丈夫死了吗？',
  },
  '是',
  'concept-clause-affirmed'
);

judgeIs(
  '「老公死了没」口吻（无吗）→ 仍是极性/概念判定',
  {
    face: '一名男子死在自家客厅。',
    bottom: '男子在家中突发心脏病，当场死亡。',
    question: '老公死了吗',
  },
  '是'
);

judgeIs(
  '「妻子自杀了吗」vs 汤底「女人服毒自尽」→ 是',
  {
    face: '一个女人死在浴室。',
    bottom: '那个女人不堪忍受病痛，服毒自尽。',
    question: '妻子是自杀的吗？',
  },
  '是'
);

// 汤底否定 + 提问肯定 → 必须答「否」，不能被同义词召回带偏成「是」
judgeIs(
  '汤底「妻子没有死」+ 问「老婆死了吗」→ 否',
  {
    face: '一家人都平安。',
    bottom: '妻子没有死，她只是受了重伤，最后活了下来。',
    question: '老婆死了吗？',
  },
  '否',
  'concept-clause-negated'
);

// 张冠李戴风险：汤底说男子杀了人，问「丈夫死了吗」不能答「是」
judgeIs(
  '只有人物对上、谓词对不上 → 不判是/否（防张冠李戴）',
  {
    face: '一名男子被捕。',
    bottom: '男子在争执中杀死了妻子，随后被警方逮捕。',
    question: '丈夫死了吗？',
  },
  '无关紧要',
  'concept-weak'
);

// 人物冲突：问孩子、汤底只讲男子 → 不能算命中（直接测闸门，避免被 bigram 层抢先）
check(
  '人物冲突闸门：问孩子 vs 汤底讲男子自杀 → 不匹配',
  matchConcepts('男子自杀了。', '孩子死了吗？'),
  null
);

judgeIs(
  '人物冲突（问孩子 vs 汤底讲男子）→ 兜底不判是',
  {
    face: '一名男子死在家中。',
    bottom: '男子自杀了。',
    question: '孩子死了吗？',
  },
  '无关紧要'
);

// 概念匹配也要能推进进度（强命中 +6，弱命中 +1）
const conceptStrong = offlineJudge(
  '一名男子死在自家客厅。',
  '男子在家中突发心脏病，当场死亡。',
  '丈夫死了吗？',
  20
);
check('概念强命中推进进度', conceptStrong.progress > 20, true);

const conceptWeak = offlineJudge(
  '一名男子被捕。',
  '男子杀死了妻子。',
  '丈夫死了吗？',
  20
);
check('概念弱命中只小幅推进（+1）', conceptWeak.progress, 21);

// matchConcepts 直接单测
const mcStrong = matchConcepts('男子当场死亡。', '丈夫死了吗？');
check('matchConcepts：强命中级别', mcStrong && mcStrong.level, 'predicate');
check('matchConcepts：无概念时返回 null', matchConcepts('他去了学校。', '今天股票涨了吗？'), null);

// 不指名的提问（他 / 她）：两侧都没人物概念时也要能答
judgeIs(
  '「他死了吗」vs 汤底「他已经死了，回来的是他的灵魂」→ 是',
  {
    face: '他死后第三天，家里又响起了他的脚步声。',
    bottom: '他已经死了，回来的是他的灵魂，因为还有心愿未了。',
    question: '他死了吗？',
  },
  '是'
);

// 自杀 ⇒ 死（概念蕴含）
judgeIs(
  '「他死了吗」vs 汤底「男子自杀了」（自杀蕴含死亡）→ 是',
  {
    face: '一名男子死在家中。',
    bottom: '男子愧疚自杀。',
    question: '他死了吗？',
  },
  '是'
);

// 动物主语兜底：不能把狗的死安到人身上
judgeIs(
  '汤底「小狗死了」+ 问「他死了吗」→ 不判是',
  {
    face: '他养了一只狗。',
    bottom: '小狗死了。',
    question: '他死了吗？',
  },
  '无关紧要'
);

// 故事里有多个角色时，不指名的提问有歧义 → 不判是
judgeIs(
  '汤底有两个角色（男子+妻子）+ 问「他死了吗」→ 不判是',
  {
    face: '一家三口只剩他活着。',
    bottom: '男子杀死了妻子。',
    question: '他死了吗？',
  },
  '无关紧要'
);

// 代词消解：多角色故事里「他/她」要能锁定到对应角色
const MULTI_ROLE = {
  face: '一名男子走进餐厅点了一份海龟汤，喝了一口后痛哭流涕，随后自杀了。为什么？',
  bottom: '男子年轻时遇海难，同伴死去。同伴的妻子后来告诉了他真相。他愧疚自杀。',
};
(function () {
  const r = offlineJudge(MULTI_ROLE.face, MULTI_ROLE.bottom, '他死了吗？', 0, {});
  check('多角色故事：「他死了吗」→ 是（代词消解）', r.answer, '是');
  const r2 = offlineJudge(MULTI_ROLE.face, MULTI_ROLE.bottom, '她死了吗？', 0, {});
  check('多角色故事：「她死了吗」→ 不判是（女性角色未死）', r2.answer, '无关紧要');
})();

console.log('\n===== 五、进度与兜底 =====');

const noHit = offlineJudge('他死了。', '他跳楼自杀。', '今天股票涨了吗？', 30);
check('无重合时进度不前进', noHit.progress, 30);

const hit = offlineJudge('他死了。', '他跳楼自杀，当场身亡。', '他是跳楼死的吗？', 30);
check('命中后进度前进', hit.progress > 30, true);
check('进度不超过 85 上限', hit.progress <= 85, true);

const monotone = offlineJudge('他死了。', '他跳楼自杀。', '今天股票涨了吗？', 80);
check('高进度时无重合不倒退', monotone.progress, 80);

console.log('\n===== 六、工具函数 =====');

check('分句：按句号切分', splitClauses('他杀了人。他没放火。').length, 2);
check('分句：空文本返回空数组', splitClauses('').length, 0);
check('整句切分：不切逗号', splitSentences('男子突发心脏病，当场死亡。').length, 1);

// 「不堪/不料」里的「不」不是否定断言，不能被拿来判否
check('「不堪忍受」不算否定', clauseHasNegation('那个女人不堪忍受病痛'), false);
check('「不料」不算否定', clauseHasNegation('他不料撞见了邻居'), false);
check('「没有杀」仍是真否定', clauseHasNegation('他没有杀妻子'), true);

const mpTokens = tokenize('他把妻子和孩子都杀了吗');
check(
  '混合极性检测：无汤底时返回 null',
  detectMixedPolarity('', mpTokens),
  null
);

console.log('\n----------------------------------------');
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(`  - ${f.name}: 期望=${f.expected} 实际=${f.actual}`));
  process.exit(1);
}
console.log('全部通过');
