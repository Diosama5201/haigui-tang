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

// 真·双重否定：两个否定语素叠加，语义上互相抵消 → 按肯定处理
// 例："他不是没有死吗" = 他死了（肯定）
const DOUBLE_NEG_PATTERNS = [
  '不是没有', '并非没有', '没有不', '不是不', '没不', '不能不',
  '未必不', '不无', '没有没', '并非不', '不是没', '未尝不',
];

/* ------------------------------------------------------------------ *
 * 虚词噪音词表（用于把「没有实义」的 bigram 从关键词里剔除）
 *
 * 背景：以前 extractKeywords 只要 bigram 出现过就收（c >= 1），
 * 导致「因为 / 所以 / 这个 / 但是」这类纯语法词也被当成实义词。
 * 后果是玩家提问里带一点常见虚词就会命中汤底 → 误判「是」。
 *
 * 取舍：宁可多滤（漏匹配 → 落到「无关紧要」），也不错留（误判「是」）。
 * 这与本项目「确定才答、拿不准诚实兜底」的既定策略一致。
 * ------------------------------------------------------------------ */

// 纯虚词字：bigram 中只要出现其一，通常整词不承载事实信息
const FUNCTION_CHARS = new Set('的了是在这那吧呢吗啦啊呀嘛呗咯喽其之乎者也而且则'.split(''));

// 常见虚词/连接词 bigram：整词无实义，必须整词排除
const FUNCTION_BIGRAMS = new Set([
  '因为', '所以', '但是', '然而', '如果', '那么', '已经', '曾经', '正在',
  '不是', '没有', '大概', '或许', '应该', '可以', '可能', '也许', '然后',
  '于是', '因此', '这个', '那个', '什么', '怎么', '为何', '是否', '接着',
  '并且', '而且', '虽然', '即使', '由于', '终于', '结果', '后来', '最后',
  '之后', '之前', '当时', '现在', '一直', '还是', '就是', '只是', '不过',
  '其实', '原来', '有着', '开始', '于是', '于是',
]);

/**
 * 判断一个词元是否是「无实义噪音」
 * - 单字：命中停用词
 * - bigram：整词在虚词表里，或任一字符是纯虚词字
 */
function isNoiseToken(w) {
  if (!w) return true;
  if (w.length === 1) return STOPWORDS.has(w);
  if (FUNCTION_BIGRAMS.has(w)) return true;
  for (const ch of w) {
    if (FUNCTION_CHARS.has(ch)) return true;
  }
  return false;
}

// 开放式提问特征（引导用户换成是非题）
const OPEN_WH = ['为什么', '为何', '怎么', '如何', '什么样', '谁', '什么', '哪', '多少', '请问', '解释', '描述', '讲一下'];

/* ------------------------------------------------------------------ *
 * 一、元信息问答（题目自身的属性，不来自汤底情节）
 *
 * 「这是本格吗」「是红汤吗」问的是**题目分类**，答案由题库字段决定，
 * 与汤底情节文本无关。若交给下面的 bigram 匹配，会因为「本格/红汤」
 * 这些字在汤底里根本不出现而一律答「无关紧要」——这是错的：
 * 主持人知道题目分类，必须如实回答。
 * ------------------------------------------------------------------ */

// 属性 → 提问中出现的判定词
const META_RULES = [
  {
    key: 'style',
    label: '本格/变格',
    // 顺序敏感：先匹配「本格」「变格」，避免子串互相干扰
    tokens: [
      { value: '本格', words: ['本格', '本格汤'] },
      { value: '变格', words: ['变格', '变格汤'] },
    ],
  },
  {
    key: 'type',
    label: '清汤/红汤',
    tokens: [
      // 只用分类术语本身。「有人死吗」这类是**情节提问**（问故事里死了没），
      // 必须走汤底文本匹配，不能拿题库的分类字段来答。
      { value: '红汤', words: ['红汤', '红汤汤', '红汤吗'] },
      { value: '清汤', words: ['清汤', '清汤汤', '清汤吗'] },
    ],
  },
];

// 元信息提问的语气特征：出现任一才算「在问题目分类」，避免误判情节提问
const META_MARKERS = ['这是', '这个', '这道', '本题', '题目', '是不是', '算不', '属于', '汤属于', '吗', '么', '?', '？'];

/**
 * 从提问中识别「在问哪一项题目属性、问的是哪个取值」
 * @returns {{key:string,label:string,value:string,word:string}|null}
 */
function detectMetaQuestion(question) {
  const q = String(question || '').trim();
  if (!q) return null;
  // 必须是问句口吻，否则视为普通情节提问
  if (!META_MARKERS.some((m) => q.includes(m))) return null;

  for (const rule of META_RULES) {
    for (const t of rule.tokens) {
      const hit = t.words.find((w) => q.includes(w));
      if (hit) return { key: rule.key, label: rule.label, value: t.value, word: hit };
    }
  }
  return null;
}

/**
 * 回答题目元信息提问（本格/变格、清汤/红汤）
 *
 * 判定依据（按优先级）：
 *   1) 题库 style / type 字段（权威——建题时就定好了）
 *   2) 无字段时按汤底文本推断（变格词表 / 死亡词表）
 *
 * 返回值与 offlineJudge 保持一致，reason 标记为 meta-* 便于排查。
 *
 * @param {{style?:string,type?:string,face?:string,bottom?:string}} soup 题目信息
 * @param {string} question 玩家提问
 * @param {number} prevProgress 历史进度
 * @param {{key:string,label:string,value:string,word:string}} meta detectMetaQuestion 的结果
 */
function answerMetaQuestion(soup, question, prevProgress, meta) {
  const prev = Math.max(0, Math.min(100, Number(prevProgress) || 0));
  const src = soup || {};

  // —— 判定实际取值：字段优先，其次文本推断 ——
  let actual = null;
  let source = '';

  if (meta.key === 'style') {
    const s = String(src.style || '').trim();
    if (s === '本格' || s === '变格') {
      actual = s;
      source = 'field';
    } else {
      actual = inferStyleFromText(src.face, src.bottom);
      source = actual ? 'inferred' : 'unknown';
    }
  } else {
    const t = String(src.type || '').trim();
    if (t === '清汤' || t === '红汤') {
      actual = t;
      source = 'field';
    } else {
      actual = inferTypeFromText(src.face, src.bottom);
      source = actual ? 'inferred' : 'unknown';
    }
  }

  // 属性未知：诚实兜底，不瞎猜
  if (!actual) {
    return { answer: '无关紧要', progress: prev, reason: 'meta-unknown', matched: [] };
  }

  const same = actual === meta.value;
  // 元信息是「开局就该知道的范围界定」，但不算情节推进：进度只给象征性 +2
  const newProgress = Math.min(85, prev + 2);
  return {
    answer: same ? '是' : '否',
    progress: newProgress,
    reason: 'meta-' + meta.key + (source === 'inferred' ? '-inferred' : ''),
    matched: [meta.word, actual],
    meta: { key: meta.key, asked: meta.value, actual },
  };
}

// 变格（超自然）词表：命中任一 → 判变格
const SUPERNATURAL_WORDS = [
  '鬼', '幽灵', '灵魂', '魂魄', '亡灵', '阴魂', '附身', '转世', '投胎', '轮回', '前世',
  '超能力', '异能', '特异功能', '意念', '预知', '预言', '占卜', '诅咒', '巫术', '魔法',
  '妖怪', '魔鬼', '恶魔', '神明', '神仙', '天使', '外星', '飞船', '时空', '穿越', '平行世界',
  '克隆', '机器人', '人工智能觉醒', '丧尸', '僵尸', '吸血鬼', '狼人', '人鱼', '精灵',
  '长生不老', '复活', '不死', '幻觉成真', '梦游杀人',
];

/** 按汤面+汤底文本推断本格/变格（无 style 字段时的降级路径） */
function inferStyleFromText(face, bottom) {
  const text = String(face || '') + '\n' + String(bottom || '');
  if (!text.trim()) return null;
  // 只有命中超自然元素才判变格；否则一律本格
  // （海龟汤的「本格」就是特指「现实里会发生的事」，不出现超自然即本格）
  return SUPERNATURAL_WORDS.some((w) => text.includes(w)) ? '变格' : '本格';
}

// 死亡 / 血腥词表：命中 → 红汤
const DEATH_WORDS = [
  '死', '尸体', '遗骸', '遗书', '自杀', '他杀', '谋杀', '凶杀', '杀死', '杀害', '杀', '屠',
  '血', '鲜血', '血迹', '流血', '伤口', '重伤', '致命', '车祸', '坠楼', '跳楼', '溺',
  '上吊', '服毒', '中毒', '枪杀', '枪击', '刀伤', '解剖', '分尸', '肢解', '吃人', '殡',
  '葬礼', '墓地', '坟墓', '棺', '火化', '丧生', '遇难', '身亡', '去世', '毙命',
];

/** 按汤面+汤底文本推断清汤/红汤（无 type 字段时的降级路径） */
function inferTypeFromText(face, bottom) {
  const text = String(face || '') + '\n' + String(bottom || '');
  if (!text.trim()) return null;
  return DEATH_WORDS.some((w) => text.includes(w)) ? '红汤' : '清汤';
}

/* ------------------------------------------------------------------ *
 * 二之二、主题问答（故事层面的属性，如「有没有死人」「是不是灵异」）
 *
 * 与「元信息」的区别：
 *   - 元信息问的是**题目分类字段**（本格/变格、清汤/红汤），由题库字段或分类词表决定
 *   - 主题问的是**故事内容是否涉及某类要素**（死人、灵异），由汤面+汤底文本决定
 *
 * 为什么必须单独一层：玩家常问「这个故事里有人死了吗？」，
 * 但汤底写的是「死亡」「身亡」，提问的 bigram 是「有人」「人死」「死人」，
 * 字面根本对不上，走 bigram 匹配只会落到「无关紧要」——这是真 bug。
 * 主持人显然知道故事里死没死人，必须如实回答。
 * ------------------------------------------------------------------ */

const THEME_RULES = [
  {
    key: 'death',
    label: '是否死人',
    // 泛指特征：必须是「有没有人死」这类泛指。
    // 注意：不能收录「死了吗」——那是**指名问某个人**（如「妈妈死了吗」），
    // 属于情节提问，必须走下面的分句极性对比，否则会被主题层抢答错。
    patterns: ['有人死', '死人', '死了人', '有没有死', '有人死亡', '有没有人死', '死过人', '有人丧生', '有人没命', '有人遇难'],
    words: DEATH_WORDS,
  },
  {
    key: 'supernatural',
    label: '是否灵异/超自然',
    patterns: ['灵异', '有鬼', '闹鬼', '鬼魂', '超自然', '不科学', '有怪物', '有妖'],
    words: SUPERNATURAL_WORDS,
  },
];

/** 识别提问是否在问某个「故事主题」 */
function detectThemeQuestion(question) {
  const q = String(question || '').trim();
  if (!q) return null;
  for (const rule of THEME_RULES) {
    const hit = rule.patterns.find((p) => q.includes(p));
    if (hit) return { key: rule.key, label: rule.label, word: hit, words: rule.words };
  }
  return null;
}

/** 回答主题提问：按汤面+汤底是否出现该类要素词判定 */
function answerThemeQuestion(face, bottom, theme, prevProgress) {
  const prev = Math.max(0, Math.min(100, Number(prevProgress) || 0));
  const text = String(face || '') + '\n' + String(bottom || '');
  const has = theme.words.some((w) => text.includes(w));
  return {
    answer: has ? '是' : '否',
    progress: Math.min(85, prev + 2),
    reason: 'theme-' + theme.key,
    matched: [],
    theme: { key: theme.key, label: theme.label },
  };
}

/* ------------------------------------------------------------------ *
 * 二之三、同义词归一（改动 5）
 *
 * 目的：汤底写「男子……死亡」，玩家问「丈夫死了吗」，纯字面 bigram 永远对不上。
 *
 * 分两级，是为了控制「张冠李戴」的风险——同义词在提高命中率的同时也会提高错答率，
 * 而本项目宁可诚实兜底也不错答：
 *   ① 谓词级（强）：死亡/杀害/自杀/疾病/医生/警察/车辆…严格等价，命中后可判是/否
 *   ② 人物级（弱）：丈夫≈男子、妻子≈女人…只是「可能同一人」，
 *      命中后**不判是/否**，只按「方向相关」处理（无关紧要 + 进度小幅 +1）
 *
 * 这样既召回了「丈夫死了吗」这类问法，又不会出现
 * 「汤底说男子杀了人、玩家问丈夫死了吗 → 答是」这种错误。
 * ------------------------------------------------------------------ */

const PREDICATE_GROUPS = [
  { key: 'DEATH', words: ['死亡', '去世', '过世', '身亡', '逝世', '丧生', '断气', '没命', '遇难', '毙命', '死掉', '死去', '死'] },
  { key: 'KILL', words: ['杀害', '杀死', '谋杀', '凶杀', '毒死', '掐死', '捅死', '干掉', '杀'] },
  { key: 'SUICIDE', words: ['自杀', '自尽', '轻生', '寻短见', '自刎'] },
  { key: 'ILLNESS', words: ['心脏病', '疾病', '急病', '发病', '病症', '中风', '癌症'] },
  { key: 'DOCTOR', words: ['医生', '大夫', '医师', '护士', '救护车', '急救'] },
  { key: 'POLICE', words: ['警察', '警方', '公安', '刑警', '警员'] },
  { key: 'CAR', words: ['出租车', '计程车', '汽车', '轿车', '货车', '卡车', '巴士', '公交', '的士', '车'] },
];

const PERSON_GROUPS = [
  { key: 'PMALE', words: ['丈夫', '老公', '先生', '男友', '男子', '男人'] },
  { key: 'PFEMALE', words: ['妻子', '老婆', '太太', '夫人', '女友', '女子', '女人'] },
  { key: 'PCHILD', words: ['孩子', '小孩', '儿子', '女儿'] },
];

const PREDICATE_KEYS = new Set(PREDICATE_GROUPS.map((g) => g.key));
const PERSON_KEYS = new Set(PERSON_GROUPS.map((g) => g.key));

/**
 * 动物主语：用于「提问没指名是谁」时的风险兜底
 *
 * 汤底「小狗死了」+ 提问「他死了吗」——两侧都没有人物概念，
 * 若只凭谓词 DEATH 相同就判「是」，就把狗的死安到了人身上。
 * 句里出现动物词时，不指名的提问一律不判强命中。
 */
const ANIMAL_WORDS = ['狗', '猫', '鸟', '鱼', '龟', '鸡', '鸭', '鹅', '猪', '牛', '羊', '马', '鼠', '兔', '蛇', '虎', '狼', '宠物'];
const ANIMAL_RE = new RegExp(ANIMAL_WORDS.join('|'));

/**
 * 代词消解：把提问里的「他 / 她」落到具体人物概念上
 *
 * 玩家最常问的就是「他死了吗」——不指名。若不做消解，
 * 只要故事里出现两个以上角色，就永远只能答「无关紧要」。
 *
 * 「它」专指动物/物件，明确不是人 → 返回 null，不参与人物匹配。
 */
const PRONOUN_GUARD = ['其他', '其它', '他人', '他乡', '吉他', '他俩', '其他'];
const PRONOUN_GUARD_RE = new RegExp(PRONOUN_GUARD.join('|'), 'g');

function pronounPerson(question) {
  const q = String(question || '').replace(PRONOUN_GUARD_RE, '');
  if (q.includes('她')) return 'PFEMALE';
  if (q.includes('它')) return null; // 不是人
  if (q.includes('他')) return 'PMALE';
  return null;
}

// 替换表：长词优先，避免「死」先把「死亡」拆坏
const SYNONYM_PAIRS = PREDICATE_GROUPS.concat(PERSON_GROUPS)
  .flatMap((g) => g.words.map((w) => ({ w, key: g.key })))
  .sort((a, b) => b.w.length - a.w.length);

/**
 * 把文本里的同义词替换成统一的概念标记（如 死亡/去世/死 → DEATH）
 *
 * 替换时两侧补空格：否则「男子死亡」会变成「PMALEDEATH」，
 * 被 tokenize 的英文规则当成**一个**词元，概念就抓不出来了。
 */
function canonicalize(text) {
  let t = String(text || '');
  for (const { w, key } of SYNONYM_PAIRS) {
    if (t.indexOf(w) !== -1) t = t.split(w).join(' ' + key + ' ');
  }
  return t;
}

/** 归一后分词（概念标记是 ASCII，会被 tokenize 的英文规则捕获） */
function canonicalTokens(text) {
  return tokenize(canonicalize(text));
}

// 概念标记抽取：\b 保证整词匹配，避免 CAR 之类短键误命中
const CONCEPT_KEY_RE = new RegExp(
  '\\b(' + Array.from(new Set(PREDICATE_GROUPS.concat(PERSON_GROUPS).map((g) => g.key))).join('|') + ')\\b',
  'g'
);

/**
 * 概念蕴含：出现前者时，后者也一定成立
 *
 * 只收录「必然成立」的蕴含，绝不收录「可能成立」的：
 *   SUICIDE ⇒ DEATH（自杀了就一定死了）
 *   KILL  ✗ DEATH（杀人未必致死，还有未遂 / 抢救回来）
 */
const CONCEPT_IMPLIES = { SUICIDE: 'DEATH' };

/** 抽取文本（归一后）里出现的概念标记集合 */
function conceptKeys(text) {
  const set = new Set(canonicalize(text).match(CONCEPT_KEY_RE) || []);
  for (const from of Object.keys(CONCEPT_IMPLIES)) {
    if (set.has(from)) set.add(CONCEPT_IMPLIES[from]);
  }
  return set;
}

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

/**
 * 从汤底抽取关键实义词
 *
 * 相比旧版的两点改进：
 *   1) 去噪：剔除虚词 bigram（见 isNoiseToken），避免误判「是」
 *   2) 加权：按「出现次数 × 字符罕见度」排序——字符在汤底里越少见，
 *      该词元越可能是区分性事实（低频长尾优先），比单纯按次数排序更能突出关键线索
 *
 * @returns {Array<{w:string,c:number,score:number}>} 按 score 降序
 */
function extractKeywords(bottom) {
  const map = tokenize(bottom);
  const text = String(bottom || '');

  // 字符在汤底中的出现次数，用于算罕见度
  const charFreq = new Map();
  for (const ch of text) charFreq.set(ch, (charFreq.get(ch) || 0) + 1);

  const words = [];
  for (const [w, c] of map) {
    if (isNoiseToken(w)) continue;
    // 罕见度：每个字符出现次数的倒数之和（出现越少 → 越罕见 → 越有区分度）
    let rarity = 0;
    for (const ch of w) rarity += 1 / (charFreq.get(ch) || 1);
    words.push({ w, c, score: c * rarity });
  }
  return words.sort((a, b) => b.score - a.score || b.c - a.c);
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

/** 把汤底按标点切成「事实分句」——一条分句大致对应一个事实断言 */
function splitClauses(text) {
  return String(text || '')
    .split(/[。！？；;!?\n\r]+|[,，、]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 含「不/没/未」但**并不表达否定断言**的常见词组
 *
 * 例：「不堪忍受病痛」断言的是「她确实在承受痛苦」，不是「某事没发生」。
 * 若不剔除，「不堪 / 不料 / 不仅」里的「不」会被误当成否定，
 * 导致玩家问「她是自杀的吗」时答成「否」——把游戏带反。
 */
const NEG_EXCEPTIONS = [
  '不堪', '不料', '不仅', '不但', '不管', '不过', '不如', '不禁', '不至于',
  '不得不', '不巧', '不愧', '不外乎', '无形中', '无声', '无端', '无非',
  '无不', '未免', '未必', '未料',
];
const NEG_EXCEPTION_RE = new RegExp(NEG_EXCEPTIONS.join('|'), 'g');

/** 分句是否含否定（该分句表达的是「没发生 / 不成立」） */
function clauseHasNegation(clause) {
  const c = String(clause || '').replace(NEG_EXCEPTION_RE, '');
  return NEG_WORDS.some((w) => c.includes(w));
}

/**
 * 收集「提问命中了哪些汤底分句」，并给出每条分句的极性与匹配强度
 *
 * score = 该分句与提问重合的关键词个数。加这个字段是为了避免误判：
 * 两条分句可能只是共享同一个实体（比如都提到「妻子」），
 * 但真正被问到的只有其中一条——这时不能算「一部分对一部分错」。
 */
function collectClauseHits(bottom, qTokens) {
  const clauses = splitClauses(bottom);
  const hits = [];
  for (const clause of clauses) {
    const kws = extractKeywords(clause);
    const words = kws.filter(({ w }) => qTokens.has(w)).map(({ w }) => w);
    if (words.length > 0) {
      hits.push({ clause, neg: clauseHasNegation(clause), score: words.length, words });
    }
  }
  return hits;
}

/**
 * 按「句」切分（只认句号类标点，不切逗号）
 *
 * 与 splitClauses 的区别：splitClauses 连逗号也切，适合改动手法的分句极性对比；
 * 但概念匹配需要「一个句子 = 一个完整事实」，若把
 *   「男子在家中突发心脏病，当场死亡」
 * 切成两半，前半只有 {PMALE, ILLNESS}、后半只有 {DEATH}，
 * 人物和谓词就永远凑不到同一条里，同义词召回会失效。
 */
function splitSentences(text) {
  return String(text || '')
    .split(/[。！？；;!?\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 取匹配强度最高的若干条分句（并列时全部返回） */
function topClauseHits(hits) {
  if (hits.length === 0) return [];
  const max = Math.max.apply(null, hits.map((h) => h.score));
  return hits.filter((h) => h.score === max);
}

/**
 * 检测「混合极性」：提问同时命中多条汤底分句，且这些分句极性相反
 * （有的含否定、有的不含）→ 说明提问里一部分成立、一部分不成立，
 * 这正是海龟汤的合法回答「是或不是」。
 *
 * @returns {{matched:string[]}|null} 命中且极性混合时返回命中的分句，否则 null
 */
function detectMixedPolarity(bottom, qTokens) {
  const hitClauses = collectClauseHits(bottom, qTokens);
  if (hitClauses.length < 2) return null;
  // 只看「匹配强度并列最强」的分句：并列且极性相反才算真的混合
  const top = topClauseHits(hitClauses);
  if (top.length < 2) return null;
  const hasPositive = top.some((x) => !x.neg);
  const hasNegative = top.some((x) => x.neg);
  if (!(hasPositive && hasNegative)) return null;
  return { matched: top.map((x) => x.clause) };
}

/** 找出提问中第一个否定词及其位置 */
function firstNegation(question) {
  const q = String(question || '');
  let best = null;
  for (const w of NEG_WORDS) {
    const idx = q.indexOf(w);
    if (idx !== -1 && (!best || idx < best.idx)) best = { w, idx };
  }
  return best;
}

/**
 * 分析提问的否定语义（改动 3）
 *
 * 旧实现只要句中出现「不/没」就整句判否，导致两类错误：
 *   1. 双重否定："他不是没有死吗" 实际是肯定 → 旧实现答反
 *   2. 反问句："他不是自杀的吗？" 是肯定语气的反问 → 旧实现答反
 *   3. 否定词与命中实体无关时，也被拿来判否
 *
 * 现在的判定顺序：
 *   双重否定 → 抵消为肯定
 *   反问句（不是……吗/么/？）→ 肯定
 *   单否定 → 仅当否定词「紧邻」命中的词元时才算否定（作用域）
 *
 * @returns {{neg:boolean, kind:string}} neg 为规范化后提问是否带否定
 */
function analyzeNegation(question, matchedTokens, requireScope) {
  const q = String(question || '').trim();
  // requireScope 默认 true：概念匹配（改动 5）时命中的是概念标记（如 DEATH），
  // 在原文里找不到位置，因此那条路径传 false，只做整句判断
  const needScope = requireScope !== false;
  if (!q) return { neg: false, kind: 'none' };

  if (DOUBLE_NEG_PATTERNS.some((p) => q.includes(p))) {
    return { neg: false, kind: 'double-negation' };
  }
  // 反问句「不是……吗 / 不是……么 / 不是……？」：语气是肯定
  if (/不是/.test(q) && /[吗么？?]\s*$/.test(q)) {
    return { neg: false, kind: 'rhetorical' };
  }

  const hit = firstNegation(q);
  if (!hit) return { neg: false, kind: 'none' };

  if (!needScope) return { neg: true, kind: 'negated-unscoped' };

  // 作用域：否定词必须紧邻（前后 3 字内）某个命中的词元
  const scoped = (matchedTokens || []).some((w) => {
    const i = q.indexOf(w);
    return i !== -1 && Math.abs(i - hit.idx) <= 3 + w.length;
  });
  return scoped ? { neg: true, kind: 'negated' } : { neg: false, kind: 'out-of-scope' };
}

/**
 * 同义词概念匹配（改动 5 的核心）
 *
 * 在字面 bigram 完全对不上时，退一步比「概念」：
 *   汤底「男子当场死亡」 vs 提问「丈夫死了吗」
 *   → 归一后都是 {PMALE, DEATH} → 命中
 *
 * 分两级返回，是刻意的风险控制：
 *   - level='predicate'（强）：人物概念 + 谓词概念**同时**对得上
 *     → 可信度足够，可以判 是/否（再按分句极性取反）
 *   - level='person'（弱）：只对了人物、或只对了谓词
 *     → 可能是张冠李戴（如汤底「男子杀了人」vs 问「丈夫死了吗」），
 *       **不判是/否**，只按「方向相关」处理
 *
 * 另设「人物冲突」闸门：提问指名了某一类人而该分句讲的是另一类人时，
 * 一律不判强命中（例如问「孩子死了吗」、分句讲「男子自杀」）。
 *
 * @returns {{level:string,clause:string,keys:string[],neg?:boolean}|null}
 */
function matchConcepts(bottom, question) {
  const qs = conceptKeys(question);
  if (qs.size === 0) return null;

  const qPreds = Array.from(qs).filter((k) => PREDICATE_KEYS.has(k));
  const qPersons = Array.from(qs).filter((k) => PERSON_KEYS.has(k));
  // 提问没点名但有代词时，用代词把「他/她」落到具体角色上
  const pronoun = pronounPerson(question);
  if (qPersons.length === 0 && pronoun) qPersons.push(pronoun);
  if (qPreds.length === 0 && qPersons.length === 0) return null;

  // 汤底里出现的全部人物概念：整个故事只有一个角色时，
  // 不指名的提问（他 / 她 / 这个人）才没有歧义
  const allPersons = new Set();
  for (const s of splitSentences(bottom)) {
    for (const k of conceptKeys(s)) if (PERSON_KEYS.has(k)) allPersons.add(k);
  }

  let strong = null;
  let weak = null;

  // 用「句」而非「逗号分句」：一个句子才是一个完整事实，
  // 否则「男子…心脏病，当场死亡」会被拆开，人物与谓词凑不到一起
  for (const clause of splitSentences(bottom)) {
    const cs = conceptKeys(clause);
    if (cs.size === 0) continue;

    const sharedPreds = qPreds.filter((k) => cs.has(k));
    const sharedPersons = qPersons.filter((k) => cs.has(k));
    const clausePersons = Array.from(cs).filter((k) => PERSON_KEYS.has(k));

    // 人物冲突：问的是 A 类人，这条分句只讲 B 类人 → 不是同一件事
    const personConflict = qPersons.length > 0 && clausePersons.length > 0 && sharedPersons.length === 0;
    if (personConflict) continue;

    // 人物这一维是否「对得上」——三种组合分别判断
    let personOk;
    if (clausePersons.length === 0) {
      // 该句没点名任何人：只有「全篇也从未点名任何人」时才无歧义，且要排除动物主语
      // （否则「小狗死了」+「他死了吗」会把狗的死安到人身上）
      personOk = allPersons.size === 0 && !ANIMAL_RE.test(clause);
    } else if (qPersons.length === 0) {
      // 提问完全没指名（也没代词）、句子点名了：全篇只有一个角色时才无歧义
      personOk = allPersons.size === 1;
    } else {
      // 两边都指名了：必须是同一类人
      personOk = sharedPersons.length > 0;
    }

    if (personOk && sharedPreds.length > 0) {
      if (!strong) strong = { clause, keys: sharedPersons.concat(sharedPreds), neg: clauseHasNegation(clause) };
      continue;
    }
    const keys = sharedPreds.concat(sharedPersons);
    if (keys.length > 0 && !weak) weak = { clause, keys };
  }

  if (strong) return Object.assign({ level: 'predicate' }, strong);
  if (weak) return Object.assign({ level: 'person' }, weak);
  return null;
}

/**
 * 离线判定：返回 { answer, progress, reason, matched }
 * @param {string} face 汤面
 * @param {string} bottom 汤底
 * @param {string} question 玩家提问
 * @param {number} prevProgress 历史累计进度（0~100）
 * @param {{style?:string,type?:string}} [soupMeta] 题目分类字段（本格/变格、清汤/红汤）
 *
 * 判定策略（保守——确定才答，拿不准兜底）：
 *   - 问题目分类（本格/变格、清汤/红汤）→ 按题库字段如实回答，**不套用情节匹配**
 *   - 提问与汤底存在「实义 bigram 词元」重合 → 相关
 *   - 相关且命中多条分句、且分句极性相反 → 「是或不是」（一部分对、一部分错）
 *   - 相关且带否定 → 否；相关且无否定 → 是
 *   - 字面完全对不上时，用同义词归一做概念匹配（改动 5）：
 *       人物+谓词都对得上 → 是/否；只对了其一 → 无关紧要 + 进度 +1
 *   - 仅单字兜底重合（方向对但无法确认）→ 无关紧要，但进度小幅 +1（表示在探索正确方向）
 *   - 完全无重合 → 无关紧要，进度不变
 *   - 开放式提问 → 无关紧要
 */
function offlineJudge(face, bottom, question, prevProgress, soupMeta) {
  const q = String(question || '').trim();
  const prev = Math.max(0, Math.min(100, Number(prevProgress) || 0));

  if (!q) return { answer: '无关紧要', progress: prev, reason: 'empty' };

  // 0) 元信息提问（本格/变格、清汤/红汤）：答案由题库字段决定，与汤底情节无关。
  //    必须放在 isOpenQuestion / bigram 匹配【之前】：
  //      - 「这个汤是不是本格」结尾不是「吗」，会被 isOpenQuestion 误判成开放式提问；
  //      - 「本格/红汤」这些字在汤底里不出现，会被 bigram 匹配误判成「无关紧要」。
  //    题目分类是主持人掌握的事实，这类提问永远可答。
  const meta = detectMetaQuestion(q);
  if (meta) {
    const soup = Object.assign({ face, bottom }, soupMeta || {});
    return answerMetaQuestion(soup, q, prev, meta);
  }

  // 0.5) 主题提问（有没有死人 / 是不是灵异）：答案由汤面+汤底是否出现该类要素决定。
  //      必须放在 isOpenQuestion 之前——「故事里有没有死人」不以「吗」结尾，
  //      会被误判成开放式提问。
  const theme = detectThemeQuestion(q);
  if (theme) {
    return answerThemeQuestion(face, String(bottom || ''), theme, prev);
  }

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

  // 改动 3：规范化后的否定语义（已处理双重否定、反问句、作用域）
  const negInfo = analyzeNegation(q, matched);
  const neg = negInfo.neg;

  if (hitCount > 0) {
    const clauseHits = collectClauseHits(bottomText, qTokens);

    if (clauseHits.length >= 1) {
      // 只看匹配强度并列最强的分句
      const top = topClauseHits(clauseHits);

      // 1) 并列最强且极性相反 → 一部分成立一部分不成立 → 「是或不是」
      //    用词与 server.js 中大模型 prompt / answer 白名单保持一致（是/否/无关紧要/是或不是）
      if (top.length >= 2) {
        const hasPos = top.some((x) => !x.neg);
        const hasNeg = top.some((x) => x.neg);
        if (hasPos && hasNeg) {
          return {
            answer: '是或不是',
            progress: Math.min(85, prev + Math.max(4, hitCount * 3)),
            reason: 'mixed-polarity',
            matched: top.map((x) => x.clause).slice(0, 8),
          };
        }
      }

      // 2) 极性对比（改动 4）：
      //    把「提问断言的极性」和「汤底分句的极性」做比较——
      //      同极性 → 是；反极性 → 否
      //    这修掉了长期存在的单向肯定 bug：
      //      汤底写「妈妈没有死，她活下来了」，问「妈妈死了吗」旧实现答「是」（错）。
      const cNeg = top[0].neg;
      const answer = neg === cNeg ? '是' : '否';
      return {
        answer,
        progress: Math.min(85, prev + Math.max(4, hitCount * 4)),
        reason: cNeg ? 'clause-negated' : 'clause-affirmed',
        matched,
        negation: negInfo.kind,
      };
    }

    // 3) 关键词没落到任何分句（例如跨标点拼接出的词元）→ 退回按整句否定判定
    const answer = neg ? '否' : '是';
    const newProgress = Math.min(85, prev + Math.max(4, hitCount * 4));
    return { answer, progress: newProgress, reason: 'match', matched, negation: negInfo.kind };
  }

  // 2) 同义词归一后的概念匹配（改动 5）
  //    字面 bigram 落空时，改用「概念」比对：
  //    汤底「男子当场死亡」vs 提问「丈夫死了吗」→ 归一后都是 {PMALE, DEATH} → 可答。
  //    这里只处理字面完全对不上的情况，命中 bigram 的走上面更精确的分句逻辑。
  // 汤面也是事实（海龟汤的汤面写的都是真事），一并参与概念匹配：
  // 「他死后第三天…」这种把死亡写在汤面里的题，问「他死了吗」才有得可答。
  const concept = matchConcepts(String(face || '') + '\n' + bottomText, q);
  if (concept) {
    if (concept.level === 'predicate') {
      // 强命中：人物 + 谓词都对得上 → 按分句极性判 是/否
      const negInfo2 = analyzeNegation(q, null, false);
      const same = negInfo2.neg === concept.neg;
      return {
        answer: same ? '是' : '否',
        progress: Math.min(85, prev + 6),
        reason: concept.neg ? 'concept-clause-negated' : 'concept-clause-affirmed',
        matched: concept.keys,
        negation: negInfo2.kind,
      };
    }
    // 弱命中：只对了人物或只对了谓词 → 可能是张冠李戴，诚实兜底 + 方向性 +1
    return {
      answer: '无关紧要',
      progress: Math.min(85, prev + 1),
      reason: 'concept-weak',
      matched: concept.keys,
    };
  }

  // 3) 单字兜底：提问里的实字在汤底出现较多 → 方向对但无法确认具体事实
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

  // 4) 完全无重合
  return { answer: '无关紧要', progress: prev, reason: 'no-overlap' };
}

module.exports = {
  offlineJudge,
  extractKeywords,
  tokenize,
  isOpenQuestion,
  hasNegation,
  // 关键词去噪（改动 1）
  isNoiseToken,
  // 分句 / 极性（改动 2：支撑「是或不是」；改动 4：支撑极性对比）
  splitClauses,
  splitSentences,
  clauseHasNegation,
  collectClauseHits,
  detectMixedPolarity,
  // 否定分析（改动 3）
  analyzeNegation,
  firstNegation,
  // 主题问答（有没有死人 / 是不是灵异）
  detectThemeQuestion,
  answerThemeQuestion,
  // 元信息问答（本格/变格、清汤/红汤）相关导出，便于单测与前端复用
  detectMetaQuestion,
  answerMetaQuestion,
  inferStyleFromText,
  inferTypeFromText,
  // 同义词归一（改动 5）
  canonicalize,
  canonicalTokens,
  conceptKeys,
  matchConcepts,
  PREDICATE_GROUPS,
  PERSON_GROUPS,
};
