/**
 * eye_see —— 模型侧唯一的一只「眼睛」。
 *
 * 单工具多动作，避免为一个能力注册四五个 schema 白烧 token：
 *   status / start / stop / look / freeze / aim
 *
 * 返回是「一行字 + 可选一张图」：图走 attachments 的原生 image block，
 * 所以 look/freeze 一次调用就能真的看见，不用再套一层 read_image。
 * 不调用就永远不进上下文 —— 什么时候烧图，由模型自己决定。
 */

const ACTIONS = ['status', 'start', 'stop', 'look', 'freeze', 'aim', 'tune'];

const DESCRIPTION = [
  'Use the always-on eyes (a camera or a video page/window) to see what is happening instead of guessing.',
  'status reports sources, the latest motion reading and the gaze state;',
  'start opens a source (camera / screen / window), stop closes it;',
  'look returns one compact scene line plus the newest freeze-frame path;',
  'freeze saves a still right now, aim points the eyes at a spot by hand,',
  'and tune adjusts eye amplitude and lean while it runs.',
  'A frame path is only a path: read it with read_image when detail actually matters.',
  'Never ask for a source the user did not agree to keep running.',
].join(' ');

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description: 'status = overview; start/stop = manage a source; look = latest scene; freeze = save a still now; aim = manual gaze target.',
    },
    source: {
      type: 'string',
      description: 'Source id to act on: cam, screen, window, or a custom id from config. Defaults to the first camera source.',
    },
    device: {
      type: 'string',
      description: 'Camera device name for action=start when the source id is new. Defaults to the configured device.',
    },
    title: {
      type: 'string',
      description: 'Window title to capture for action=start with kind=window.',
    },
    kind: {
      type: 'string',
      enum: ['camera', 'screen', 'window'],
      description: 'Source kind for action=start. Defaults to camera.',
    },
    freeze: {
      type: 'boolean',
      description: 'For action=look: also save a still and include its path. Off by default.',
    },
    note: {
      type: 'string',
      description: 'Short note stored with a freeze-frame, e.g. what caught the eye.',
    },
    x: {
      type: 'number',
      description: 'For action=aim: horizontal target in [-1, 1], -1 left, 1 right.',
    },
    y: {
      type: 'number',
      description: 'For action=aim: vertical target in [-1, 1], -1 down, 1 up.',
    },
    on: {
      type: 'boolean',
      description: 'For action=aim: false releases the manual target and lets the eyes follow motion again.',
    },
    gainX: {
      type: 'number',
      description: 'For action=tune: horizontal eye amplitude, 0.1-1.0. Bigger = the eyes travel further.',
    },
    gainY: {
      type: 'number',
      description: 'For action=tune: vertical eye amplitude, 0.1-1.0.',
    },
    biasX: {
      type: 'number',
      description: 'For action=tune: constant horizontal offset, -0.3 to 0.3. Positive looks one way; flip the sign if it leans the wrong way.',
    },
    biasY: {
      type: 'number',
      description: 'For action=tune: constant vertical offset, -0.3 to 0.3.',
    },
  },
  required: ['action'],
};

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      // 可选的定格图：走 attachments 的原生 image block，一次调用就真的看见
      frame: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          name: { type: 'string' },
        },
        required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
      },
    },
    required: ['text'],
  },
  render: (_args, value) => {
    const blocks = [{ type: 'text', text: value?.text ?? '(no eye report)' }];
    if (value?.frame && typeof value.frame.attachmentId === 'string') {
      blocks.push({ type: 'image', attachment: value.frame });
    }
    return blocks;
  },
};

/**
 * @param {object} state 由 index.js 组装的共享状态与动作
 */
export function createEyeTool(state) {
  return {
    name: 'eye_see',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: OUTPUT,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `Eyes: ${String(args?.action ?? 'status')}`,
      kind: 'other',
    }),
    async execute(args) {
      const action = ACTIONS.includes(args?.action) ? args.action : 'status';
      const id = typeof args?.source === 'string' && args.source.trim() ? args.source.trim() : null;

      switch (action) {
        case 'start': {
          const def = {
            id: id ?? `src${state.nextSourceNumber++}`,
            kind: args?.kind === 'screen' || args?.kind === 'window' ? args.kind : 'camera',
            device: typeof args?.device === 'string' && args.device.trim() ? args.device.trim() : undefined,
            title: typeof args?.title === 'string' && args.title.trim() ? args.title.trim() : undefined,
          };
          if (def.kind === 'window' && !def.title) {
            return { text: 'start failed: kind=window needs a title.' };
          }
          const result = await state.start(def);
          return { text: result };
        }
        case 'stop': {
          return { text: await state.stop(id) };
        }
        case 'look': {
          const wantFreeze = args?.freeze === true;
          return await state.look(id, wantFreeze);
        }
        case 'freeze': {
          return await state.freezeNow(id, typeof args?.note === 'string' ? args.note : '');
        }
        case 'aim': {
          if (args?.on === false) {
            state.aim.on = false;
            return { text: 'aim released; the eyes follow motion again.' };
          }
          const x = Number.isFinite(args?.x) ? Math.max(-1, Math.min(1, args.x)) : state.gaze.x;
          const y = Number.isFinite(args?.y) ? Math.max(-1, Math.min(1, args.y)) : state.gaze.y;
          state.aim.on = true;
          state.aim.x = x;
          state.aim.y = y;
          state.ensureVts?.();
          return { text: `aim locked at x=${x.toFixed(2)} y=${y.toFixed(2)}.` };
        }
        case 'tune': {
          return {
            text: state.tune({
              gainX: args?.gainX,
              gainY: args?.gainY,
              biasX: args?.biasX,
              biasY: args?.biasY,
            }),
          };
        }
        default:
          return { text: state.statusText() };
      }
    },
  };
}
