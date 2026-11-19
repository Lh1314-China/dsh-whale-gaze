/**
 * dsh-whale-gaze · lib/vts.js
 *
 * VTube Studio（下称 VTS）眼参数注入：把感知层的注视点变成皮套眼球的转动。
 *
 * 为什么手写 WebSocket，而不是用 ws 包？
 *   1. 插件承诺「无新 npm 依赖」，ws 不在 Node 内置模块里，不能假设 DSH 宿主一定装了它；
 *   2. 我们只需要 RFC6455 客户端侧的一小块：HTTP Upgrade 握手、文本帧、ping/pong、close。
 *      不实现 permessage-deflate（不声明扩展，服务端就不会压缩），二进制帧直接丢弃；
 *   3. 需要完全掌控超时、重连与错误语义 —— inject() 是每帧调用的热路径，任何异常都必须
 *      在内部消化，绝不能冒到主循环；自己写一小层比包一层第三方库更容易证明这一点。
 *   VTS 的 API 只监听 127.0.0.1:8001（本机回环、明文 ws），不涉及跨网、证书与代理。
 *
 * VTS 认证流程（连上 WebSocket 之后）：
 *   1. AuthenticationTokenRequest  → VTS 返回 data.authenticationToken
 *      （首次使用某个 pluginName 时，VTS 会弹窗让用户允许插件；token 不落盘，每次启动重新申请）
 *   2. AuthenticationRequest（带 token）→ data.authenticated === true 才算 ready
 *   3. 之后每帧发 InjectParameterDataRequest，用 mode:"set" 直接写四个眼睛参数：
 *      EyeLeftX / EyeRightX = 0.5 + gx * 0.35
 *      EyeLeftY / EyeRightY = 0.5 + gy * 0.30
 *      VTS 的 Y 轴以「上 = 大」为正；如果使用者的皮套/模型方向相反，用 invertY 把 gy 取反。
 *   整个连接+认证过程 8s 超时；失败不抛给调用方，只记 lastError 并 5s→60s 退避重连。
 *
 * 编码约定：
 *   - gx / gy ∈ [-1, 1]，右 / 上为正；非有限值直接忽略，越界夹紧。
 *   - inject() 节流到 ≤20Hz（50ms），被限流时只保留最新值、定时补发，不丢最后一帧。
 *   - status() 永远可以安全调用；dispose() 幂等，取消 socket 与所有定时器。
 */

import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const API_NAME = 'VTubeStudioPublicAPI';
const API_VERSION = '1.0';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const CONNECT_TIMEOUT_MS = 25000; // 首次授权要人点「允许」，8s 太短会反复弹窗
const REQUEST_TIMEOUT_MS = 8000;
const MIN_INJECT_INTERVAL_MS = 50; // 20Hz
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 60000;

const MAX_HANDSHAKE_BYTES = 32 * 1024;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function clampGaze(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'unknown error';
}

/**
 * 客户端 → 服务端的帧必须加 mask（RFC6455 5.3）。
 * @param {number} opcode
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function encodeClientFrame(opcode, payload) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.allocUnsafe(6);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(8);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(14);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode; // FIN=1（本实现不发分片帧）
  const mask = crypto.randomBytes(4);
  mask.copy(header, header.length - 4);

  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) {
    masked[i] = payload[i] ^ mask[i & 3];
  }
  return Buffer.concat([header, masked], header.length + length);
}

/**
 * 最小 WebSocket 客户端：只做 VTS 需要的那些事。
 * 半包/粘包由内部 buffer 处理；所有回调异常都在内部吞掉。
 */
/**
 * 皮套眼睛参数的尝试顺序：用户配置 → 插件默认命名 → VTS 标准命名。
 * 模型一个都没有时不瞎写，status() 会说明缺哪一组。
 */
const EYE_PARAM_CANDIDATES = {
  x: [['EyeLeftX', 'EyeRightX'], ['ParamEyeBallX']],
  y: [['EyeLeftY', 'EyeRightY'], ['ParamEyeBallY']],
};

/** 配置可以是字符串或字符串数组；其它类型当作没配。 */
function normalizeEyeParamList(value) {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return [];
}

class WsClient {
  #host;
  #port;
  #timeoutMs;
  #onText;
  #onClose;
  #onError;
  #logger;
  #eyeParams;
  #eyeMap = null;
  #modelParams = null;

  #socket = null;
  #state = 'idle'; // idle | handshaking | open | closing | closed
  #buffer = Buffer.alloc(0);
  #key = '';
  #openPromise = null;
  #openResolve = null;
  #openReject = null;
  #opened = false;
  #closed = false;
  #error = null;
  #timer = null;
  #fragment = null;

  constructor(options = {}) {
    this.#host = typeof options.host === 'string' && options.host ? options.host : '127.0.0.1';
    this.#port = Number.isInteger(options.port) && options.port > 0 && options.port < 65536 ? options.port : 8001;
    this.#timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : CONNECT_TIMEOUT_MS;
    this.#onText = typeof options.onText === 'function' ? options.onText : null;
    this.#onClose = typeof options.onClose === 'function' ? options.onClose : null;
    this.#onError = typeof options.onError === 'function' ? options.onError : null;
    this.#logger = typeof options.logger === 'function' ? options.logger : null;
    this.#eyeParams = options.eyeParams && typeof options.eyeParams === 'object' ? options.eyeParams : null;
  }

  get isOpen() {
    return this.#opened && !this.#closed;
  }

  open() {
    if (this.#openPromise) return this.#openPromise;

    this.#openPromise = new Promise((resolve, reject) => {
      this.#openResolve = resolve;
      this.#openReject = reject;
    });

    try {
      const socket = net.createConnection({ host: this.#host, port: this.#port });
      this.#socket = socket;
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30000);
      socket.on('connect', () => this.#writeHandshake());
      socket.on('data', (chunk) => this.#onData(chunk));
      socket.on('error', (error) => this.#onSocketError(error));
      socket.on('close', () => this.#emitClose());
      this.#armTimer();
    } catch (error) {
      this.#fail(error);
    }

    return this.#openPromise;
  }

  #armTimer() {
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#opened) return;
      this.#fail(new Error(`websocket handshake timeout (${this.#timeoutMs}ms)`));
    }, this.#timeoutMs);
    this.#timer.unref?.();
  }

  #writeHandshake() {
    this.#state = 'handshaking';
    this.#key = crypto.randomBytes(16).toString('base64');
    const hostHeader = this.#port === 80 ? this.#host : `${this.#host}:${this.#port}`;
    const request = [
      'GET / HTTP/1.1',
      `Host: ${hostHeader}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${this.#key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n');

    try {
      this.#socket.write(request, 'latin1');
    } catch (error) {
      this.#fail(error);
    }
  }

  #onData(chunk) {
    try {
      if (this.#closed) return;

      if (this.#state === 'handshaking') {
        this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
        if (this.#buffer.length > MAX_HANDSHAKE_BYTES) {
          throw new Error('websocket handshake response too large');
        }

        const end = this.#buffer.indexOf('\r\n\r\n');
        if (end < 0) return; // 半包：继续等

        const head = this.#buffer.subarray(0, end).toString('latin1');
        const rest = this.#buffer.subarray(end + 4);
        this.#buffer = Buffer.alloc(0);

        const check = this.#validateHandshake(head);
        if (!check.ok) throw new Error(check.reason);

        this.#state = 'open';
        this.#opened = true;
        if (this.#timer) {
          clearTimeout(this.#timer);
          this.#timer = null;
        }
        this.#resolveOpen();

        if (rest.length) this.#onBytes(rest);
        return;
      }

      if (this.#state === 'open' || this.#state === 'closing') {
        this.#onBytes(chunk);
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  #validateHandshake(head) {
    const lines = head.split('\r\n');
    const statusLine = lines.shift() || '';
    if (!/^HTTP\/1\.[01]\s+101\b/.test(statusLine)) {
      return { ok: false, reason: `unexpected websocket handshake status: ${statusLine.slice(0, 80)}` };
    }

    const headers = new Map();
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }

    const upgrade = (headers.get('upgrade') || '').toLowerCase();
    if (upgrade !== 'websocket') {
      return { ok: false, reason: `bad Upgrade header: ${upgrade || '(missing)'}` };
    }

    const connection = (headers.get('connection') || '').toLowerCase();
    const connectionTokens = connection.split(',').map((item) => item.trim());
    if (!connectionTokens.includes('upgrade')) {
      return { ok: false, reason: `bad Connection header: ${connection || '(missing)'}` };
    }

    const expected = crypto.createHash('sha1').update(this.#key + WS_GUID).digest('base64');
    if ((headers.get('sec-websocket-accept') || '') !== expected) {
      return { ok: false, reason: 'Sec-WebSocket-Accept mismatch' };
    }

    return { ok: true };
  }

  #onBytes(chunk) {
    try {
      this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
      if (this.#buffer.length > MAX_MESSAGE_BYTES + 1024) {
        throw new Error('websocket receive buffer too large');
      }

      let guard = 0;
      while (this.#parseOneFrame()) {
        guard += 1;
        if (guard > 10000) throw new Error('too many websocket frames in one chunk');
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  /** @returns {boolean} true = 确实消费了一帧；false = 数据还不够（半包） */
  #parseOneFrame() {
    const buffer = this.#buffer;
    if (buffer.length < 2) return false;

    const fin = (buffer[0] & 0x80) !== 0;
    const rsv = buffer[0] & 0x70;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;

    if (rsv !== 0) throw new Error('websocket RSV bits set without a negotiated extension');

    if (length === 126) {
      if (buffer.length < 4) return false;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return false;
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error('websocket frame too large');
      length = Number(big);
      offset = 10;
    }

    if (length > MAX_MESSAGE_BYTES) throw new Error('websocket frame too large');

    let mask = null;
    if (masked) {
      if (buffer.length < offset + 4) return false;
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buffer.length < offset + length) return false; // 半包

    let payload = buffer.subarray(offset, offset + length);
    this.#buffer = buffer.subarray(offset + length);

    if (mask) {
      const unmasked = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i += 1) {
        unmasked[i] = payload[i] ^ mask[i & 3];
      }
      payload = unmasked;
    }

    if (opcode >= 0x8) {
      if (!fin || length > 125) throw new Error('invalid websocket control frame');
      this.#handleControl(opcode, payload);
      return true;
    }

    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (this.#fragment) throw new Error('new data frame inside a fragmented message');
      if (fin) {
        if (opcode === OP_TEXT) this.#emitText(payload);
        // 二进制帧直接忽略：VTS 只发 JSON 文本，二进制不是给我们的。
        return true;
      }
      this.#fragment = { opcode, chunks: [payload], size: length };
      return true;
    }

    if (opcode === 0x0) {
      if (!this.#fragment) throw new Error('websocket continuation frame without a message');
      this.#fragment.chunks.push(payload);
      this.#fragment.size += length;
      if (this.#fragment.size > MAX_MESSAGE_BYTES) throw new Error('websocket message too large');
      if (fin) {
        const fragment = this.#fragment;
        this.#fragment = null;
        if (fragment.opcode === OP_TEXT) this.#emitText(Buffer.concat(fragment.chunks));
      }
      return true;
    }

    throw new Error(`unsupported websocket opcode: 0x${opcode.toString(16)}`);
  }

  #handleControl(opcode, payload) {
    if (opcode === OP_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      this.close(code === 1005 || code === 1006 ? 1000 : code);
      return;
    }
    if (opcode === OP_PING) {
      if (this.#opened && !this.#closed) {
        try {
          this.#socket.write(encodeClientFrame(OP_PONG, payload));
        } catch (error) {
          this.#fail(error);
        }
      }
      return;
    }
    // OP_PONG：不需要额外处理，收到就说明链路还活着。
  }

  #emitText(payload) {
    if (this.#state !== 'open' || !this.#onText) return;
    const text = payload.toString('utf8');
    try {
      this.#onText(text);
    } catch (error) {
      this.#log('warn', `ws text callback failed: ${errorMessage(error)}`);
    }
  }

  sendText(text) {
    if (!this.#opened || this.#closed) return false;
    try {
      this.#socket.write(encodeClientFrame(OP_TEXT, Buffer.from(String(text), 'utf8')));
      return true;
    } catch (error) {
      this.#fail(error);
      return false;
    }
  }

  /** 礼貌地发 close（同时结束写端），服务端不回就 1s 后强拆。 */
  close(code = 1000) {
    if (this.#closed) return;
    if (this.#state === 'closing') {
      // 已经发过 close：对方也回 close 时不要重复发帧，直接把连接收掉。
      try {
        this.#socket?.destroy();
      } catch {
        // ignore
      }
      return;
    }

    this.#state = 'closing';
    const safeCode = Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : 1000;
    try {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(safeCode, 0);
      this.#socket?.write(encodeClientFrame(OP_CLOSE, payload));
      this.#socket?.end();
    } catch {
      // 关连接失败不需要告诉任何人
    }

    const timer = setTimeout(() => {
      try {
        this.#socket?.destroy();
      } catch {
        // ignore
      }
    }, 1000);
    timer.unref?.();
  }

  destroy() {
    try {
      this.#socket?.destroy();
    } catch {
      // ignore
    }
  }

  #onSocketError(error) {
    this.#error = error instanceof Error ? error : new Error(String(error));
    this.#log('warn', `ws error: ${this.#error.message}`);

    if (!this.#opened && this.#openReject) {
      this.#openReject(this.#error);
      this.#openReject = null;
      this.#openResolve = null;
    }

    try {
      this.#onError?.(this.#error);
    } catch (callbackError) {
      this.#log('warn', `ws error callback failed: ${errorMessage(callbackError)}`);
    }
    // net socket 在 error 之后会自行 close，重连由上层在 onClose 里安排。
  }

  #resolveOpen() {
    if (!this.#openResolve) return;
    const resolve = this.#openResolve;
    this.#openResolve = null;
    this.#openReject = null;
    resolve();
  }

  #fail(error) {
    this.#error = error instanceof Error ? error : new Error(String(error));
    this.#log('warn', `ws failed: ${this.#error.message}`);

    if (!this.#opened && this.#openReject) {
      this.#openReject(this.#error);
      this.#openReject = null;
      this.#openResolve = null;
    }
    this.destroy();
  }

  #emitClose() {
    if (this.#closed) return;
    this.#closed = true;
    this.#opened = false;
    this.#state = 'closed';

    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    if (this.#openReject) {
      this.#openReject(this.#error || new Error('websocket closed before handshake completed'));
      this.#openReject = null;
      this.#openResolve = null;
    }

    try {
      this.#onClose?.(this.#error || null);
    } catch (error) {
      this.#log('warn', `ws close callback failed: ${errorMessage(error)}`);
    }
  }

  #log(level, message) {
    try {
      this.#logger?.(level, message);
    } catch {
      // logger 自己坏了也不能影响协议层
    }
  }
}

const DEFAULT_GAIN_X = 0.8; // 0.5 只到参数半量程；这个模型的 EyeX 视觉位移窄，默认给大一点
const DEFAULT_GAIN_Y = 0.5;

/** 增益：0.1~1.0，非法值退回默认。1.0 = 满量程硬推。 */
function gainOf(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1.0, Math.max(0.1, n));
}

/** 偏置：-0.3~0.3，非法值退回默认。用来把整只眼睛的静态朝向往哪边挪。 */
function biasOf(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(0.3, Math.max(-0.3, n));
}

/** 夹到 VTS 参数合法的 0..1。 */
function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

class VtsSink {
  #port;
  #pluginName;
  #invertY;
  #invertX;
  #gainX;
  #gainY;
  #biasX;
  #biasY;
  #logger;
  #eyeParams;
  #eyeMap = null;
  #modelParams = null;

  #ws = null;
  #connected = false;
  #authorized = false;
  #lastError = null;
  /** 连续失败次数：0 表示上次成功；用来让日志能看出「失败了几次」而不只是「失败了」。 */
  #attemptSeq = 0;
  #sent = 0;
  #lastSentAt = 0;
  #lastInjectAt = 0;

  #gaze = { x: 0, y: 0, has: false };
  #injectTimer = null;
  #retryTimer = null;
  #retryDelay = RETRY_MIN_MS;
  #connectPromise = null;
  #pending = new Map();
  #requestSeq = 0;
  #requestPrefix;
  #disposed = false;

  constructor(options = {}) {
    this.#port = Number.isInteger(options.port) && options.port > 0 && options.port < 65536 ? options.port : 8001;
    this.#pluginName =
      typeof options.pluginName === 'string' && options.pluginName.trim()
        ? options.pluginName.trim()
        : 'dsh-whale-gaze';
    this.#invertY = options.invertY === true;
    this.#invertX = options.invertX === true;
    this.#gainX = gainOf(options.gainX, DEFAULT_GAIN_X);
    this.#gainY = gainOf(options.gainY, DEFAULT_GAIN_Y);
    this.#biasX = biasOf(options.biasX, 0);
    this.#biasY = biasOf(options.biasY, 0);
    this.#logger = typeof options.logger === 'function' ? options.logger : null;
    this.#eyeParams = options.eyeParams && typeof options.eyeParams === 'object' ? options.eyeParams : null;
    this.#requestPrefix = crypto.randomBytes(4).toString('hex');
  }

  /**
   * 连一次 VTS 并完成认证。
   * 不管成功失败都不会 throw：成功返回 true，失败返回 false（原因进 status().lastError），
   * 失败后会自动按 5s→60s 退避重试。
   * @returns {Promise<boolean>}
   */
  connect() {
    if (this.#disposed) return Promise.resolve(false);
    if (this.#authorized) return Promise.resolve(true);
    if (this.#connectPromise) return this.#connectPromise;

    this.#clearRetry();
    const promise = this.#attemptConnect().then(
      (value) => {
        if (this.#connectPromise === promise) this.#connectPromise = null;
        return value;
      },
      (error) => {
        if (this.#connectPromise === promise) this.#connectPromise = null;
        if (!this.#disposed) this.#lastError = errorMessage(error);
        return false;
      },
    );
    this.#connectPromise = promise;
    return promise;
  }

  async #attemptConnect() {
    if (this.#disposed) return false;
    const attempt = (this.#attemptSeq += 1);

    // 防御：正常情况下 connectPromise 保证不会有两个 attempt 同时跑。
    if (this.#ws) {
      const stale = this.#ws;
      this.#ws = null;
      try {
        stale.destroy();
      } catch {
        // ignore
      }
    }

    this.#connected = false;
    this.#authorized = false;
    this.#clearInjectTimer();

    let ws = null;
    ws = new WsClient({
      host: '127.0.0.1',
      port: this.#port,
      timeoutMs: CONNECT_TIMEOUT_MS,
      logger: this.#logger,
      onText: (text) => this.#handleText(ws, text),
      onClose: (error) => this.#handleSocketClose(ws, error),
      onError: (error) => this.#handleSocketError(ws, error),
    });
    this.#ws = ws;

    let settled = false;
    let timedOut = false;
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      timedOut = true;
      this.#lastError = `VTS connect timeout (${CONNECT_TIMEOUT_MS}ms, attempt=${attempt})`;
      this.#log('warn', this.#lastError);
      try {
        ws.destroy();
      } catch {
        // ignore
      }
    }, CONNECT_TIMEOUT_MS);
    deadline.unref?.();

    try {
      await ws.open();
      this.#connected = true;
      this.#log('info', 'VTS websocket open; requesting authentication token');

      const tokenResponse = await this.#request(
        'AuthenticationTokenRequest',
        {
          pluginName: this.#pluginName,
          pluginDeveloper: this.#pluginName,
          pluginIcon: null,
        },
        CONNECT_TIMEOUT_MS, // 首次授权要人点「允许」，等够整个连接窗口
      );
      const token = tokenResponse?.data?.authenticationToken;
      if (typeof token !== 'string' || !token) {
        throw new Error('AuthenticationTokenRequest: response has no authenticationToken');
      }

      const authResponse = await this.#request('AuthenticationRequest', {
        pluginName: this.#pluginName,
        pluginDeveloper: this.#pluginName,
        authenticationToken: token,
      });
      if (authResponse?.data?.authenticated !== true) {
        throw new Error(
          `AuthenticationRequest rejected (authenticated=${String(authResponse?.data?.authenticated)})`,
        );
      }

      settled = true;
      this.#authorized = true;
      this.#lastError = null;
      this.#retryDelay = RETRY_MIN_MS;
      this.#log('info', `VTS authorized as ${this.#pluginName}`);
      await this.#resolveEyeMap();

      // 连上之前如果已经有人调过 inject，立刻补发当前注视点。
      if (this.#gaze.has) {
        this.#lastInjectAt = 0;
        this.#sendInject();
      }
      return true;
    } catch (error) {
      settled = true;
      const message = timedOut ? `VTS connect timeout (${CONNECT_TIMEOUT_MS}ms, attempt=${attempt})` : `${errorMessage(error)} (attempt=${attempt})`;
      if (!this.#disposed) {
        this.#lastError = message;
        this.#log('warn', `VTS connect failed: ${message}`);
        this.#connected = false;
        this.#authorized = false;
        this.#rejectPending(error);
        if (this.#ws === ws) this.#ws = null;
        try {
          ws.destroy();
        } catch {
          // ignore
        }
        this.#scheduleRetry();
      }
      return false;
    } finally {
      clearTimeout(deadline);
    }
  }

  /**
   * 每帧调用也不会塌：非有限值忽略、越界夹紧、未授权时静默丢弃；
   * 50ms 内的重复调用只保留最新值并定时补发。
   * @param {number} gx -1 左 … +1 右
   * @param {number} gy -1 下 … +1 上（invertY=true 时内部取反）
   * @returns {boolean} 是否已经真正发出（false 也可能是排队等待补发）
   */
  inject(gx, gy) {
    try {
      const x = clampGaze(gx);
      const y = clampGaze(gy);
      if (x === null || y === null) return false;

      this.#gaze = { x, y, has: true };
      if (this.#disposed || !this.#authorized || !this.#ws?.isOpen) return false;

      const now = Date.now();
      const wait = MIN_INJECT_INTERVAL_MS - (now - this.#lastInjectAt);
      if (wait <= 0) {
        this.#clearInjectTimer();
        this.#sendInject();
        return true;
      }

      if (!this.#injectTimer) {
        this.#injectTimer = setTimeout(() => {
          this.#injectTimer = null;
          if (this.#disposed || !this.#authorized) return;
          this.#sendInject();
        }, wait);
        this.#injectTimer.unref?.();
      }
      return false;
    } catch (error) {
      this.#lastError = errorMessage(error);
      return false;
    }
  }

  status() {
    return {
      connected: this.#connected === true,
      authorized: this.#authorized === true,
      lastError: this.#lastError,
      sent: this.#sent,
      lastSentAt: this.#lastSentAt,
      gainX: this.#gainX,
      gainY: this.#gainY,
      biasX: this.#biasX,
      biasY: this.#biasY,
      eyeParams: this.#eyeMap
        ? { x: this.#eyeMap.x, y: this.#eyeMap.y, sourceX: this.#eyeMap.sourceX, sourceY: this.#eyeMap.sourceY }
        : null,
      modelParameters: this.#modelParams
        ? this.#modelParams.filter((name) => /eye/i.test(name)).slice(0, 40)
        : null,
    };
  }

  /**
   * 运行时调参：增益与偏置当场生效，不用重连、不用重启。
   * 只传想改的那几项；返回改完的完整值。
   */
  setGaze(options = {}) {
    this.#gainX = gainOf(options.gainX, this.#gainX);
    this.#gainY = gainOf(options.gainY, this.#gainY);
    this.#biasX = biasOf(options.biasX, this.#biasX);
    this.#biasY = biasOf(options.biasY, this.#biasY);
    return { gainX: this.#gainX, gainY: this.#gainY, biasX: this.#biasX, biasY: this.#biasY };
  }

  /** 幂等；关 socket、取消重连/节流定时器、拒绝未完成的请求。 */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;

    this.#clearRetry();
    this.#clearInjectTimer();
    this.#rejectPending(new Error('VTS sink disposed'));

    const ws = this.#ws;
    this.#ws = null;
    this.#connected = false;
    this.#authorized = false;

    if (ws) {
      try {
        ws.close(1000);
      } catch {
        // ignore
      }
    }
    this.#log('info', 'VTS sink disposed');
  }

  /**
   * 问 VTS 要当前模型的参数表，决定往哪些 id 写眼睛。
   * 顺序：用户配置 → 插件默认命名 → VTS 标准命名。全都没有就禁用注入并记下原因。
   */
  async #resolveEyeMap() {
    let names = [];
    try {
      const response = await this.#request('InputParameterListRequest', {}, REQUEST_TIMEOUT_MS);
      const data = response?.data || {};
      const list = [...(data.defaultParameters || []), ...(data.customParameters || [])];
      names = list
        .map((item) => (item && typeof item.name === 'string' ? item.name : ''))
        .filter(Boolean);
      this.#modelParams = names;
    } catch (error) {
      this.#modelParams = [];
      this.#lastError = `InputParameterListRequest: ${errorMessage(error)}`;
    }

    const available = new Set(names);
    const pickAxis = (axis) => {
      const configured = normalizeEyeParamList(this.#eyeParams?.[axis]);
      if (configured.length) {
        const present = configured.filter((id) => available.has(id));
        if (present.length === configured.length) return { ids: configured, source: 'config' };
        if (present.length) return { ids: present, source: 'config-partial' };
        return { ids: [], source: 'config-missing' };
      }
      for (const group of EYE_PARAM_CANDIDATES[axis]) {
        const present = group.filter((id) => available.has(id));
        if (present.length === group.length) {
          return { ids: group, source: group[0].startsWith('Param') ? 'standard' : 'custom' };
        }
      }
      return { ids: [], source: 'not-found' };
    };

    const x = pickAxis('x');
    const y = pickAxis('y');
    this.#eyeMap = { x: x.ids, y: y.ids, sourceX: x.source, sourceY: y.source };
    if (!x.ids.length || !y.ids.length) {
      const eyeish = names.filter((name) => /eye/i.test(name)).slice(0, 12);
      this.#lastError =
        `皮套没有可用的眼睛参数（x=${x.source}, y=${y.source}）。` +
        `模型里含 eye 的参数：${eyeish.join(', ') || '(无)'}。` +
        '请在配置 vts.eyeParams 里指定要写哪几项，或用 scripts/vts-bind.mjs 探一下。';
      this.#log('warn', this.#lastError);
      return;
    }
    this.#log(
      'info',
      `eye params: x=${x.ids.join('+')} (${x.source})  y=${y.ids.join('+')} (${y.source})`,
    );
  }

  #sendInject() {
    const ws = this.#ws;
    if (!this.#authorized || !ws?.isOpen) return;

    const xIds = this.#eyeMap?.x || [];
    const yIds = this.#eyeMap?.y || [];
    if (!xIds.length || !yIds.length) return;

    const dirX = this.#invertX ? -1 : 1;
    const x = round4(clamp01(0.5 + (this.#gaze.x + this.#biasX) * this.#gainX * dirX));
    const yValue = this.#invertY ? -this.#gaze.y : this.#gaze.y;
    const y = round4(clamp01(0.5 + (yValue + this.#biasY) * this.#gainY));

    const message = {
      apiName: API_NAME,
      apiVersion: API_VERSION,
      requestID: this.#nextRequestId(),
      messageType: 'InjectParameterDataRequest',
      data: {
        faceFound: true,
        mode: 'set',
        parameterValues: [
          ...xIds.map((id) => ({ id, value: x })),
          ...yIds.map((id) => ({ id, value: y })),
        ],
      },
    };

    const sentAt = Date.now();
    this.#lastInjectAt = sentAt;
    let ok = false;
    try {
      ok = ws.sendText(JSON.stringify(message));
    } catch (error) {
      this.#lastError = errorMessage(error);
    }

    if (ok) {
      this.#sent += 1;
      this.#lastSentAt = sentAt;
    } else if (!this.#lastError) {
      this.#lastError = 'InjectParameterDataRequest: send failed';
    }
  }

  #request(messageType, data, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const ws = this.#ws;
      if (!ws || !ws.isOpen) {
        reject(new Error(`${messageType}: websocket is not open`));
        return;
      }

      const requestID = this.#nextRequestId();
      const timer = setTimeout(() => {
        const pending = this.#pending.get(requestID);
        if (!pending) return;
        this.#pending.delete(requestID);
        pending.reject(new Error(`${messageType}: no response within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      this.#pending.set(requestID, { resolve, reject, timer, messageType });

      let ok = false;
      try {
        ok = ws.sendText(
          JSON.stringify({
            apiName: API_NAME,
            apiVersion: API_VERSION,
            requestID,
            messageType,
            data,
          }),
        );
      } catch (error) {
        ok = false;
      }

      if (!ok) {
        clearTimeout(timer);
        this.#pending.delete(requestID);
        reject(new Error(`${messageType}: failed to send request`));
      }
    });
  }

  #handleText(ws, text) {
    if (this.#ws !== ws) return;

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // 非 JSON 文本直接忽略（VTS 理论上只发 JSON；防御坏数据）。
      this.#log('debug', 'VTS: ignored non-JSON text message');
      return;
    }

    if (!message || typeof message !== 'object' || Array.isArray(message)) return;

    const type = typeof message.messageType === 'string' ? message.messageType : '';
    const requestID = typeof message.requestID === 'string' ? message.requestID : '';

    let key = null;
    let pending = null;
    if (requestID && this.#pending.has(requestID)) {
      key = requestID;
      pending = this.#pending.get(requestID);
    } else if (type === 'APIError' && this.#pending.size === 1) {
      // 防御：个别错误响应可能没有 requestID，此时把唯一在等的请求失败掉。
      const entry = this.#pending.entries().next().value;
      if (entry) {
        key = entry[0];
        pending = entry[1];
      }
    }

    if (!pending) {
      if (type === 'APIError') {
        this.#log('warn', `VTS: unmatched APIError: ${this.#apiErrorText(message)}`);
      }
      // InjectParameterDataResponse 之类的响应不需要处理，静默忽略。
      return;
    }

    this.#pending.delete(key);
    clearTimeout(pending.timer);

    if (type === 'APIError') {
      pending.reject(new Error(this.#apiErrorText(message)));
    } else {
      pending.resolve(message);
    }
  }

  #handleSocketError(ws, error) {
    if (this.#disposed || this.#ws !== ws) return;
    if (error) this.#lastError = errorMessage(error);
    // 重连在 onClose 里安排；这里只记录。
  }

  #handleSocketClose(ws, error) {
    if (this.#disposed || this.#ws !== ws) return;

    this.#ws = null;
    this.#connected = false;
    this.#authorized = false;
    this.#clearInjectTimer();

    if (error) this.#lastError = errorMessage(error);
    this.#rejectPending(error instanceof Error ? error : new Error('VTS connection closed'));
    this.#scheduleRetry();
  }

  #scheduleRetry() {
    if (this.#disposed || this.#retryTimer || this.#authorized || this.#ws) return;

    const delay = this.#retryDelay;
    this.#retryDelay = Math.min(this.#retryDelay * 2, RETRY_MAX_MS);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#disposed) return;
      this.connect().catch(() => {
        // connect() 本身不 reject；这里是最后一道保险。
      });
    }, delay);
    this.#retryTimer.unref?.();
    this.#log('info', `VTS reconnect scheduled in ${delay}ms`);
  }

  #clearRetry() {
    if (!this.#retryTimer) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #clearInjectTimer() {
    if (!this.#injectTimer) return;
    clearTimeout(this.#injectTimer);
    this.#injectTimer = null;
  }

  #rejectPending(error) {
    const reason = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
  }

  #nextRequestId() {
    this.#requestSeq += 1;
    return `${this.#requestPrefix}-${this.#requestSeq}`;
  }

  #apiErrorText(message) {
    const data = message && typeof message.data === 'object' && message.data ? message.data : {};
    const id = data.errorID ?? data.errorId ?? 'unknown';
    const text = data.message || data.errorMessage || data.reason || 'unspecified error';
    return `VTS APIError ${id}: ${typeof text === 'string' ? text : JSON.stringify(text)}`;
  }

  #log(level, message) {
    try {
      this.#logger?.(level, message);
    } catch {
      // logger 自己坏了不能影响眼神
    }
  }
}

/**
 * 创建 VTS 眼参数 sink。
 * @param {object} [options]
 * @param {number} [options.port=8001]
 * @param {string} [options.pluginName='dsh-whale-gaze']
 * @param {boolean} [options.invertY=false] 皮套 Y 轴与 VTS 约定相反时打开
 * @param {(level: string, message: string) => void} [options.logger]
 */
export function createVtsSink(options = {}) {
  const sink = new VtsSink(options);
  return {
    connect: () => sink.connect(),
    inject: (gx, gy) => sink.inject(gx, gy),
    setGaze: (options) => sink.setGaze(options),
    status: () => sink.status(),
    dispose: () => sink.dispose(),
  };
}

/**
 * 给别的皮套/调试脚本读的文件 sink：每次覆盖写 <dir>/gaze.json。
 * 失败（目录不可写、磁盘满……）一律静默，绝不能因为写文件失败影响主循环。
 * @param {string | {dir?: string}} dir
 */
/**
 * 一次性探测：连 VTS、认证、问参数表，然后断开。不会注册重连，也不注入任何值。
 * 给 scripts/vts-bind.mjs 用；返回 { ok, connected, authorized, lastError, eyeParams, modelParameters }。
 */
export async function probeVts(options = {}) {
  const sink = new VtsSink({ ...options, logger: options.logger ?? null });
  try {
    const ok = await sink.connect();
    return { ok, ...sink.status() };
  } finally {
    sink.dispose();
  }
}

export function createFileSink(dir) {
  let targetDir = '';
  if (typeof dir === 'string' && dir.trim()) {
    targetDir = dir.trim();
  } else if (dir && typeof dir === 'object' && typeof dir.dir === 'string' && dir.dir.trim()) {
    targetDir = dir.dir.trim();
  }

  const file = targetDir ? path.join(targetDir, 'gaze.json') : null;
  if (targetDir) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch {
      // 静默
    }
  }

  let writing = false;
  let queued = null;
  let disposed = false;

  function flush() {
    if (disposed || writing || !queued || !file) return;
    const payload = queued;
    queued = null;
    writing = true;
    try {
      fs.writeFile(file, JSON.stringify(payload), (error) => {
        writing = false;
        if (error) return; // 静默
        if (!disposed && queued) flush();
      });
    } catch {
      writing = false;
    }
  }

  function write(gx, gy) {
    if (disposed) return false;
    const x = clampGaze(gx);
    const y = clampGaze(gy);
    if (x === null || y === null) return false;

    queued = { gx: round4(x), gy: round4(y), ts: Date.now() };
    flush();
    return true;
  }

  return {
    inject: write,
    write,
    dispose() {
      disposed = true;
      queued = null;
    },
  };
}
