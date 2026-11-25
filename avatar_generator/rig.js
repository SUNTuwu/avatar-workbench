'use strict';
// 图层映射。数字是 PSD 图层记录序号：从最底层 Background=0 往上数，组的起止标记也占一个号。
// 改了 PSD 的图层顺序以后，打开「图层检查」面板核对序号，再改这里。

const RIG = {
  expectedRecords: 49,
  head: 12,                 // 头部底色
  lens: 17,                 // 眼镜镜片白底
  body: { normal: [3, 4], mirror: 5 },   // 衬衫（双层抖动）/ 镜像版：身体朝向跟着手势走，见 mirrorHands
  neck: [6, 7],             // 下巴后的毛（双层抖动）
  face: [24, 25],           // 脸部线稿（双层抖动）
  glasses: [26, 27],        // 眼镜 + 刘海线稿（双层抖动）
  ears: { up: [8, 9], tilt: [10], back: [11] },
  // 眼睛和眼底花纹一一对应：13↔18、14↔19、15↔20、16↔21；22、23 没有眼底
  eyes: {
    normal:  { label: '正常',   eye: 18, white: 13, blinks: true },
    sparkle: { label: '星星眼', eye: 19, white: 14, blinks: true },
    half:    { label: '半睁',   eye: 20, white: 15, blinks: true },
    closed:  { label: '闭眼',   eye: 21, white: 16 },
    happy:   { label: '笑眼 ^^', eye: 22 },
    squeeze: { label: '> <',    eye: 23 },
  },
  mouths: { a: 29, e: 30, o: 35, i: 36, u: 37, bf: 34, n: 33, drool: 31, wavy: 32, panic: 38 },
  whiskers: { normal: [39, 40], bristle: [41] },   // 胡子：平时（双层抖动）/ 炸毛
  // 载入时擦掉的区域（PSD 像素坐标 x, y, w, h）：41 炸毛胡子左边误画的一个点
  erase: { 41: [[166, 520, 14, 22]] },
  hands: { show: [44], finger: [45], think: [46], heart: [47] },
  mirrorHands: ['think'],   // 这些手势要配身体镜像版（期待手），其他手势用正常身体
  // 电脑道具：举在「展示」手的上方。位置和大小在面板「5 手势 / 道具」里调（默认缩放 0.65、X -228、Y 100，PSD 像素：电脑在手的左上方，底边盖住手的后半边，不碰脸和胡子；导出的「脚底 X」默认 720，给左边的电脑留位置），存在工程里。
  // final 是屏幕上的字，和电脑一起变换；screenAt 是屏幕中间的一个点，用来找绿幕范围。
  // z：画的先后，47.5 = 在所有手势上面：电脑底边盖住展示手的后半边（手指尖那一截），像是托在手上
  laptop: { layer: 1, final: 2, screenAt: [354, 222], z: 47.5 },
  // 旋转/缩放中心（PSD 像素坐标）
  pivots: { root: [487, 700], neck: [480, 508], wrist: [285, 668] },
};

const EARS = [
  { v: 'up', label: '竖起' }, { v: 'tilt', label: '歪耳' }, { v: 'back', label: '飞机耳' },
];
const EYES = Object.entries(RIG.eyes).map(([v, e]) => ({ v, label: e.label }));
const WHISKERS = [{ v: 'normal', label: '平时' }, { v: 'bristle', label: '炸毛' }, { v: 'none', label: '隐藏' }];
const HANDS = [
  { v: 'none', label: '无' }, { v: 'show', label: '展示手' }, { v: 'finger', label: '竖手指' },
  { v: 'think', label: '期待手' }, { v: 'heart', label: '比心手' },
];
const LAPTOP = [{ v: 'none', label: '无' }, { v: 'white', label: '白屏' }, { v: 'final', label: 'FINAL' }, { v: 'green', label: '绿幕' }];

// 口型：前 7 个是自动口型会用到的基础口型，后 3 个只能手动选
const MOUTHS = [
  { v: 'a', label: 'a 大张', key: 'a' }, { v: 'o', label: 'o 半圆', key: 'o' }, { v: 'e', label: 'e 靠后', key: 'e' },
  { v: 'i', label: 'i 呲牙', key: 'i' }, { v: 'u', label: 'u 三角', key: 'u' }, { v: 'bf', label: 'bf 抿嘴', key: 'b' },
  { v: 'n', label: '普通', key: 'n' },
  { v: 'drool', label: '流口水', key: 'z' }, { v: 'wavy', label: '波浪嘴', key: 'x' }, { v: 'panic', label: '急急嘴', key: 'c' },
];
const VISEME_COLORS = { a: '#e8463a', e: '#f08a3c', o: '#e9c13b', i: '#4fb39a', u: '#4a8fd9', bf: '#9067d6', n: '#8a8f99' };

// 表情预设：一次切换眼睛、耳朵、不说话时的嘴、胡子（不写就是平时的胡子）
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
};
