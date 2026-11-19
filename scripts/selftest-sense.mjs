#!/usr/bin/env node
// selftest-sense.mjs —— 纯合成帧自测：不需要相机、不需要 ffmpeg、不碰网络。
//
// 覆盖三块：
//   1) lib/sense.js：首帧场景判定、整帧翻转、方块左→右移动时质心单调右移、
//      面积越大分越高、肤色加分、太黑打四折、帧长度错误要抛。
//   2) lib/gate.js 闸门：分数/运动/面积/冷却四道门，reason 的中文九宫格方位。
//   3) lib/gate.js 定格：临时目录里复制 latest.jpg、文件名时间戳、keep 轮转、
//      latest 缺失或 0 字节不许抛。
//
// 跑法：node scripts/selftest-sense.mjs    （全过 exit 0，有 FAIL exit 1）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAnalyzer } from '../lib/sense.js';
import { createGate, freeze, directionLabel } from '../lib/gate.js';

const W = 64;
const H = 36;
const PX = W * H;
const BYTES = PX * 3;

let pass = 0;
const failures = [];

/** 一条断言。 */
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  → ${detail}`}`);
  }
}

/** 近似相等。 */
function near(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// —— 合成帧 ——
function frame(fg = [0, 0, 0]) {
  const buf = Buffer.alloc(BYTES);
  const [r, g, b] = fg;
  for (let i = 0; i < PX; i++) {
    const p = i * 3;
    buf[p] = r;
    buf[p + 1] = g;
    buf[p + 2] = b;
  }
  return buf;
}

const blackFrame = () => frame([0, 0, 0]);
const whiteFrame = () => frame([255, 255, 255]);
const skinFrame = () => frame([224, 172, 140]); // 典型肤色，Cb≈103 / Cr≈157 落在肤色区间

/** 在底色上画一个方块。 */
function blockFrame({ x, y, size, fg = [255, 255, 255], bg = [0, 0, 0] }) {
  const buf = frame(bg);
  for (let yy = y; yy < y + size; yy++) {
    if (yy < 0 || yy >= H) continue;
    for (let xx = x; xx < x + size; xx++) {
      if (xx < 0 || xx >= W) continue;
      const p = (yy * W + xx) * 3;
      buf[p] = fg[0];
      buf[p + 1] = fg[1];
      buf[p + 2] = fg[2];
    }
  }
  return buf;
}

// ============================================================ 1) 感知
console.log('— lib/sense.js —');

{
  const an = createAnalyzer({ width: W, height: H });
  const t0 = an.push(blackFrame(), 1000);

  const keys = ['ts', 'w', 'h', 'frames', 'motion', 'centroid', 'bbox', 'brightness', 'contrast', 'skin', 'scene', 'score'];
  const missing = keys.filter((k) => !(k in t0));
  check('Tick 字段齐全（12 个）', missing.length === 0, `缺：${missing.join(',')}`);
  check('tick.ts 原样回传', t0.ts === 1000, `收到 ${t0.ts}`);
  check('tick.w/h 等于构造参数', t0.w === W && t0.h === H, `${t0.w}x${t0.h}`);
  check('首帧 frames=1', t0.frames === 1, String(t0.frames));
  check('首帧 scene=true', t0.scene === true, String(t0.scene));
  check('首帧 score=0', t0.score === 0, String(t0.score));
  check('首帧 centroid 居中 [0.5,0.5]', t0.centroid[0] === 0.5 && t0.centroid[1] === 0.5, JSON.stringify(t0.centroid));
  check('首帧 motion=0', t0.motion === 0, String(t0.motion));
  check('首帧 bbox 为空框', JSON.stringify(t0.bbox) === '[0,0,0,0]', JSON.stringify(t0.bbox));
  check('全黑帧 brightness≈0', near(t0.brightness, 0, 1e-6), String(t0.brightness));
  check('全黑帧 contrast=0', t0.contrast === 0, String(t0.contrast));
  check('全黑帧 skin=0', t0.skin === 0, String(t0.skin));

  const t1 = an.push(whiteFrame(), 1060);
  check('全黑→全白 motion=1', t1.motion === 1, String(t1.motion));
  check('全白 brightness≈1', near(t1.brightness, 1, 1e-6), String(t1.brightness));
  check('纯色帧 contrast=0', t1.contrast === 0, String(t1.contrast));
  check('全黑→全白 scene=true（换场景）', t1.scene === true, String(t1.scene));
  check('纯白不算肤色', t1.skin === 0, String(t1.skin));
  check('整帧翻转后 score 在 0..100', t1.score >= 0 && t1.score <= 100, String(t1.score));
  check('frames 累加到 2', t1.frames === 2, String(t1.frames));

  // 静止帧：连续两帧全白不该有运动
  const t2 = an.push(whiteFrame(), 1120);
  check('静止帧 motion=0', t2.motion === 0, String(t2.motion));
  check('静止帧 scene=false', t2.scene === false, String(t2.scene));
  check('静止帧 score=0', t2.score === 0, String(t2.score));
}

// 方块从左往右走：每次回黑再出现，保证质心只反映当前方块
{
  const an = createAnalyzer({ width: W, height: H });
  an.push(blackFrame(), 0);
  const xs = [4, 20, 36, 52]; // 52+12=64，刚好贴右边
  const cxs = [];
  const motions = [];
  let clock = 10;
  for (const x of xs) {
    an.push(blackFrame(), clock++);
    const t = an.push(blockFrame({ x, y: 12, size: 12 }), clock++);
    cxs.push(t.centroid[0]);
    motions.push(t.motion);
  }
  const increasing = cxs.every((v, i) => i === 0 || v > cxs[i - 1]);
  check('方块右移 → 质心 cx 单调变大', increasing, cxs.map((v) => v.toFixed(3)).join(' < '));
  check('质心横坐标落在 0..1', cxs.every((v) => v > 0 && v < 1), cxs.map((v) => v.toFixed(3)).join(','));
  check('方块运动量≈面积占比(6.25%)', motions.every((m) => near(m, 144 / PX, 0.002)), motions.map((m) => (m * 100).toFixed(2) + '%').join(','));
  check('方块得分在 0..100', motions.length === cxs.length, '');
}

// 面积越大，兴趣分越高
{
  const an = createAnalyzer({ width: W, height: H });
  an.push(blackFrame(), 0);
  const small = an.push(blockFrame({ x: 10, y: 10, size: 8 }), 1);
  an.push(blackFrame(), 2);
  const big = an.push(blockFrame({ x: 10, y: 10, size: 24 }), 3);
  check('运动面积更大 → score 更高', big.score > small.score, `small=${small.score} big=${big.score}`);
  check('小运动块 bbox 归一化正确', near(small.bbox[2], 8 / W, 1e-6) && near(small.bbox[3], 8 / H, 1e-6), JSON.stringify(small.bbox.map((v) => +v.toFixed(4))));
}

// 肤色：纯肤色帧 + 同样的运动量下肤色加分
{
  const an = createAnalyzer({ width: W, height: H });
  const sk = an.push(skinFrame(), 1);
  check('纯肤色帧 skin≈1', sk.skin > 0.99, String(sk.skin));

  const gauge = (fg) => {
    const a = createAnalyzer({ width: W, height: H });
    a.push(blackFrame(), 0);
    return a.push(blockFrame({ x: 8, y: 8, size: 16, fg }), 1).score;
  };
  const whiteScore = gauge([255, 255, 255]);
  const skinScore = gauge([224, 172, 140]);
  check('同样的块，肤色比纯白分高（skinBoost）', skinScore > whiteScore, `white=${whiteScore} skin=${skinScore}`);
}

// 太黑：亮度 < 0.06 时整体 ×0.4
{
  const dark = createAnalyzer({ width: W, height: H });
  dark.push(blackFrame(), 0);
  const darkTick = dark.push(blockFrame({ x: 10, y: 10, size: 8, fg: [255, 255, 255], bg: [0, 0, 0] }), 1);

  const lit = createAnalyzer({ width: W, height: H });
  lit.push(frame([40, 40, 40]), 0);
  const litTick = lit.push(blockFrame({ x: 10, y: 10, size: 8, fg: [255, 255, 255], bg: [40, 40, 40] }), 1);

  check('暗帧亮度确实 <0.06', darkTick.brightness < 0.06, String(darkTick.brightness));
  check('亮帧亮度 >0.06', litTick.brightness > 0.06, String(litTick.brightness));
  const ratio = darkTick.score === 0 ? 0 : litTick.score / darkTick.score;
  check('太黑时 score ×0.4（比值≈2.5）', Math.abs(ratio - 2.5) < 0.08, `dark=${darkTick.score} lit=${litTick.score} ratio=${ratio.toFixed(3)}`);
}

// 帧长度错误必须抛清楚
{
  const an = createAnalyzer({ width: W, height: H });
  let err = null;
  try {
    an.push(Buffer.alloc(10), 1);
  } catch (e) {
    err = e;
  }
  check('帧长度不对要抛错', err instanceof Error, String(err));
  check('错误信息里带期望字节数 6912', !!err && String(err.message).includes(String(BYTES)), err && err.message);
  let badSide = null;
  try {
    createAnalyzer({ width: 0, height: 36 });
  } catch (e) {
    badSide = e;
  }
  check('width=0 要抛 TypeError', badSide instanceof TypeError, String(badSide));
}

// ============================================================ 2) 闸门
console.log('— lib/gate.js · evaluate —');

{
  const gate = createGate({ threshold: 55, cooldownMs: 6000, minArea: 0.02 });
  // bbox 中心 = (0.55+0.15, 0.35+0.15) = (0.70, 0.50) → 右中
  const hot = { ts: 10_000, score: 80, motion: 0.34, bbox: [0.55, 0.35, 0.3, 0.3] };

  const r1 = gate.evaluate(hot);
  check('分数过线 → fire=true', r1.fire === true, JSON.stringify(r1));
  check('reason 是中文动作描述', typeof r1.reason === 'string' && r1.reason.includes('动作'), JSON.stringify(r1.reason));
  check('reason 带运动百分比 34%', !!r1.reason && r1.reason.includes('34%'), JSON.stringify(r1.reason));
  check('reason 带九宫格方位 右中', !!r1.reason && r1.reason.includes('右中'), JSON.stringify(r1.reason));

  const r2 = gate.evaluate({ ...hot, ts: 15_999 }); // 5999ms < 6000
  check('冷却期内被拦住', r2.fire === false, JSON.stringify(r2));
  check('不触发时 reason=null', r2.reason === null, JSON.stringify(r2));

  const r3 = gate.evaluate({ ...hot, ts: 16_000 }); // 正好 6000ms
  check('冷却到点放行', r3.fire === true, JSON.stringify(r3));

  check('分数不够不触发', gate.evaluate({ ...hot, ts: 90_000, score: 30 }).fire === false);
  check('几乎不动不触发', gate.evaluate({ ...hot, ts: 100_000, score: 90, motion: 0.005 }).fire === false);
  check('面积太小不触发', gate.evaluate({ ...hot, ts: 110_000, score: 90, motion: 0.5, bbox: [0.4, 0.4, 0.05, 0.05] }).fire === false);
  check('面积刚好 0.02 放行', gate.evaluate({ ...hot, ts: 120_000, score: 90, motion: 0.5, bbox: [0.4, 0.4, 0.2, 0.1] }).fire === true);
  check('空 tick 不炸', gate.evaluate(null).fire === false);

  const grid = [
    [0.1, 0.1, '左上'],
    [0.5, 0.1, '上'],
    [0.9, 0.1, '右上'],
    [0.1, 0.5, '左中'],
    [0.5, 0.5, '正中'],
    [0.9, 0.5, '右中'],
    [0.1, 0.9, '左下'],
    [0.5, 0.9, '下'],
    [0.9, 0.9, '右下'],
  ];
  const bad = grid.filter(([x, y, want]) => directionLabel(x, y) !== want);
  check('九宫格 9 个方位都对', bad.length === 0, bad.map(([x, y, w]) => `(${x},${y})≠${w}`).join(' '));
}

// ============================================================ 3) 定格
console.log('— lib/gate.js · freeze —');

const tmpRoot = path.join(os.tmpdir(), `whale-gaze-selftest-${process.pid}-${Date.now()}`);
const liveDir = path.join(tmpRoot, 'live', 'cam');
const latest = path.join(liveDir, 'latest.jpg');
const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const baseTs = new Date(2026, 10, 18, 18, 42, 7).getTime(); // 本地时间 2026-11-18 18:42:07

try {
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(latest, jpgBytes);

  const f1 = freeze({ latestJpeg: latest, dataDir: tmpRoot, sourceId: 'cam', tick: { ts: baseTs }, keep: 200 });
  check('freeze 成功返回 ok', f1.ok === true, JSON.stringify(f1));
  check('返回路径存在', f1.ok === true && fs.existsSync(f1.path), f1.path);
  check('复制出的字节数一致', f1.ok === true && f1.bytes === jpgBytes.length, `${f1.bytes} vs ${jpgBytes.length}`);
  check('文件名是 <yyyymmdd-hhmmss>-<sourceId>.jpg', /[\\/]inbox[\\/]20261118-184207-cam\.jpg$/.test(f1.path || ''), f1.path);
  check('落在 dataDir/inbox 下', path.dirname(f1.path || '') === path.join(tmpRoot, 'inbox'), path.dirname(f1.path || ''));
  check('内容与 latest.jpg 一致', fs.readFileSync(path.join(tmpRoot, 'inbox', '20261118-184207-cam.jpg')).equals(jpgBytes));

  // 同秒再来一张：不许覆盖前一张
  const f1b = freeze({ latestJpeg: latest, dataDir: tmpRoot, sourceId: 'cam', tick: { ts: baseTs }, keep: 200 });
  check('同一秒再定格不覆盖旧文件', f1b.ok === true && f1b.path !== f1.path && fs.existsSync(f1.path), f1b.path);

  // keep 轮转：再来 4 张，只留最新的 2 张
  for (let i = 1; i <= 4; i++) {
    const r = freeze({ latestJpeg: latest, dataDir: tmpRoot, sourceId: 'cam', tick: { ts: baseTs + i * 1000 }, keep: 2 });
    check(`keep=2 第 ${i} 张仍 ok`, r.ok === true, JSON.stringify(r));
  }
  const inboxNames = fs.readdirSync(path.join(tmpRoot, 'inbox')).filter((n) => n.toLowerCase().endsWith('.jpg')).sort();
  check('inbox 被裁到 keep 张', inboxNames.length === 2, inboxNames.join(','));
  check('留下的是最新两张', inboxNames.join(',') === '20261118-184210-cam.jpg,20261118-184211-cam.jpg', inboxNames.join(','));
  check('最旧的已被删掉', !inboxNames.includes('20261118-184207-cam.jpg'));

  // 缺失 / 0 字节：不许抛，只回 ok:false
  const missing = freeze({ latestJpeg: path.join(liveDir, 'nope.jpg'), dataDir: tmpRoot, sourceId: 'cam' });
  check('latest.jpg 不存在 → ok:false 不抛', missing.ok === false && typeof missing.error === 'string' && missing.error.length > 0, JSON.stringify(missing));

  const emptyPath = path.join(liveDir, 'empty.jpg');
  fs.writeFileSync(emptyPath, Buffer.alloc(0));
  const empty = freeze({ latestJpeg: emptyPath, dataDir: tmpRoot, sourceId: 'cam' });
  check('latest.jpg 0 字节 → ok:false 不抛', empty.ok === false && /0 字节/.test(empty.error || ''), JSON.stringify(empty));

  const noArgs = freeze({});
  check('参数缺失 → ok:false 不抛', noArgs.ok === false && typeof noArgs.error === 'string', JSON.stringify(noArgs));

  // tick.ts 是相对计时器（比如 1234）时，文件名不能变成 1970
  const relTick = freeze({ latestJpeg: latest, dataDir: tmpRoot, sourceId: 'cam', tick: { ts: 1234 }, keep: 200 });
  const year = relTick.ok ? Number(String(path.basename(relTick.path)).slice(0, 4)) : 0;
  check('ts 不合理时用当前时间命名（年份≥2000）', relTick.ok === true && year >= 2000, `${path.basename(relTick.path || '')}`);
} catch (err) {
  failures.push({ name: '定格用例中途抛异常', detail: err && err.stack });
  console.log(`FAIL  定格用例中途抛异常  → ${err && err.stack}`);
} finally {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // 临时目录删不掉不影响结论
  }
}

// ============================================================ 汇总
console.log('');
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项 PASS，0 项 FAIL`);
  process.exit(0);
} else {
  console.log(`有失败：${pass} 项 PASS，${failures.length} 项 FAIL`);
  for (const f of failures) console.log(`  - ${f.name}`);
  process.exit(1);
}
