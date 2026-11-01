export const SPECIALTY_GUIDES = [
  {
    id: 'jingtai-apple',
    kicker: '餐桌水果',
    title: '一颗苹果的日常吃法',
    intro: '整颗鲜食清脆，切片也容易搭配，按家里消耗量选择规格。',
    flavor: '脆口果肉，入口带甜味与清新果香。',
    selectionTips: ['看果面是否完整。', '留意按净重还是颗数销售。', '先选小份，试过再买。'],
    uses: [
      { name: '原味切片', description: '洗净去核切片，配一杯原味酸奶。' },
      { name: '苹果梨果盘', description: '与梨分别切块，临吃时再装盘。' }
    ],
    pairingIds: ['pear', 'goji'],
    faq: [
      { q: '越大就越甜吗？', a: '大小不能代替品种和实际试吃。' },
      { q: '一箱颗数固定吗？', a: '按净重装箱时，颗数随大小变化。' }
    ],
    notes: '商品与口感为模拟示例，图片不代表实际供货。'
  },
  {
    id: 'goji',
    kicker: '一勺干果',
    title: '让枸杞走进家常饭',
    intro: '少量加入粥和甜汤，添一点红色，也让味道更有层次。',
    flavor: '干果微甜有嚼感，煮后口感柔软。',
    selectionTips: ['先看配料与标签。', '检查袋口是否密封。', '按使用量挑选小包装。'],
    uses: [
      { name: '玉米枸杞粥', description: '米粥煮熟后，加熟玉米粒与枸杞稍煮。' },
      { name: '梨块枸杞汤', description: '梨去核切块，加水煮软后加入枸杞。' }
    ],
    pairingIds: ['pear', 'corn'],
    faq: [
      { q: '颜色越红越好吗？', a: '不能只看颜色，还应核对来源与标签。' },
      { q: '每次要用很多吗？', a: '家常搭配少量加入即可，按口味调整。' }
    ],
    notes: '以普通干枸杞作食品搭配示例，实际以标签为准。'
  },
  {
    id: 'pear',
    kicker: '清爽果盘',
    title: '鲜梨可以脆着吃，也能煮着吃',
    intro: '鲜食留住清爽口感，煮软后适合换一种餐后甜味。',
    flavor: '脆爽多汁，甜度与细腻程度随品种变化。',
    selectionTips: ['避开破皮和明显磕伤。', '确认品种与单果大小。', '按净重比较装箱规格。'],
    uses: [
      { name: '苹果梨沙拉', description: '洗净去核切块，拌少量原味酸奶。' },
      { name: '清煮梨块', description: '去核切块，加水煮至喜欢的软度。' }
    ],
    pairingIds: ['jingtai-apple', 'goji'],
    faq: [
      { q: '外皮颜色都一样吗？', a: '不同品种有差异，以实际说明为准。' },
      { q: '适合一次买很多吗？', a: '先结合人数、吃法和储存条件选择。' }
    ],
    notes: '鲜梨品种尚未确定，图片和口感仅为示例。'
  },
  {
    id: 'potato',
    kicker: '家常厨房',
    title: '洋芋的一荤一素搭配思路',
    intro: '切丝快炒，切块炖煮，同一份食材也能换着做。',
    flavor: '熟后可脆可糯，表现取决于品种与做法。',
    selectionTips: ['挑选结实、无腐坏的薯块。', '避开发芽或变绿的土豆。', '问清品种适合炒还是炖。'],
    uses: [
      { name: '洋葱土豆片', description: '土豆切薄片，与洋葱炒至熟透。' },
      { name: '玉米土豆炖鸡', description: '与鸡块、鲜玉米加水炖至全部熟透。' }
    ],
    pairingIds: ['onion', 'corn'],
    faq: [
      { q: '外皮能判断粉糯吗？', a: '不能只按皮色判断，需确认品种。' },
      { q: '买多大比较方便？', a: '相近大小方便处理，按烹调需要选。' }
    ],
    notes: '图片混有不同外皮土豆，不作为单一品种证明。'
  },
  {
    id: 'corn',
    kicker: '家常主食',
    title: '一根玉米，蒸煮都方便',
    intro: '整根吃保留原味，取粒后也能加入米饭或汤里。',
    flavor: '甜脆或软糯各有特点，先确认实际品种。',
    selectionTips: ['问清甜玉米还是糯玉米。', '核对根数与果穗规格。', '确认生熟形态和保鲜要求。'],
    uses: [
      { name: '原味蒸玉米', description: '鲜玉米清理后蒸至熟透，再分段分享。' },
      { name: '玉米土豆汤', description: '鲜玉米切段，与土豆块炖至熟透。' }
    ],
    pairingIds: ['potato', 'onion'],
    faq: [
      { q: '看照片能判断生熟吗？', a: '不能，应核对商品形态和食用说明。' },
      { q: '每根重量一样吗？', a: '果穗有大小差异，先看计量方式。' }
    ],
    notes: '图片仅作形态示意，不据照片判断生熟状态。'
  },
  {
    id: 'onion',
    kicker: '厨房配角',
    title: '用洋葱为家常菜添香',
    intro: '薄片适合快炒，大块适合炖煮，按菜肴调整切法。',
    flavor: '生时有辛香，炒软后味道更温和。',
    selectionTips: ['选手感结实的葱球。', '检查外皮与根部是否干燥。', '避开软烂和明显破损。'],
    uses: [
      { name: '洋葱炒鸡蛋', description: '洋葱炒软，加入炒好的鸡蛋拌匀。' },
      { name: '洋葱土豆焖饭', description: '切小块炒香，与米一同焖至熟透。' }
    ],
    pairingIds: ['potato', 'corn'],
    faq: [
      { q: '切丝还是切块？', a: '快炒切丝，炖煮可切较大的块。' },
      { q: '需要挑完全没外皮的吗？', a: '完整干燥外皮可以保护内部葱球。' }
    ],
    notes: '颜色与规格为模拟展示，以实际商品说明为准。'
  }
];

export const COLLECTIONS = [
  {
    id: 'fruit-table',
    title: '把果盘摆上餐桌',
    subtitle: '苹果与梨，换着尝一口',
    description: '一份清脆，一份清爽。从日常鲜食到酸奶果盘，按家里人数选水果。',
    productIds: ['jingtai-apple', 'pear'],
    image: 'assets/apples.jpg'
  },
  {
    id: 'home-kitchen',
    title: '家常厨房的好搭档',
    subtitle: '三样食材，多种做法',
    description: '土豆、玉米和洋葱，切片炒、切块炖，也能一起做一锅家常饭。',
    productIds: ['potato', 'corn', 'onion'],
    image: 'assets/potato.jpg'
  },
  {
    id: 'gift-share',
    title: '少量尝鲜，一起分享',
    subtitle: '从喜欢的口味开始选',
    description: '挑一份水果，再配一小袋干枸杞。按需要分别选择，让分享轻松一点。',
    productIds: ['jingtai-apple', 'pear', 'goji'],
    image: 'assets/goji.jpg'
  }
];
