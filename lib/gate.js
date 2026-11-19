// gate.js —— 兴趣闸门 + 定格落盘。
//
// 为什么要闸门：模型的上下文每轮只放得下一行字，不能每帧都问「要不要看」。
// 这里用四道条件把「值得定格的一刻」筛出来：分数过线、画面真的在动、动的面积够大、
// 离上次定格够久。宁可漏一点，也不要刷屏 —— 定格是给人看的照片，不是监控录像。
//
// 关于 freeze：latest.jpg 是 ffmpeg 每 1 秒覆盖写的活文件，直接搬走会让采集端写空/丢帧，
// 所以是「复制一份进 inbox」，原文件不动；轮转按文件名排序删最旧（文件名首段就是时间戳）。

import fs from 'node:fs';
import path from 'node:path';

const MIN_MOTION = 0.01; // 几乎不动就不值得定格（噪声/传感器抖动）
const DEFAULT_KEEP = 200;
const MIN_TIMESTAMP_MS = 946_684_800_000; // 2000-01-01：早于此的「ts」多半是相对计时器，不是时间

// 九宫格方位表：行优先，列 = 左/中/右，行 = 上/中/下
const GRID = ['左上', '上', '右上', '左中', '正中', '右中', '左下', '下', '右下'];

/** 把 0..1 的归一化坐标翻成九宫格中文方位，如 (0.9, 0.5) → '右中'。 */
export function directionLabel(x, y) {
  if (!Number.isFinite(x)) x = 0.5;
  if (!Number.isFinite(y)) y = 0.5;
  const col = x < 1 / 3 ? 0 : x < 2 / 3 ? 1 : 2;
  const row = y < 1 / 3 ? 0 : y < 2 / 3 ? 1 : 2;
  return GRID[row * 3 + col];
}

/** bbox 中心点（归一化）。 */
export function bboxCenter(bbox) {
  const b = Array.isArray(bbox) ? bbox : [0, 0, 0, 0];
  const x = Number(b[0]) + Number(b[2]) / 2;
  const y = Number(b[1]) + Number(b[3]) / 2;
  return [Number.isFinite(x) ? x : 0.5, Number.isFinite(y) ? y : 0.5];
}

/** bbox 面积（归一化）。 */
function area(bbox) {
  if (!Array.isArray(bbox)) return 0;
  const w = Number(bbox[2]);
  const h = Number(bbox[3]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 0;
  return w * h;
}

/**
 * 创建兴趣闸门。
 * options: { threshold=55, cooldownMs=6000, minArea=0.02 }
 * 返回 { evaluate(tick) → { fire, reason } }；reason 只在 fire 时给中文说明，否则 null。
 *
 * 时间用 tick.ts 当钟（不用 Date.now()），这样纯输入决定输出，selftest 能造假 tick 跑冷却。
 */
export function createGate({ threshold = 55, cooldownMs = 6000, minArea = 0.02 } = {}) {
  const scoreLine = Number(threshold);
  const cooldown = Number(cooldownMs);
  const minBBoxArea = Number(minArea);
  let lastFireAt = -Infinity; // 从没定格过 → 第一次随时可以触发
  let fires = 0;

  function evaluate(tick) {
    if (!tick || typeof tick !== 'object') return { fire: false, reason: null };

    const ts = Number.isFinite(tick.ts) ? Number(tick.ts) : Date.now();
    const score = Number(tick.score) || 0;
    const motion = Number(tick.motion) || 0;
    const bbox = Array.isArray(tick.bbox) ? tick.bbox : [0, 0, 0, 0];

    if (score < scoreLine) return { fire: false, reason: null };
    if (motion < MIN_MOTION) return { fire: false, reason: null };
    if (area(bbox) < minBBoxArea) return { fire: false, reason: null };
    if (ts - lastFireAt < cooldown) return { fire: false, reason: null };

    lastFireAt = ts;
    fires++;
    const [bx, by] = bboxCenter(bbox);
    const reason = `动作 ${Math.round(motion * 100)}% @ ${directionLabel(bx, by)}`;
    return { fire: true, reason };
  }

  // 给外壳状态面板用的只读快照（不参与决策）
  function status() {
    return { lastFireAt: Number.isFinite(lastFireAt) ? lastFireAt : null, fires };
  }

  return { evaluate, status };
}

/** 时间戳 → yyyymmdd-hhmmss（本地时间，文件名首段就是排序键）。 */
function stampOf(ts) {
  const t = Number.isFinite(ts) && ts > 0 && ts < 8.64e15 ? Number(ts) : Date.now();
  const d = new Date(t);
  const p = (v) => String(v).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 源 id 里可能有路径分隔符之类的脏字符，洗一遍再进文件名。 */
function safeId(sourceId) {
  const s = String(sourceId ?? '').trim();
  const cleaned = s.replace(/[\\/:*?"<>|\s]+/g, '_');
  return cleaned || 'src';
}

/** inbox 轮转：按文件名（时间序）删最旧，留下最新的 keep 张。返回删掉的张数。 */
function rotate(inboxDir, keep) {
  const limit = Number.isInteger(keep) && keep >= 1 ? keep : DEFAULT_KEEP;
  let names;
  try {
    names = fs.readdirSync(inboxDir);
  } catch {
    return 0; // 目录读不了就算了，别打断这次定格
  }
  const jpgs = names.filter((n) => n.toLowerCase().endsWith('.jpg')).sort();
  let removed = 0;
  while (jpgs.length > limit) {
    const victim = jpgs.shift();
    try {
      fs.unlinkSync(path.join(inboxDir, victim));
      removed++;
    } catch {
      // 删不掉（被占用/权限）就跳过，定格本身已经成功了
    }
  }
  return removed;
}

/**
 * 定格：复制 latest.jpg 到 <dataDir>/inbox/<yyyymmdd-hhmmss>-<sourceId>.jpg，
 * 超过 keep 张删最旧的。永不抛异常，失败返回 { ok:false, error }（中文）。
 * tick 只用来取时间戳（缺省取当前时间）。
 */
export function freeze({ latestJpeg, dataDir, sourceId, tick, keep = DEFAULT_KEEP } = {}) {
  try {
    if (!latestJpeg || !dataDir) {
      return { ok: false, error: '缺少 latestJpeg 或 dataDir' };
    }

    // latest.jpg 可能还没生成，或者刚被 ffmpeg 截断成 0 字节 —— 都不算异常
    let srcStat;
    try {
      srcStat = fs.statSync(latestJpeg);
    } catch {
      return { ok: false, error: `找不到 latest.jpg：${latestJpeg}` };
    }
    if (!srcStat.isFile()) {
      return { ok: false, error: `latest.jpg 不是文件：${latestJpeg}` };
    }
    if (srcStat.size === 0) {
      return { ok: false, error: 'latest.jpg 是 0 字节（源还没出画面）' };
    }

    // tick.ts 正常是 Date.now() 毫秒；万一采集层给的是「相对计时器」，文件名会变成 1970，
    // 所以这里做一次合理性校验，不合理的直接用当前时间。
    const rawTs = tick && Number(tick.ts);
    const ts = Number.isFinite(rawTs) && rawTs >= MIN_TIMESTAMP_MS && rawTs <= Date.now() + 86_400_000
      ? rawTs
      : Date.now();
    const inboxDir = path.join(String(dataDir), 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });

    const stamp = stampOf(ts);
    const sid = safeId(sourceId);
    let target = path.join(inboxDir, `${stamp}-${sid}.jpg`);
    // 同一秒同一源再来一张：用 '~N' 后缀（'~' 排序在所有常见字符之后，不会打乱时间序）
    for (let i = 1; fs.existsSync(target); i++) {
      target = path.join(inboxDir, `${stamp}-${sid}~${i}.jpg`);
      if (i >= 1000) break; // 极端情况下别死循环
    }

    fs.copyFileSync(latestJpeg, target);
    const bytes = fs.statSync(target).size;
    const removed = rotate(inboxDir, keep);

    return { ok: true, path: target, bytes, ts, removed };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return { ok: false, error: `定格失败：${msg}` };
  }
}
