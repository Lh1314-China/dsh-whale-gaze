#!/usr/bin/env node
/**
 * VTS 皮套绑定检测。
 *
 * 连一次 VTube Studio，问它要当前模型的参数表，然后告诉你：
 *   - 模型里有没有眼睛参数、叫什么名字；
 *   - 该往 cordis.patch.yml 的 vts.eyeParams 里写什么。
 *
 * 不写配置、不改模型、不注入任何值；退出即断开。
 *
 * 用法：
 *   node scripts/vts-bind.mjs
 *   node scripts/vts-bind.mjs --port 8001
 */
import { probeVts } from '../lib/vts.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const port = Number(arg('port', '8001')) || 8001;

console.log('dsh-whale-gaze · VTS 皮套绑定检测');
console.log(`连接 127.0.0.1:${port} …`);

const result = await probeVts({ port });

if (!result.ok) {
  console.error('');
  console.error('没连上或没通过认证。');
  if (result.lastError) console.error(`原因：${result.lastError}`);
  console.error('');
  console.error('检查清单：');
  console.error('  1. VTube Studio 是否已经打开（本插件不会替你开）。');
  console.error('  2. VTS 里「设置 → 插件 / API」是否允许 API 访问（端口默认 8001）。');
  console.error('  3. 第一次连接时 VTS 会弹一个授权框，点允许；拒绝过的话在 VTS 的插件列表里删掉旧记录再试。');
  process.exit(1);
}

const names = result.modelParameters || [];
console.log('');
console.log(`已认证。当前模型的参数里含 eye 的有 ${names.length} 个：`);
if (names.length === 0) {
  console.log('  （没有）');
} else {
  for (const name of names) console.log(`  ${name}`);
}

const map = result.eyeParams;
console.log('');
if (map && map.x.length && map.y.length) {
  console.log('本插件已经自动选好了这组参数：');
  console.log(`  x: ${map.x.join(', ')}   (${map.sourceX})`);
  console.log(`  y: ${map.y.join(', ')}   (${map.sourceY})`);
  console.log('');
  console.log('如果这样就能转，不用改配置。');
} else {
  console.log('没有自动匹配到眼睛参数。请从上面的列表里挑两组，写进配置：');
}

console.log('');
console.log('把下面这段放进 profile 的 cordis.patch.yml（whale-gaze 那一条的 config 下）：');
console.log('');
console.log('  vts:');
console.log('    enabled: true');
console.log(`    port: ${port}`);
console.log('    eyeParams:');
console.log(`      x: [${(map?.x?.length ? map.x : ['ParamEyeBallX']).join(', ')}]`);
console.log(`      y: [${(map?.y?.length ? map.y : ['ParamEyeBallY']).join(', ')}]`);
console.log('');
console.log('调方向与幅度（都在同一条 config 下）：');
console.log('  invertX: true   左右反了时打开');
console.log('  invertY: true   上下反了时打开');
console.log('  gainX / gainY   转幅太小就调大（默认 0.8 / 0.6）');
console.log('');
console.log('重启 DSH 后生效。');
