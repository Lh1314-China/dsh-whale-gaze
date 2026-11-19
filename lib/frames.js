/**
 * dsh-whale-gaze / lib/frames.js —— ffmpeg 采集层：一个源 = 一个子进程、两路输出。
 *
 * 设计（都是实测踩过的坑，改之前先读）：
 *   1. 一个 ffmpeg 进程同时吐两样东西：小帧（默认 64×36 rgb24）走 stdout，
 *      1fps 快照覆盖写 <dataDir>/live/<id>/latest.jpg。小帧只喂本地感知，
 *      绝不进模型上下文；快照只在「定格」时才被拷走。
 *   2. stdout 是无边界字节流，不是「一条消息一帧」：必须按 frameBytes 切，
 *      半帧尾巴缓存在 partial 里等下一块。假设 chunk 对齐会拿到碎帧。
 *   3. start() 以「第一帧真的到了」为准（最多等 3s）。摄像头被别的进程占着时
 *      ffmpeg 常常照样活着、stderr 也只留一句警告，但 stdout 一字节没有 ——
 *      只看进程在不在，会把「假活」当成功。
 *   4. stop() 必须等到 close 才返回：摄像头是独占资源，上一个 ffmpeg 没死透，
 *      下一个就拿不到帧。等不到就用 taskkill /T /F 兜底，绝不留僵尸。
 *   5. 命令行一律用参数数组交给 spawn，Windows 路径/窗口标题里的空格与中文
 *      原样保留，不拼字符串（拼了就会被当命令解析）。
 *
 * 只依赖 node 内建模块，不引 npm 包。
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { clearTimeout as clearTimer, setTimeout as setTimer } from 'node:timers';

const DEFAULT_FPS = 8;
const DEFAULT_WIDTH = 64;
const DEFAULT_HEIGHT = 36;
const DEFAULT_SNAPSHOT_WIDTH = 960;
const DEFAULT_SNAPSHOT_FPS = 6; // 快照帧率：1 会拖影，6 看着才像「实时」
const FIRST_FRAME_TIMEOUT_MS = 3000;
const STOP_GRACE_MS = 1500; // kill 之后等 close 的宽限
const FORCE_KILL_WAIT_MS = 1500; // taskkill 之后再等 close
const STDERR_KEEP = 4096; // 多留一点上下文，报错时只取尾巴 300 字
const STDERR_TAIL = 300;

/** 数字参数夹成 [min, max] 的整数；不是数就回退默认值。 */
function intIn(value, fallback, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** crop 可缺省；给了就把 w/h 收成正整数，x/y 默认 0。宽高两种写法都收：{w,h} 或 {width,height}。 */
function normalizeCrop(crop) {
  if (!crop || typeof crop !== 'object') return null;
  const w = Math.round(Number(crop.w ?? crop.width));
  const h = Math.round(Number(crop.h ?? crop.height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const x = Math.max(0, Math.round(Number(crop.x) || 0));
  const y = Math.max(0, Math.round(Number(crop.y) || 0));
  return { w, h, x, y };
}

/**
 * 输入段：摄像头 / 屏幕 / 窗口。
 * inputArgs 是自测（以及将来接 rtsp / 文件）的逃生门：整段替换，默认不传。
 */
function inputArgsFor({ kind, device, title, fps, inputArgs }) {
  if (Array.isArray(inputArgs) && inputArgs.length > 0) return inputArgs.slice();
  if (kind === 'camera') {
    return ['-f', 'dshow', '-rtbufsize', '64M', '-i', `video=${device}`];
  }
  if (kind === 'screen') {
    return ['-f', 'gdigrab', '-framerate', String(fps), '-i', 'desktop'];
  }
  // kind === 'window'：createSource 已保证 title 非空
  return ['-f', 'gdigrab', '-framerate', String(fps), '-i', `title=${title}`];
}

/** 滤镜图：可选 crop 打头，split 成「小帧」和「快照」两路。快照帧率默认 6（预览更顺）。 */
function filterGraphFor({ width, height, fps, snapshotWidth, snapshotFps, crop }) {
  const head = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : '';
  return (
    `[0:v]${head}split=2[a][b];` +
    `[a]fps=${fps},scale=${width}:${height},format=rgb24[g];` +
    `[b]fps=${snapshotFps},scale=${snapshotWidth}:-2[q]`
  );
}

/** 完整命令行：结构按 SPEC 固定，别随手改顺序（-map / -update 对位置敏感）。 */
function ffmpegArgsFor(cfg) {
  return [
    '-hide_banner',
    '-loglevel', 'warning',
    ...inputArgsFor(cfg),
    '-filter_complex', filterGraphFor(cfg),
    '-map', '[g]', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    '-map', '[q]', '-q:v', '3', '-f', 'image2', '-update', '1', '-y', cfg.snapshotPath,
  ];
}

/**
 * 建一个采集源。返回 { start, stop, status, latestJpeg, id, kind }。
 *
 * @param {object} options
 * @param {string} options.id               源 id（cam / screen / window）
 * @param {'camera'|'screen'|'window'} options.kind
 * @param {string} [options.device]         摄像头名，默认 "FHD Camera"
 * @param {string} [options.title]          kind=window 时必填
 * @param {number} [options.fps]            小帧帧率，默认 8
 * @param {number} [options.width]          小帧宽，默认 64
 * @param {number} [options.height]         小帧高，默认 36
 * @param {number} [options.snapshotWidth]  快照宽，默认 960
 * @param {number} [options.snapshotFps]    快照帧率，默认 6（预览用；1 会拖影）
 * @param {{w:number,h:number,x?:number,y?:number}} [options.crop]
 * @param {string} options.ffmpegPath       ffmpeg 可执行文件
 * @param {string} options.dataDir          快照根目录
 * @param {string[]} [options.inputArgs]    自测逃生门：整段替换输入参数
 * @param {(rgb: Buffer, ts: number) => void} [options.onFrame] 同步回调，必须快
 * @param {(level: 'info'|'warn'|'error', msg: string) => void} [options.logger]
 */
export function createSource(options = {}) {
  const id = String(options.id ?? 'src').trim() || 'src';
  const kind = options.kind ?? 'camera';
  if (kind !== 'camera' && kind !== 'screen' && kind !== 'window') {
    throw new Error(`createSource: 未知 kind=${kind}（只认 camera / screen / window）`);
  }
  if (!options.dataDir) {
    throw new Error('createSource: 需要 dataDir（latest.jpg 落在这里）');
  }

  const title = typeof options.title === 'string' ? options.title.trim() : '';
  const hasInputOverride = Array.isArray(options.inputArgs) && options.inputArgs.length > 0;
  if (kind === 'window' && !title && !hasInputOverride) {
    throw new Error('createSource: kind=window 必须给 title');
  }

  const fps = intIn(options.fps, DEFAULT_FPS, 1, 60);
  const width = intIn(options.width, DEFAULT_WIDTH, 2, 512);
  const height = intIn(options.height, DEFAULT_HEIGHT, 2, 512);
  const frameBytes = width * height * 3;
  const snapshotWidth = intIn(options.snapshotWidth, DEFAULT_SNAPSHOT_WIDTH, 16, 7680);
  const snapshotFps = intIn(options.snapshotFps, DEFAULT_SNAPSHOT_FPS, 1, 60);
  const device =
    typeof options.device === 'string' && options.device.trim() ? options.device.trim() : '';
  if (kind === 'camera' && !device && !hasInputOverride) {
    throw new Error(
      'createSource: kind=camera 需要设备名；留空时由插件用 listCameras() 自动挑选（见 index.js）',
    );
  }

  const dataDir = path.resolve(String(options.dataDir));
  // 目录名只留安全字符；id 本身仍按传进来的样子暴露在 status 里
  const safeId = id.replace(/[^A-Za-z0-9._-]+/g, '_');
  const liveDir = path.join(dataDir, 'live', safeId);
  const snapshotPath = path.join(liveDir, 'latest.jpg');
  const ffmpegPath = options.ffmpegPath ? String(options.ffmpegPath) : 'ffmpeg';
  const onFrame = typeof options.onFrame === 'function' ? options.onFrame : () => {};
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const inputArgs = hasInputOverride ? options.inputArgs.map(String) : null;
  const crop = normalizeCrop(options.crop);

  const cfg = {
    kind,
    device,
    title,
    fps,
    width,
    height,
    snapshotWidth,
    snapshotFps,
    crop,
    inputArgs,
    snapshotPath,
  };

  let proc = null; // 当前子进程
  let closePromise = null; // 当前子进程的 close
  let stopping = false; // 主动停：close 不再记成错误
  let running = false;
  let frames = 0;
  let lastFrameAt = null;
  let error = null;
  let stderrText = '';
  let partial = Buffer.alloc(0);
  let startTask = null;
  let stopTask = null;

  /** logger 是插件外部塞进来的，它自己炸了不能把采集带下水。 */
  function note(level, message) {
    try {
      logger(level, message);
    } catch {
      /* ignore */
    }
  }

  function appendStderr(chunk) {
    stderrText = (stderrText + chunk).slice(-STDERR_KEEP);
  }

  /** stderr 尾巴：塞进 error / status.error 的那 300 字。 */
  function stderrTail() {
    const text = stderrText.trim();
    return text ? text.slice(-STDERR_TAIL) : '(stderr 无输出)';
  }

  /**
   * 起一个 ffmpeg。不在这里等首帧 —— 由 doStart 统一计时。
   * 返回 { child, closed, firstFrame }，三个都只属于这一次启动。
   */
  function launch() {
    mkdirSync(liveDir, { recursive: true });
    const child = spawn(ffmpegPath, ffmpegArgsFor(cfg), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });

    let resolveFirst;
    let rejectFirst;
    let firstSettled = false;
    const firstFrame = new Promise((resolve, reject) => {
      resolveFirst = resolve;
      rejectFirst = reject;
    });
    const settleFirst = (err) => {
      if (firstSettled) return;
      firstSettled = true;
      if (err) rejectFirst(err);
      else resolveFirst();
    };

    child.once('close', (code, signal) => {
      if (proc === child) {
        running = false;
        partial = Buffer.alloc(0);
      }
      // 首帧没等到就退了：把「为什么」带给 start()
      settleFirst(
        new Error(`ffmpeg 提前退出（code=${code}, signal=${signal ?? '无'}）；stderr: ${stderrTail()}`),
      );
      if (!stopping && proc === child) {
        error = `ffmpeg 退出（code=${code}, signal=${signal ?? '无'}）；stderr: ${stderrTail()}`;
        note('error', `[whale-gaze] ${id} ${error}`);
      }
      resolveClosed({ code, signal });
    });

    child.once('error', (err) => {
      const message = `无法启动 ffmpeg（${ffmpegPath}）：${err && err.message ? err.message : err}`;
      appendStderr(`[spawn] ${message}`);
      error = message;
      running = false;
      note('error', `[whale-gaze] ${id} ${message}`);
      settleFirst(new Error(message));
      // spawn 失败时没有 pid，Windows 上 close 未必会来；自己放行 stop()
      if (child.pid === undefined) resolveClosed({ code: null, signal: null, spawnError: true });
    });

    child.stdout.on('data', (chunk) => {
      if (proc !== child) return; // 旧进程的尾巴，丢弃
      partial = partial.length === 0 ? chunk : Buffer.concat([partial, chunk]);
      while (partial.length >= frameBytes) {
        const frame = partial.subarray(0, frameBytes);
        partial = partial.subarray(frameBytes);
        frames += 1;
        const ts = Date.now();
        lastFrameAt = ts;
        settleFirst(null);
        try {
          // 约定是同步、必须快；这里不 await，也不排队
          onFrame(frame, ts);
        } catch (err) {
          note('warn', `[whale-gaze] ${id} onFrame 抛错（已忽略）：${err && err.message ? err.message : err}`);
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => appendStderr(chunk));

    return { child, closed, firstFrame };
  }

  /** 等 promise 完成，最多 ms；返回 true=完成，false=超时。 */
  function waitFor(promise, ms) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimer(() => {
        if (done) return;
        done = true;
        resolve(false);
      }, ms);
      promise.then(() => {
        if (done) return;
        done = true;
        clearTimer(timer);
        resolve(true);
      });
    });
  }

  /** taskkill /T /F：连子进程一起收，别给摄像头留后门。 */
  function forceKill(pid) {
    return new Promise((resolve) => {
      if (!pid || process.platform !== 'win32') {
        resolve(false);
        return;
      }
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => resolve(false));
      killer.once('close', (code) => resolve(code === 0));
    });
  }

  /** kill 并等 close；这里是「摄像头独占」的唯一保险，不能提前返回。 */
  async function stopInternal() {
    const child = proc;
    if (!child) {
      running = false;
      partial = Buffer.alloc(0);
      return;
    }

    stopping = true;
    running = false;
    partial = Buffer.alloc(0);
    const closed = closePromise;

    try {
      try {
        child.kill('SIGTERM');
      } catch (err) {
        note('warn', `[whale-gaze] ${id} kill 失败（继续等 close）：${err && err.message ? err.message : err}`);
      }

      let exited = await waitFor(closed, STOP_GRACE_MS);
      if (!exited) {
        note('warn', `[whale-gaze] ${id} 进程 ${child.pid} ${STOP_GRACE_MS}ms 内没退出，taskkill /T /F 兜底`);
        if (process.platform === 'win32') {
          await forceKill(child.pid);
        } else {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
        exited = await waitFor(closed, FORCE_KILL_WAIT_MS);
      }

      if (exited) {
        if (proc === child) {
          proc = null;
          closePromise = null;
        }
      } else {
        // 没等到 close 就保留句柄：下一次 stop() 还能再杀一次，
        // 否则「以为停了」会直接撞上摄像头独占
        error = error || `ffmpeg 进程 ${child.pid} 杀不掉（可能权限不足）`;
        throw new Error(error);
      }
    } finally {
      stopping = false;
    }
  }

  async function doStart() {
    // 上一个 stop 还在等 close、或残留了一个死进程：先收干净再起新的
    if (stopTask) await stopTask;
    if (proc) await stopInternal();

    frames = 0;
    lastFrameAt = null;
    error = null;
    stderrText = '';
    partial = Buffer.alloc(0);

    let run;
    try {
      run = launch();
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      error = message;
      running = false;
      throw new Error(`ffmpeg 启动失败：${message}`);
    }

    proc = run.child;
    closePromise = run.closed;
    running = true;

    let timer = null;
    try {
      await Promise.race([
        run.firstFrame,
        new Promise((_, reject) => {
          timer = setTimer(() => {
            reject(
              new Error(
                `ffmpeg ${FIRST_FRAME_TIMEOUT_MS}ms 内没有吐出一帧（id=${id}, kind=${kind}）；stderr: ${stderrTail()}`,
              ),
            );
          }, FIRST_FRAME_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      error = message;
      note('error', `[whale-gaze] ${id} 启动失败：${message}`);
      try {
        await stop();
      } catch (stopErr) {
        note('warn', `[whale-gaze] ${id} 启动失败后收尾也失败：${stopErr && stopErr.message ? stopErr.message : stopErr}`);
      }
      throw new Error(message);
    } finally {
      clearTimer(timer);
    }

    note('info', `[whale-gaze] ${id} 已起（pid=${run.child.pid}, ${fps}fps, ${width}×${height}）`);
    return status();
  }

  /** 起进程，等到第一帧（最多 3s）；成功返回 status()，失败抛错并已收干净。 */
  function start() {
    if (startTask) return startTask;
    if (running) return Promise.resolve(status());
    startTask = doStart().finally(() => {
      startTask = null;
    });
    return startTask;
  }

  /** kill 并等 close；重复调用是安全的。 */
  function stop() {
    if (stopTask) return stopTask;
    if (!proc) {
      running = false;
      return Promise.resolve(status());
    }
    stopTask = stopInternal()
      .catch((err) => {
        note('error', `[whale-gaze] ${id} 停不下来：${err && err.message ? err.message : err}`);
        throw err;
      })
      .finally(() => {
        stopTask = null;
      });
    return stopTask;
  }

  /** SPEC 里的那组字段；error 里始终带着 stderr 尾巴（有错时）。 */
  function status() {
    return {
      id,
      kind,
      running,
      pid: running && proc && Number.isInteger(proc.pid) ? proc.pid : null,
      fps,
      frames,
      lastFrameAt,
      error,
      latestJpeg: snapshotPath,
    };
  }

  /** latest.jpg 的绝对路径（可能还不存在）。 */
  function latestJpeg() {
    return snapshotPath;
  }

  return { id, kind, start, stop, status, latestJpeg };
}

/**
 * 列出本机摄像头（ffmpeg dshow）。设备名留空时由 index.js 用它自动挑第一个。
 * 失败（没有 ffmpeg、没有设备）返回空数组，不抛错——调用方据此给出可读提示。
 * @param {string} [ffmpegPath]
 * @returns {Promise<string[]>} 视频设备名
 */
export function listCameras(ffmpegPath = 'ffmpeg') {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        String(ffmpegPath || 'ffmpeg'),
        ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
        { windowsHide: true },
      );
    } catch {
      resolve([]);
      return;
    }
    let text = '';
    let settled = false;
    const finish = (names) => {
      if (settled) return;
      settled = true;
      resolve(names);
    };
    child.stdout?.on('data', (chunk) => { text += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { text += chunk.toString('utf8'); });
    child.once('error', () => finish([]));
    child.once('close', () => finish(parseCameraList(text)));
    const timer = setTimer(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      finish(parseCameraList(text));
    }, 5000);
    timer.unref?.();
  });
}

/** 从 ffmpeg 的 -list_devices 输出里抠出 `"名字" (video)`。 */
function parseCameraList(text) {
  const names = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/"([^"]+)"\s*\(video\)/);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}
