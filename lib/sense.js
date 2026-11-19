// sense.js —— 小帧感知：把一帧 64x36 的 rgb24 原始像素压成一个可以进 Prompt 的 Tick。
//
// 为什么长这样：
// - 常开 8fps，所以必须便宜：一帧 2304 像素，单趟 for 循环算完亮度/肤色/帧差，
//   亮度缓冲只在构造时 new 两块、每帧 swap，不在热路径上分配大数组。
// - 纯函数：状态只有闭包里的「上一帧亮度 + 帧计数」，同一串帧进来永远得到同一串 Tick，
//   selftest 才好写；上层也不需要知道算法细节，只拿 push(rgb, ts)。
// - 第一帧没有「上一帧」，所以位移类字段（motion/centroid/bbox/score）给中性值
//   （0 / 居中 / 空框 / 0 分），scene=true 让上层知道「这是刚睁眼」。

const MOTION_DIFF = 12;      // 亮度差 > 12 才算「在动」，压掉传感器噪声
const SCENE_MEAN_DIFF = 38;  // 全帧平均亮度差 > 38 判为换场景（切窗口/开灯）
const DARK_LUMA = 0.06;      // 平均亮度低于这个值认为「太黑，没什么可看的」

/** 把数字夹到 [lo, hi]。 */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 校验并归一化宽高：必须是正整数。 */
function side(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError(`createAnalyzer: ${name} 必须是正整数，收到 ${String(value)}`);
  }
  return n;
}

/**
 * 创建分析器。返回 { push(rgb, ts) }。
 * rgb 必须是 width*height*3 字节的 Buffer/Uint8Array（ffmpeg rawvideo rgb24）。
 */
export function createAnalyzer({ width = 64, height = 36 } = {}) {
  const w = side(width, 'width', 64);
  const h = side(height, 'height', 36);
  const px = w * h;
  const need = px * 3;

  // 复用缓存：两块亮度图轮流当「上一帧」，避免每帧 new Float32Array。
  const lumaA = new Float32Array(px);
  const lumaB = new Float32Array(px);
  let prevLuma = null; // 上一帧亮度（null = 还没收到过帧）
  let nextLuma = lumaA; // 本帧算进哪块
  let frames = 0;

  /**
   * 吃一帧，出一份 Tick。
   * @param {Uint8Array} rgb width*height*3 字节原始像素
   * @param {number} ts 时间戳（ms）；非法值用 Date.now() 兜底
   */
  function push(rgb, ts) {
    if (!rgb || typeof rgb.length !== 'number') {
      throw new TypeError(`push: 需要 Buffer/Uint8Array，收到 ${rgb === null ? 'null' : typeof rgb}`);
    }
    if (rgb.length !== need) {
      throw new RangeError(
        `push: 帧长度不对，期望 ${need} 字节（${w}x${h}x3），实际 ${rgb.length} 字节`,
      );
    }
    const at = Number.isFinite(ts) ? Number(ts) : Date.now();

    const cur = nextLuma;
    const prev = prevLuma;

    // —— 单趟循环：亮度 / 方差 / 肤色 / 帧差 / 运动质心 / 运动包围盒 ——
    let sumY = 0;
    let sumY2 = 0;
    let skinCount = 0;
    let sumAbsDiff = 0; // 全帧绝对差之和（判场景用）
    let moving = 0; // 运动像素数
    let weight = 0; // 运动权重和（按差值加权）
    let cx = 0;
    let cy = 0;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const p = i * 3;
        const r = rgb[p];
        const g = rgb[p + 1];
        const b = rgb[p + 2];

        const yv = 0.299 * r + 0.587 * g + 0.114 * b;
        cur[i] = yv;
        sumY += yv;
        sumY2 += yv * yv;

        // 肤色：YCbCr 粗判（先过 Y>40 再说，太暗的像素直接跳过 Cb/Cr 两次乘法）
        if (yv > 40) {
          const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
          if (cb >= 77 && cb <= 127) {
            const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
            if (cr >= 133 && cr <= 173) skinCount++;
          }
        }

        if (prev !== null) {
          const d = yv - prev[i];
          const ad = d < 0 ? -d : d;
          sumAbsDiff += ad;
          if (ad > MOTION_DIFF) {
            moving++;
            weight += ad;
            cx += ad * (x + 0.5);
            cy += ad * (y + 0.5);
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
    }

    frames++;

    // 亮度 / 对比度 / 肤色占比
    const meanY = sumY / px;
    const variance = sumY2 / px - meanY * meanY;
    const std = variance > 0 ? Math.sqrt(variance) : 0;
    const brightness = meanY / 255;
    const contrast = clamp(std / 128, 0, 1); // 亮度标准差 / 128
    const skin = skinCount / px;

    // 运动量、质心、包围盒
    const motion = moving / px;
    let centroid = [0.5, 0.5];
    let bbox = [0, 0, 0, 0];
    if (moving > 0 && weight > 0) {
      centroid = [cx / weight / w, cy / weight / h];
      bbox = [minX / w, minY / h, (maxX - minX + 1) / w, (maxY - minY + 1) / h];
    }

    // 首帧 = 睁眼；否则看全帧平均差值是否超过阈值
    const first = prev === null;
    const meanAbsDiff = first ? 0 : sumAbsDiff / px;
    const scene = first || meanAbsDiff > SCENE_MEAN_DIFF;

    // 兴趣分：首帧固定 0（还没有「变化」可言）
    let score = 0;
    if (!first) {
      const motionArea = bbox[2] * bbox[3]; // 运动包围盒占画面多大一块
      const skinBoost = skin > 0.06 ? Math.min(1, skin * 6) : 0;
      const base = 100 * (0.55 * motion + 0.25 * Math.min(1, motionArea * 4) + 0.2 * skinBoost);
      let s = base + (scene ? 15 : 0);
      if (brightness < DARK_LUMA) s *= 0.4; // 太黑，没什么可看
      score = Math.round(clamp(s, 0, 100) * 100) / 100;
    }

    // 本帧当下一帧的「上一帧」
    prevLuma = cur;
    nextLuma = cur === lumaA ? lumaB : lumaA;

    return {
      ts: at,
      w,
      h,
      frames,
      motion,
      centroid,
      bbox,
      brightness,
      contrast,
      skin,
      scene,
      score,
    };
  }

  return { push };
}
