// Shared facts, so the same question put to two seats can actually contradict.
//
// The offline narrator needs a memory: ask seat 2 about the umbrella in round 1
// and again in round 3, and it must give the same answer both times, while seat
// 4 may give a different one. That is what makes cross-checking a real move in
// the game rather than a fiction, and it needs no model call.
//
// A question is classified by a small keyword table. Questions that match no
// topic fall back to a topic keyed by the question's own text, so they are at
// least stable per phrasing; the engine documents that freely-phrased
// questions only cross-check properly when a real model answers them.

export const GENERIC_VALUES = [
  '这个我真没留意',
  '大概就是那样吧',
  '我得想想，记不太清了',
  '没特别的，跟平时一样',
  '嗯……算是吧',
]

export const TOPICS = [
  {
    id: 'umbrella',
    keywords: ['伞', '下雨', '雨', 'umbrella'],
    values: ['我带了伞', '我没带伞，淋了一路', '我车里一直放着把伞', '我看天阴才带的伞', '我从来不看天气预报，没带'],
  },
  {
    id: 'shift',
    keywords: ['值班', '排班', '班', 'shift'],
    values: ['我昨天是中班', '我昨天是早班，五点半就走了', '我昨天休息，没上班', '我连着上了两个晚班'],
  },
  {
    id: 'coffee',
    keywords: ['咖啡', '美式', '拿铁', 'coffee'],
    values: ['我早上喝了一杯美式', '我一天三杯，不然撑不住', '我最近戒了，改喝茶', '我就下午喝一杯'],
  },
  {
    id: 'keys',
    keywords: ['钥匙', '门禁', 'keys'],
    values: ['钥匙在我这儿', '我那份钥匙上周交给前台了', '我门禁卡一直挂在包上', '我钥匙落办公室抽屉里了'],
  },
  {
    id: 'lunch',
    keywords: ['午饭', '午餐', '中饭', 'lunch'],
    values: ['我吃的是楼下那家面', '我午饭随便对付了两口', '我叫的外卖，没出去', '我跟同事一起吃的'],
  },
  {
    id: 'traffic',
    keywords: ['堵车', '路况', '地铁', '通勤', 'traffic'],
    values: ['我坐地铁来的，还行', '路上堵了四十分钟', '我骑车来的，比地铁快', '我打车来的，绕了条路'],
  },
  {
    id: 'elevator',
    keywords: ['电梯', '楼层', 'elevator'],
    values: ['电梯那会儿在检修', '我走的楼梯，就三层', '我等了得有五分钟电梯', '电梯里还碰到隔壁组的'],
  },
  {
    id: 'pet',
    keywords: ['猫', '狗', '宠物', 'pet'],
    values: ['我养了只橘猫', '我住的楼不让养宠物', '我家是条狗，每天得遛', '我怕毛，没养'],
  },
]

/** Lowercase and drop whitespace/punctuation so keyword matching is stable. */
export function normalizeQuestion(text) {
  return String(text === undefined || text === null ? '' : text)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。？！、；：,?!;:"'“”‘’()（）\[\]【】…~～-]+/g, '')
}

export function topicById(id) {
  return TOPICS.find(function (topic) { return topic.id === id })
}

/**
 * The topic key for a question: a known topic id, or `q<hash>` derived from the
 * question's own normalised text.
 */
export function topicOf(text) {
  const normalized = normalizeQuestion(text)
  for (const topic of TOPICS) {
    for (const keyword of topic.keywords) {
      if (normalized.includes(keyword)) return topic.id
    }
  }
  return 'q-' + hashOf(normalized).toString(36)
}

/** FNV-1a, uint32. Kept local so this module stands alone for the CLI. */
export function hashOf(text) {
  let h = 0x811c9dc5
  const value = String(text)
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function valuesFor(topic) {
  const known = topicById(topic)
  return known ? known.values : GENERIC_VALUES
}

/**
 * The seat's answer to a topic. Deliberately independent of the round: a seat
 * that changes its story without being pushed is not a liar, it is a bug.
 */
export function factValue(input) {
  const source = input && typeof input === 'object' ? input : {}
  const topic = typeof source.topic === 'string' && source.topic.length > 0 ? source.topic : 'q-0'
  const seatId = Number.isFinite(Number(source.seatId)) ? Number(source.seatId) : 0
  const seed = source.seed === undefined ? '' : String(source.seed)
  const values = valuesFor(topic)
  const index = hashOf(seed + '|' + topic + '|' + seatId) % values.length
  return { topic: topic, seatId: seatId, index: index, value: values[index], values: values }
}
