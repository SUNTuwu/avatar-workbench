'use strict';
// 图层映射（vtuber_art_new.psd，1031×751）。数字是 PSD 图层记录序号：从最底层 Background=0 往上数，组的起止标记也占一个号。
// 改了 PSD 的图层顺序以后，打开「图层」选项卡核对序号，再改这里。
// 「左 / 右」一律指画面上的左右（角色面朝画面左边，画面左手 = 角色的右手）。

const PSD_FILE = 'vtuber_art_new.psd';

const RIG = {
  expectedRecords: 75,
  head: 18,                 // 头部底色
  lens: 22,                 // 眼镜镜片白底
  body: { normal: [4, 5], mirror: 7 },   // 衬衫（双层抖动）/ 镜像版；举手版（6）算一个手势，见 HANDS.raise
  neck: [8, 9],             // 下巴后的毛（双层抖动）
  face: [34, 35],           // 脸部线稿（双层抖动）
  glasses: [36, 37],        // 眼镜 + 刘海线稿（双层抖动）
  // 耳朵拆成左右两只：竖起有双层抖动
  ears: {
    L: { up: [11, 13], tilt: [15], back: [17] },
    R: { up: [10, 12], tilt: [14], back: [16] },
  },
  // 眼睛和眼底：眼底 19 配睁眼，20 配星星眼，21 配半睁和各种闭眼；笑眼、>< 不配眼底
  eyes: {
    normal:  { label: '正常',   eye: [23],     white: 19, blinks: true },
    worried: { label: '委屈',   eye: [24],     white: 19, blinks: true },
    angry:   { label: '生气',   eye: [25],     white: 19, blinks: true },
    sparkle: { label: '星星眼', eye: [26, 27], white: 20, blinks: true },
    half:    { label: '半睁',   eye: [28],     white: 21, blinks: true },
    closed:  { label: '闭眼',   eye: [29],     white: 21 },
    happy:   { label: '笑眼 ^^', eye: [30] },
    squeeze: { label: '> <',    eye: [31] },
    cry:     { label: '哭',     eye: [32],     white: 21 },
    tired:   { label: '眯眼 - -', eye: [33],   white: 21 },
  },
  mouths: { a: 39, e: 40, drool: 41, wavy: 42, n: 43, bf: 44, o: 45, i: 46, u: 47, panic: 48, shout: 49, pout: 50 },
  whiskers: { normal: [53, 54], bristle: [55, 56] },   // 胡子：平时 / 炸毛，都是双层抖动
  wasted: 3,                // WASTED 字
  // 电脑道具：托在「展示手」上，跟着展示手动。位置和大小在面板里调（PSD 像素）。
  // final 是屏幕上的字；screenAt 是屏幕中间的一个点，用来找绿幕范围；z：画在所有手势上面
  laptop: { layer: 1, final: 2, screenAt: [250, 230], z: 73.5, hand: 'show' },
  erase: {},
};

// 骨骼：身体 → 头 → 左耳 / 右耳。pivot 是旋转中心，tip 是骨骼末端（画红线、IK 拖动用），都是 PSD 像素坐标
const BONES = [
  { id: 'body', label: '身体', parent: null,   pivot: [706, 700], tip: [699, 508] },
  { id: 'head', label: '头',   parent: 'body', pivot: [699, 508], tip: [712, 215] },
  { id: 'earL', label: '左耳', parent: 'head', pivot: [655, 245], tip: [618, 72] },
  { id: 'earR', label: '右耳', parent: 'head', pivot: [790, 235], tip: [862, 90] },
];

// 手势：side 是占用的手（L 画面左、R 画面右），同一边互斥，双手手势两边都占。
// pivot 是手腕（缩放框默认锚点、专属动画的旋转中心）。
// body：'mirror' = 要配身体镜像版；isBody = 这个图层本身就是身体（举手版），clip 是能动的手臂部分
// anims：这个手势专属的动画（0 到多个）
const HANDS = {
  show:     { label: '展示手', side: ['L'], layer: 59, pivot: [560, 690], anims: ['lift', 'offer'] },
  finger:   { label: '竖手指', side: ['L'], layer: 60, pivot: [470, 670], anims: ['wag', 'poke'] },
  pointUp:  { label: '指天',   side: ['L'], layer: 65, pivot: [620, 670], anims: ['jab'] },
  palm:     { label: '请看',   side: ['L'], layer: 68, pivot: [570, 680], anims: ['present', 'jabL'] },
  pointR:   { label: '指右边', side: ['L'], layer: 72, pivot: [520, 700], anims: ['jabR'] },
  paw:      { label: '爪爪',   side: ['L'], layer: 67, pivot: [560, 680], anims: ['beckon'] },
  paw2:     { label: '爪爪2',  side: ['L'], layer: 69, pivot: [560, 690], anims: ['beckon'] },
  raise:    { label: '举手',   side: ['L'], layer: 6,  pivot: [600, 470], isBody: true,
              clip: [[420, 160], [940, 160], [940, 356], [420, 531]], anims: ['waveArm'] },
  think:    { label: '期待手', side: ['R'], layer: 61, pivot: [700, 690], body: 'mirror', anims: ['hope'] },
  chin:     { label: '摸下巴', side: ['R'], layer: 73, pivot: [780, 700], body: 'mirror', anims: ['stroke'] },
  pointL:   { label: '指左边', side: ['R'], layer: 71, pivot: [880, 700], anims: ['jabL'] },
  heart:    { label: '比心手', side: ['L', 'R'], layer: 62, pivot: [625, 710], anims: ['beat', 'swayHeart'] },
  pray:     { label: '双手合十', side: ['L', 'R'], layer: 64, pivot: [690, 700], anims: ['bow', 'rub'] },
  fold:     { label: '抱臂',   side: ['L', 'R'], layer: 63, pivot: [706, 700], anims: ['huff'] },
  paws:     { label: '双爪',   side: ['L', 'R'], layer: 66, pivot: [700, 700], anims: ['scratch', 'pounce'] },
  thumbs:   { label: '点赞',   side: ['L', 'R'], layer: 70, pivot: [660, 700], anims: ['thumbUp'] },
};
const HAND_GROUPS = [
  { side: 'L', label: '画面左手' }, { side: 'R', label: '画面右手' }, { side: 'LR', label: '双手' },
];

const EAR_POSES = [{ v: 'up', label: '竖起' }, { v: 'tilt', label: '歪耳' }, { v: 'back', label: '飞机耳' }];
const EYES = Object.entries(RIG.eyes).map(([v, e]) => ({ v, label: e.label }));
const WHISKERS = [{ v: 'normal', label: '平时' }, { v: 'bristle', label: '炸毛' }, { v: 'none', label: '隐藏' }];
const LAPTOP = [{ v: 'none', label: '无' }, { v: 'white', label: '白屏' }, { v: 'final', label: 'FINAL' }, { v: 'green', label: '绿幕' }];

// 口型：前 7 个是自动口型会用到的基础口型，后面的只能手动选
const MOUTHS = [
  { v: 'a', label: 'a 大张', key: 'a' }, { v: 'o', label: 'o 半圆', key: 'o' }, { v: 'e', label: 'e 靠后', key: 'e' },
  { v: 'i', label: 'i 呲牙', key: 'i' }, { v: 'u', label: 'u 三角', key: 'u' }, { v: 'bf', label: 'bf 抿嘴', key: 'b' },
  { v: 'n', label: '普通', key: 'n' },
  { v: 'drool', label: '流口水', key: 'z' }, { v: 'wavy', label: '波浪嘴', key: 'x' }, { v: 'panic', label: '急急嘴', key: 'c' },
  { v: 'shout', label: '大喊', key: 'l' }, { v: 'pout', label: '瘪嘴', key: 'p' },
];
const VISEME_COLORS = { a: '#e8463a', e: '#f08a3c', o: '#e9c13b', i: '#4fb39a', u: '#4a8fd9', bf: '#9067d6', n: '#8a8f99' };

// 表情预设：一次切换眼睛、两只耳朵、不说话时的嘴、胡子（不写就是平时的胡子）
const EXPRESSIONS = {
  normal:     { label: '普通',   key: '1', eyes: 'normal',  ears: 'up',   mouth: 'n' },
  shock:      { label: '震惊',   key: '2', eyes: 'normal',  ears: 'back', mouth: 'a' },
  sparkle:    { label: '星星眼', key: '3', eyes: 'sparkle', ears: 'up',   mouth: 'o' },
  speechless: { label: '无语',   key: '4', eyes: 'half',    ears: 'tilt', mouth: 'bf' },
  smug:       { label: '得意',   key: '5', eyes: 'half',    ears: 'up',   mouth: 'wavy' },
  happy:      { label: '开心',   key: '6', eyes: 'happy',   ears: 'up',   mouth: 'a' },
  calm:       { label: '闭眼',   key: '7', eyes: 'closed',  ears: 'up',   mouth: 'n' },
  panic:      { label: '急急',   key: '8', eyes: 'squeeze', ears: 'back', mouth: 'panic', whiskers: 'bristle', loop: 'tremble' },
  drool:      { label: '馋',     key: '9', eyes: 'sparkle', ears: 'up',   mouth: 'drool' },
  serious:    { label: '认真',   key: '0', eyes: 'normal',  ears: 'up',   mouth: 'bf' },
  worried:    { label: '委屈',   key: '-', eyes: 'worried', ears: 'tilt', mouth: 'pout' },
  angry:      { label: '生气',   key: '=', eyes: 'angry',   ears: 'back', mouth: 'wavy', whiskers: 'bristle' },
  cry:        { label: '哭',     key: '[', eyes: 'cry',     ears: 'back', mouth: 'pout' },
  tired:      { label: '眯眼',   key: ']', eyes: 'tired',   ears: 'tilt', mouth: 'n' },
  yell:       { label: '大喊',   key: "'", eyes: 'squeeze', ears: 'back', mouth: 'shout', whiskers: 'bristle' },
};
