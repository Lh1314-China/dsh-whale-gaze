/**
 * dsh-whale-gaze · 溯光
 *
 * 一双常开的、便宜的眼睛：摄像头或屏幕上的视频页面，
 * 平时只在本地看低分辨率小帧（0 token），眼睛跟着画面里动的东西转，
 * 值得注意的瞬间定格成一张照片，再往下一轮思考里塞一行字。
 *
 * 三档开销：
 *   L0 看   8fps / 64x36 / 本地运动+肤色感知      —— 不进上下文
 *   L1 记   每轮 prompt 一行「视线：…」            —— 20~40 token
 *   L2 定格 兴趣过线 / 模型主动 freeze → 一张图     —— 按需 read_image
 *
 * 采集在 lib/frames.js，感知在 lib/sense.js，闸门在 lib/gate.js，
 * 眼神在 lib/vts.js，工具在 lib/tools.js。这里是装配与生命周期。
 *
 * 0.1.1：快照 6fps（预览不拖影）、眼动增益/偏置可运行时 tune、VTS 连接等 25s。
 * 0.1.2：增益上限放开到 1.0（这个模型的 EyeX 视觉位移窄）；tune 支持 0.1~1.0。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSource, listCameras } from './lib/frames.js';
import { createAnalyzer } from './lib/sense.js';
import { createGate, directionLabel, freeze } from './lib/gate.js';
import { createVtsSink, createFileSink } from './lib/vts.js';
import { createEyeTool } from './lib/tools.js';

/**
 * 记账：启动时对外报三样东西——
 *   名分（package.json 的 version）、身子（真正被加载的文件路径）、谁在跑（pid）。
 * 目的：验收只认跑出来的行为，出问题时能一眼对上「这个版本、这个文件、这个进程」。
 */
export const VERSION = readVersion();
export const LOADED_FROM = fileURLToPath(import.meta.url);

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return String(pkg.version || 'unknown');
  } catch {
    return 'unknown';
  }
}

export const name = 'whale-gaze';
export const inject = ['tools', 'systemPrompt'];

// ── 记账：所有分支（成功/失败/退出）都写同一本账 ───────────────────────
// 桌面版 host 的 stdout 不进任何文件，所以只往 console 打等于没记。
// 这里的规则：能写文件就写文件；连文件都写不进，才退回 console——
// 而且回退时要把「记账本身失败了」这件事也写进那行，别假装记上了。
let LOG_FILE = null;
const LOG_MAX_BYTES = 1024 * 1024;

/** 需要轮转时返回要记的备注；不需要/正常（还没有日志）返回空。 */
function rotateIfNeeded(file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch (err) {
    if (err && err.code === 'ENOENT') return ''; // 还没有日志，正常
    return `stat_failed=${err && err.code ? err.code : String(err)}`;
  }
  if (size <= LOG_MAX_BYTES) return '';
  try {
    fs.renameSync(file, `${file}.1`);
    return `rotated_from=${size}B`;
  } catch (err) {
    // 轮转失败不能被当成「文件还不存在」——单独记，别吞。
    return `rotate_failed=${err && err.code ? err.code : String(err)}`;
  }
}

function logLine(level, message) {
  const ts = new Date().toISOString();
  // LOG_FILE 空着也要有地方去：给一个固定默认路径，不让记账退回 console。
  const file = LOG_FILE || path.join(os.homedir(), '.dsh', 'whale-gaze', 'plugin.log');
  const note = rotateIfNeeded(file);
  const line = `${ts} · ${level} · pid=${process.pid}${note ? ` · ${note}` : ''} · ${message}`;
  try {
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${line}\n`, 'utf8');
        return;
      } catch {
        /* 落到下面统一回退 */
      }
    }
    // 最后的出口：文件写不进去就只能打 stdout；但要把失败原因带出来。
    console.warn(`[whale-gaze] log write failed (${err && err.code ? err.code : err}); line: ${line}`);
  }
}

const GAZE_TICK_MS = 80;
const GAZE_ALPHA = 0.25;
const HOLD_MS = 4000;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function hhmmss(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 0..1 归一化坐标 → 九宫格方位（与 gate.js 同一套方言，如「右中」） */
function compass(x, y) {
  return directionLabel(x, y);
}

function normalizeConfig(config = {}) {
  const sources = Array.isArray(config.sources) && config.sources.length > 0
    ? config.sources.map((s, i) => ({
        id: String(s?.id || (s?.kind === 'screen' ? 'screen' : s?.kind === 'window' ? 'window' : `cam${i || ''}`)),
        kind: s?.kind === 'screen' || s?.kind === 'window' ? s.kind : 'camera',
        device: s?.device ? String(s.device) : '',
        title: s?.title ? String(s.title) : undefined,
        fps: Number(s?.fps) > 0 ? Number(s.fps) : 8,
        crop: s?.crop && Number(s.crop.w) > 0 ? s.crop : undefined,
      }))
    : [{ id: 'cam', kind: 'camera', device: '', fps: 8 }];

  return {
    ffmpegPath: String(config.ffmpegPath || 'ffmpeg'),
    dataDir: String(config.dataDir || path.join(os.homedir(), '.dsh', 'whale-gaze')),
    autoStart: config.autoStart === true,
    sources,
    threshold: Number.isFinite(Number(config.threshold)) ? Number(config.threshold) : 55,
    cooldownMs: Number(config.cooldownMs) > 0 ? Number(config.cooldownMs) : 6000,
    keep: Number(config.keep) > 0 ? Number(config.keep) : 200,
    promptLine: config.promptLine !== false,
    mirrorX: config.mirrorX === true,
    snapshotFps: Number(config.snapshotFps) >= 1 ? Math.min(30, Math.round(Number(config.snapshotFps))) : 6,
    vts: {
      enabled: config.vts?.enabled !== false,
      port: Number(config.vts?.port) > 0 ? Number(config.vts.port) : 8001,
      invertY: config.vts?.invertY === true,
      invertX: config.vts?.invertX === true,
      gainX: Number.isFinite(Number(config.vts?.gainX)) ? Number(config.vts.gainX) : 0.45,
      gainY: Number.isFinite(Number(config.vts?.gainY)) ? Number(config.vts.gainY) : 0.36,
      biasX: Number.isFinite(Number(config.vts?.biasX)) ? Number(config.vts.biasX) : 0,
      biasY: Number.isFinite(Number(config.vts?.biasY)) ? Number(config.vts.biasY) : 0,
      eyeParams: config.vts?.eyeParams ?? null,
    },
  };
}

function createState(ctx, cfg) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(path.join(cfg.dataDir, 'live'), { recursive: true });
  fs.mkdirSync(path.join(cfg.dataDir, 'inbox'), { recursive: true });

  const state = {
    cfg,
    /** @type {Map<string, {def: object, source: any, analyzer: any, gate: any, tick: any, error: string|null}>} */
    sources: new Map(),
    /** @type {Array<{ts:number,id:string,path:string,note:string}>} */
    events: [],
    gaze: { x: 0, y: 0 },
    aim: { on: false, x: 0, y: 0 },
    lastMotionAt: Date.now(),
    nextSourceNumber: 1,
    vts: null,
    fileSink: null,
  };

  const running = () => [...state.sources.values()].filter((e) => e.source?.status?.().running);

  function pick(id) {
    if (id) return state.sources.get(id) ?? null;
    return running()[0] ?? state.sources.values().next().value ?? null;
  }

  function recordFreeze(entry, reason) {
    const res = freeze({
      latestJpeg: entry.source.latestJpeg(),
      dataDir: cfg.dataDir,
      sourceId: entry.def.id,
      tick: entry.tick,
      keep: cfg.keep,
    });
    if (!res.ok) {
      entry.error = res.error ? String(res.error) : 'freeze failed';
      logLine('warn', `freeze failed (${entry.def.id}): ${entry.error}`);
      return null;
    }
    state.events.unshift({ ts: res.ts, id: entry.def.id, path: res.path, note: reason });
    if (state.events.length > 40) state.events.length = 40;
    return res;
  }

  function onFrame(entry, rgb, ts) {
    try {
      const tick = entry.analyzer.push(rgb, ts);
      entry.tick = tick;
      const verdict = entry.gate.evaluate(tick);
      if (verdict.fire) recordFreeze(entry, verdict.reason || '');
    } catch (err) {
      entry.error = err && err.message ? err.message : String(err);
    }
  }

  /**
   * 把一张 jpg 交给 attachments，换回原生 image block 的元数据。
   * 失败（服务没挂 / 图太大 / 读不到）就返回 null，退回「只有路径」的老路。
   */
  async function attachFrame(file) {
    try {
      const attachments = ctx.get('attachments');
      if (!attachments || !file || !fs.existsSync(file)) return null;
      const ref = await attachments.saveImage({
        data: fs.readFileSync(file),
        mediaType: 'image/jpeg',
        name: path.basename(file),
      });
      return {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      };
    } catch (err) {
      logLine('warn', `attachment failed: ${err && err.message ? err.message : err}`);
      return null;
    }
  }

  state.start = async function start(def) {
    const id = def.id;
    const existing = state.sources.get(id);
    if (existing?.source?.status?.().running) {
      return `${id} 已经在跑了（${existing.def.kind}）`;
    }
    const merged = {
      id,
      kind: def.kind ?? 'camera',
      device: def.device ?? cfg.sources.find((s) => s.id === id)?.device,
      title: def.title ?? cfg.sources.find((s) => s.id === id)?.title,
      fps: cfg.sources.find((s) => s.id === id)?.fps ?? 8,
      crop: cfg.sources.find((s) => s.id === id)?.crop,
    };
    if (merged.kind === 'camera' && !String(merged.device || '').trim()) {
      const cameras = await listCameras(cfg.ffmpegPath);
      if (cameras.length === 0) {
        return `${id} 没找到摄像头：请连接设备，或在配置里显式写 device（可用 ffmpeg -list_devices true -f dshow -i dummy 查看）`;
      }
      merged.device = cameras[0];
      logLine('info', `摄像头自动选择：${merged.device}`);
    }

    const entry = {
      def: merged,
      analyzer: createAnalyzer(),
      gate: createGate({ threshold: cfg.threshold, cooldownMs: cfg.cooldownMs }),
      tick: null,
      error: null,
      source: null,
    };
    const source = createSource({
      ...merged,
      ffmpegPath: cfg.ffmpegPath,
      dataDir: cfg.dataDir,
      snapshotFps: cfg.snapshotFps,
      onFrame: (rgb, ts) => onFrame(entry, rgb, ts),
    });
    entry.source = source;
    state.sources.set(id, entry);
    try {
      await source.start();
      state.ensureVts?.();
      return `${id} 已睁眼：${merged.kind}${merged.device && merged.kind === 'camera' ? ` (${merged.device})` : ''} ${merged.fps}fps`;
    } catch (err) {
      entry.error = err && err.message ? err.message : String(err);
      logLine('error', `source ${id} start failed: ${entry.error}`);
      await source.stop().catch(() => {});
      state.sources.delete(id);
      return `打开 ${id} 失败：${entry.error}`;
    }
  };

  state.stop = async function stop(id) {
    const targets = id ? [state.sources.get(id)].filter(Boolean) : [...state.sources.values()];
    if (targets.length === 0) return id ? `没有这个源：${id}` : '本来就没睁眼。';
    for (const entry of targets) {
      try {
        await entry.source.stop();
      } catch {
        /* 停不掉也别卡住 */
      }
      state.sources.delete(entry.def.id);
    }
    if (targets.some((e) => e.def.id === id) || !id) state.gaze = { x: 0, y: 0 };
    const ids = targets.map((e) => e.def.id).join(',');
    logLine('info', `stop source=${ids}`);
    return ids + ' 已闭眼。';
  };

  state.look = async function look(id, wantFreeze) {
    const entry = pick(id);
    if (!entry) return { text: '没有可看的源：用 eye_see action=start 先睁眼。' };
    const lines = [];
    const st = entry.source.status();
    const t = entry.tick;
    if (!st.running) lines.push(`${entry.def.id} ${entry.def.kind} 未运行${st.error ? `：${st.error}` : ''}`);
    else if (!t) lines.push(`${entry.def.id} 已启动，还没收到第一帧`);
    else {
      lines.push(
        `${entry.def.id} ${entry.def.kind} ${st.fps}fps 帧 ${st.frames}｜动 ${Math.round(t.motion * 100)}% 偏${compass(
          t.centroid[0],
          t.centroid[1],
        )}｜分 ${Math.round(t.score)}${t.scene ? '｜场景刚变' : ''}`,
      );
    }

    let imageFile = null;
    if (wantFreeze) {
      const res = recordFreeze(entry, 'look');
      if (res) {
        lines.push('下面这张是刚定格的。');
        imageFile = res.path;
      } else {
        lines.push(`定格失败：${entry.error || 'unknown'}`);
      }
    } else {
      const latest = entry.source.latestJpeg();
      if (fs.existsSync(latest)) {
        lines.push('下面这张是此刻的画面（最多晚一秒）。');
        imageFile = latest;
      } else {
        lines.push('还没有画面可看。');
      }
    }

    const last = state.events[0];
    if (last) lines.push(`最近一次定格：${hhmmss(last.ts)}（${last.id}${last.note ? ` ${last.note}` : ''}）`);
    lines.push(`眼神：${state.gaze.x.toFixed(2)}, ${state.gaze.y.toFixed(2)}${state.aim.on ? '（手动瞄准）' : ''}`);

    const frame = imageFile === null ? null : await attachFrame(imageFile);
    if (imageFile !== null && frame === null) lines.push(`图没挂上，路径在这：${imageFile}`);
    return { text: lines.join('\n'), ...(frame === null ? {} : { frame }) };
  };

  state.freezeNow = async function freezeNow(id, note) {
    const entry = pick(id);
    if (!entry) return { text: '没有可定格的源：先 eye_see action=start。' };
    const res = recordFreeze(entry, note || 'manual');
    if (!res) return { text: `定格失败：${entry.error || 'unknown'}` };
    const frame = await attachFrame(res.path);
    return {
      text: `定格：${hhmmss(res.ts)}（${entry.def.id}${note ? ` · ${note}` : ''}）${frame === null ? `\n路径：${res.path}` : ''}`,
      ...(frame === null ? {} : { frame }),
    };
  };

  /**
   * 运行时调参：增益（眼睛偏多少）与偏置（整体往哪边看）。
   * 当场生效，不用重连、不用重启。只传想改的那几项。
   */
  state.tune = function tune(opts = {}) {
    if (!state.vts) return 'vts disabled（没开皮套，调不了）';
    const applied = state.vts.setGaze({
      gainX: opts.gainX,
      gainY: opts.gainY,
      biasX: opts.biasX,
      biasY: opts.biasY,
    });
    return `gain ${applied.gainX.toFixed(2)} / ${applied.gainY.toFixed(2)}｜bias ${applied.biasX.toFixed(2)} / ${applied.biasY.toFixed(2)}`;
  };

  state.promptLine = function promptLine() {
    const live = running();
    if (live.length === 0) return '';
    const parts = live.slice(0, 2).map((entry) => {
      const t = entry.tick;
      if (!t) return `${entry.def.id} 启动中`;
      if (t.motion < 0.01) return `${entry.def.id} 静止`;
      return `${entry.def.id} 动 ${Math.round(t.motion * 100)}% 偏${compass(t.centroid[0], t.centroid[1])}`;
    });
    let line = `视线：${parts.join('｜')}`;
    const last = state.events[0];
    if (last && Date.now() - last.ts < 60_000) line += `｜刚定格 ${hhmmss(last.ts)}（${last.id}）`;
    return line.slice(0, 120);
  };

  state.statusText = function statusText() {
    const entries = [...state.sources.values()];
    if (entries.length === 0) {
      return '眼睛没睁：没有源。用 eye_see action=start（camera / screen / window）打开。';
    }
    const lines = [];
    for (const entry of entries) {
      const st = entry.source.status();
      const t = entry.tick;
      const stateWord = st.running ? 'running' : 'stopped';
      const detail = t
        ? `动 ${Math.round(t.motion * 100)}% 偏${compass(t.centroid[0], t.centroid[1])} 分 ${Math.round(t.score)}`
        : 'no frame yet';
      lines.push(`${entry.def.id} ${entry.def.kind} ${stateWord} ${st.frames ?? 0}帧 ${detail}${st.error ? ` err=${String(st.error).slice(-80)}` : ''}`);
    }
    lines.push(`inbox ${state.events.length} 张${state.events[0] ? `，最近 ${hhmmss(state.events[0].ts)}（${state.events[0].id}）` : ''}`);
    const vtsStatus = state.vts ? state.vts.status() : null;
    lines.push(
      vtsStatus
        ? `vts ${vtsStatus.connected ? (vtsStatus.authorized ? 'ready' : 'connected, unauthorized') : 'unconnected'}${vtsStatus.eyeParams && vtsStatus.eyeParams.x.length ? ` eye=${vtsStatus.eyeParams.x.join('+')}/${vtsStatus.eyeParams.y.join('+')} (${vtsStatus.eyeParams.sourceX}/${vtsStatus.eyeParams.sourceY})` : ''}${vtsStatus.lastError ? ` (${vtsStatus.lastError})` : ''}`
        : 'vts disabled',
    );
    lines.push(`gaze ${state.gaze.x.toFixed(2)},${state.gaze.y.toFixed(2)}${state.aim.on ? ' manual' : ''}`);
    return lines.join('\n');
  };

  return state;
}

/**
 * @param {import('cordis').Context} ctx
 * @param {any} [config]
 */
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  // 记账路径必须最先定：autoStart 里的失败可能发生在 ready 行之前，
  // 晚赋值会让那一段退回 console（等于没记）。
  LOG_FILE = path.join(cfg.dataDir, 'plugin.log');

  ctx.effect(() => {
    const state = createState(ctx, cfg);

    // ---- 眼神：把「最近一次动静的中心」平滑成眼位，喂给皮套 ----
    const gazeTimer = setInterval(() => {
      const live = [...state.sources.values()].filter((e) => e.source?.status?.().running);
      let target = { x: 0, y: 0 };
      if (state.aim.on) {
        target = { x: state.aim.x, y: state.aim.y };
      } else {
        const t = live.find((e) => e.tick)?.tick;
        if (t && t.motion > 0.006) {
          const rawX = t.centroid[0] * 2 - 1;
          target = {
            x: clamp(cfg.mirrorX ? -rawX : rawX, -1, 1),
            y: clamp(-(t.centroid[1] * 2 - 1), -1, 1),
          };
          state.lastMotionAt = Date.now();
        } else if (Date.now() - state.lastMotionAt > HOLD_MS) {
          target = { x: 0, y: 0 };
        } else {
          target = { x: state.gaze.x, y: state.gaze.y };
        }
      }
      state.gaze.x += (target.x - state.gaze.x) * GAZE_ALPHA;
      state.gaze.y += (target.y - state.gaze.y) * GAZE_ALPHA;

      // 没有源在跑、也没手动瞄准时，**什么都不写**：
      // 不碰 VTS 的 Eye*（别跟直播面捕抢参数），也不写 gaze.json。
      const active = state.aim.on || live.length > 0;
      if (!active) {
        state.gaze.x = 0;
        state.gaze.y = 0;
        return;
      }
      try {
        state.vts?.inject(state.gaze.x, state.gaze.y);
        state.fileSink?.write(state.gaze.x, state.gaze.y);
      } catch {
        /* 皮套挂了不能拖累眼睛 */
      }
    }, GAZE_TICK_MS);
    if (typeof gazeTimer.unref === 'function') gazeTimer.unref();

    // ---- 皮套：只建对象，**不在启动时连** ----
    // 原因：DSH 一启动就连 VTS，会弹一次授权、还会在没有任何源时持续写 Eye* 参数，
    // 跟 VTS 自己的面捕抢同一组参数。所以改成「有源开跑 / 手动瞄准」时才连。
    state.vts = cfg.vts.enabled
      ? createVtsSink({
          port: cfg.vts.port,
          invertY: cfg.vts.invertY,
          invertX: cfg.vts.invertX,
          gainX: cfg.vts.gainX,
          gainY: cfg.vts.gainY,
          biasX: cfg.vts.biasX,
          biasY: cfg.vts.biasY,
          eyeParams: cfg.vts.eyeParams,
          logger: (level, message) => logLine(`vts-${level}`, message),
        })
      : null;
    state.ensureVts = () => {
      if (!state.vts || state.vtsWanted) return;
      state.vtsWanted = true;
      void state.vts.connect().catch((err) => {
        logLine('error', `VTS unavailable: ${err && err.message ? err.message : err}`);
      });
    };
    state.fileSink = createFileSink(path.join(cfg.dataDir, 'gaze'));

    // ---- 工具 ----
    const disposeTool = ctx.tools.register(createEyeTool(state));

    // ---- 每轮思考注入一行 ----
    const disposeContext = cfg.promptLine && ctx.systemPrompt
      ? ctx.systemPrompt.context({ name: 'whale-gaze', order: 900, text: () => state.promptLine() })
      : () => {};

    if (cfg.autoStart) {
      for (const def of cfg.sources) {
        void state.start(def);
      }
    }

    const readyLine = [
      'ready',
      `v${VERSION}`,
      `loaded=${LOADED_FROM}`,
      `data=${cfg.dataDir}`,
      `sources=${cfg.sources.map((s) => s.id).join(',')}`,
    ].join(' · ');
    logLine('info', readyLine);
    console.info(`[whale-gaze] ${readyLine}`);

    return () => {
      // 退出也要留一行：否则「只有一行 ready」既可能是刚启动，也可能是跑了很久才被关。
      const live = [...state.sources.keys()].join(',') || '(none)';
      logLine('info', `shutdown · sources=${live}`);
      clearInterval(gazeTimer);
      disposeContext();
      disposeTool();
      if (state.vts) {
        try {
          state.vts.dispose();
        } catch {
          /* ignore */
        }
      }
      for (const entry of state.sources.values()) {
        void entry.source.stop().catch(() => {});
      }
      state.sources.clear();
    };
  }, 'whale-gaze eyes');
}
