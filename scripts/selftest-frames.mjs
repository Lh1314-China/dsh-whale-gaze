#!/usr/bin/env node
/**
 * scripts/selftest-frames.mjs —— 采集层自测（不碰摄像头）。
 *
 * 用 ffmpeg lavfi 的 testsrc 当假摄像头，跑 lib/frames.js 的真实生命周期：
 *   start() 等首帧 → stdout 按 6912 字节切帧 → latest.jpg 落盘 → stop() 等 close
 *   → 确认没有残留进程（摄像头独占，残留一个就够下一次全黑）。
 * 额外压三条失败路径：ffmpeg 不存在（spawn error）、3s 内不出帧（超时）、
 * 重启后仍能正常出帧。
 *
 * 跑法（插件目录）：node scripts/selftest-frames.mjs
 * 退出码：0 = 全 PASS；1 = 有 FAIL。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createSource } from '../lib/frames.js';

// 本机 ffmpeg；别的机器用 WHALE_GAZE_FFMPEG 覆盖
const FFMPEG =
  process.env.WHALE_GAZE_FFMPEG ||
  process.env.FFMPEG_PATH || 'ffmpeg';

// -re：让 lavfi 按实时 8fps 出帧，接近真实摄像头；不加会瞬间吐出几千帧
const LAVFI_INPUT = ['-re', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=8'];

const FRAME_BYTES = 64 * 36 * 3; // 6912

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'whale-gaze-frames-'));

let passed = 0;
let failed = 0;

/** 一条断言；失败只记数，不中断后面的检查。 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 进程还在不在：signal 0 在 Windows 上就是「查存在」。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** tasklist 第二道证据（偶尔 PID 刚释放，单看 signal 0 不够安心）。 */
function pidInTasklist(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    return out.includes(`"${pid}"`);
  } catch {
    return false;
  }
}

async function main() {
  console.log(`ffmpeg:  ${FFMPEG}`);
  console.log(`dataDir: ${dataDir}`);
  console.log('');

  if (!existsSync(FFMPEG)) {
    check('ffmpeg 存在', false, `找不到 ${FFMPEG}（可用 WHALE_GAZE_FFMPEG 覆盖）`);
    return;
  }

  const received = [];
  const source = createSource({
    id: 'selftest',
    kind: 'screen',
    inputArgs: LAVFI_INPUT, // 自测逃生门：不抓真桌面
    ffmpegPath: FFMPEG,
    dataDir,
    fps: 8,
    onFrame(rgb, ts) {
      // 回调约定同步、快；这里只收长度和时间戳
      received.push({ bytes: rgb.length, isBuffer: Buffer.isBuffer(rgb), ts });
    },
  });

  const initial = source.status();
  check(
    '初始未运行',
    initial.running === false && initial.pid === null && initial.frames === 0,
    `running=${initial.running} pid=${initial.pid} frames=${initial.frames}`,
  );
  check(
    'latestJpeg 是绝对路径',
    path.isAbsolute(initial.latestJpeg) && initial.latestJpeg.endsWith(path.join('live', 'selftest', 'latest.jpg')),
    initial.latestJpeg,
  );
  check('latestJpeg() 与 status 一致', source.latestJpeg() === initial.latestJpeg);

  // ── 1. 主流程：起 → 收帧 2s → 停 ────────────────────────────────
  let pid = null;
  try {
    const t0 = Date.now();
    await source.start();
    const startMs = Date.now() - t0;
    const started = source.status();
    pid = started.pid;
    check('start() 等到首帧才返回', started.running === true && started.frames >= 1, `${started.frames} 帧`);
    check('首帧在 3s 超时内', startMs < 3000, `${startMs}ms`);
    check('pid 有值', Number.isInteger(pid) && pid > 0, `pid=${pid}`);
    await sleep(2000);
  } catch (err) {
    check('start() 成功', false, err && err.message ? err.message.slice(0, 200) : String(err));
  } finally {
    try {
      await source.stop();
    } catch (err) {
      check('stop() 成功', false, err && err.message ? err.message.slice(0, 200) : String(err));
    }
  }

  const stopped = source.status();
  const countAtStop = received.length;
  check('收到 >= 5 帧', countAtStop >= 5, `${countAtStop} 帧`);
  check(
    '每帧正好 6912 字节',
    countAtStop > 0 && received.every((f) => f.bytes === FRAME_BYTES),
    `长度集合: ${[...new Set(received.map((f) => f.bytes))].join(',') || '(无)'}`,
  );
  check('每帧都是 Buffer', countAtStop > 0 && received.every((f) => f.isBuffer));
  check(
    '时间戳单调不减',
    received.every((f, i) => i === 0 || f.ts >= received[i - 1].ts),
  );
  check('status.frames 与回调次数一致', stopped.frames === countAtStop, `${stopped.frames} vs ${countAtStop}`);

  const jpgPath = stopped.latestJpeg;
  const jpgBytes = existsSync(jpgPath) ? statSync(jpgPath).size : 0;
  check('latest.jpg 存在且非空', jpgBytes > 0, `${jpgBytes} B`);

  check('stop() 后未运行', stopped.running === false && stopped.pid === null, `pid=${stopped.pid}`);
  check('stop() 后 status.error 为空', stopped.error === null, String(stopped.error ?? ''));
  check(
    'stop() 后无残留进程',
    pid !== null && !pidAlive(pid) && !pidInTasklist(pid),
    `pid=${pid}`,
  );

  await sleep(300);
  check('stop() 后不再出帧', received.length === countAtStop, `新增 ${received.length - countAtStop} 帧`);

  // ── 2. 重启：旧进程死透了，新进程还能拿到帧 ─────────────────────
  let pid2 = null;
  try {
    await source.start();
    pid2 = source.status().pid;
    check('重启后换了新 pid', Number.isInteger(pid2) && pid2 > 0 && pid2 !== pid, `${pid} → ${pid2}`);
    await sleep(1000);
  } catch (err) {
    check('重启成功', false, err && err.message ? err.message.slice(0, 200) : String(err));
  } finally {
    try {
      await source.stop();
    } catch (err) {
      check('重启后 stop() 成功', false, err && err.message ? err.message.slice(0, 200) : String(err));
    }
  }
  check('重启后继续出帧', received.length - countAtStop >= 3, `新增 ${received.length - countAtStop} 帧`);
  check(
    '重启的进程也退干净',
    pid2 !== null && !pidAlive(pid2) && !pidInTasklist(pid2),
    `pid=${pid2}`,
  );

  // ── 3. 失败分支：ffmpeg 不存在 ─────────────────────────────────
  const ghost = createSource({
    id: 'ghost',
    kind: 'screen',
    inputArgs: LAVFI_INPUT,
    ffmpegPath: path.join(dataDir, 'no-such-ffmpeg.exe'),
    dataDir,
    onFrame() {},
  });
  let ghostErr = null;
  try {
    await ghost.start();
  } catch (err) {
    ghostErr = err;
  }
  await ghost.stop().catch(() => {});
  const ghostStatus = ghost.status();
  check('ffmpeg 不存在时 start() 拒绝', ghostErr instanceof Error, ghostErr ? ghostErr.message.slice(0, 120) : '没有抛错');
  check('错误写进 status.error', typeof ghostStatus.error === 'string' && ghostStatus.error.length > 0);
  check('失败后不在运行态', ghostStatus.running === false && ghostStatus.pid === null);

  // ── 4. 失败分支：进程活着但 3s 内不出帧（摄像头被占的典型样子） ──
  //    开一个本地命名管道接住 ffmpeg 的 rawvideo 连接，但一个字节都不写：
  //    ffmpeg 会卡在等输入上，stdout 全空 —— 和「相机被占」时一模一样。
  const pipeName = `\\\\.\\pipe\\whale-gaze-stall-${process.pid}-${Date.now()}`;
  const sockets = [];
  const pipeServer = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
  });

  let pipeOk = false;
  try {
    await new Promise((resolve, reject) => {
      pipeServer.once('error', reject);
      pipeServer.listen(pipeName, resolve);
    });
    pipeOk = true;
  } catch (err) {
    check('命名管道就绪', false, err && err.message ? err.message : String(err));
  }

  if (pipeOk) {
    const stall = createSource({
      id: 'stall',
      kind: 'screen',
      inputArgs: ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-video_size', '64x36', '-i', pipeName],
      ffmpegPath: FFMPEG,
      dataDir,
      onFrame() {},
    });
    const tStall = Date.now();
    let stallErr = null;
    try {
      await stall.start();
    } catch (err) {
      stallErr = err;
    }
    const stallMs = Date.now() - tStall;
    const stallStatus = stall.status();
    check('3s 无首帧 → start() 抛错', stallErr instanceof Error, stallErr ? stallErr.message.slice(0, 160) : '没有抛错');
    check('超时耗时约 3s', stallMs >= 2900 && stallMs < 15000, `${stallMs}ms`);
    check(
      '超时错误里带 stderr 尾巴',
      stallErr instanceof Error && /stderr/.test(stallErr.message),
      stallErr ? stallErr.message.slice(-120) : '',
    );
    check('超时后未运行', stallStatus.running === false && stallStatus.pid === null, `pid=${stallStatus.pid}`);
    check(
      '超时错误留在 status.error',
      typeof stallStatus.error === 'string' && stallStatus.error.length > 0,
      stallStatus.error ? stallStatus.error.slice(0, 100) : '',
    );
    await stall.stop().catch(() => {});
  }

  // 收尾：先把管道连接断掉，再关服务器，别让测试进程自己吊住
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => pipeServer.close(() => resolve()));
}

try {
  await main();
} catch (err) {
  console.error('UNEXPECTED', err);
  failed += 1;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
