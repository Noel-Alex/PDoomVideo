// render.mjs: drive studio.html in headless Chrome.
//   node render.mjs --sheet=23,23.5,24 [--cols=3] [--w=640] --out=out/check.jpg   contact sheet (fast visual check)
//   node render.mjs --stills=0.8,3,23.8 --out=out/test                          full-res PNG stills
//   node render.mjs --clip=0:6 --fps=24 --out=out/test.mp4                      short clip with audio
//   node render.mjs --frames=0:156.6 --workers=3                                full-res JPEG frames → out/frames (resumable)
//   node render.mjs --bench=23:24 --worker-list=1,2,3,4,6                       benchmark worker counts
//   node render.mjs --encode [--encoder=auto] [--out=out/pdoom.mp4]             frames + song → MP4 (NVENC when available)
//   Add --capture=dataurl to use the original canvas.toDataURL() export path.
//   node render.mjs --loop=recursion [--out=out/loop_recursion]                 one cycle of a standalone loop (PNGs)
//   (--loop also works with --sheet, where the times are loop time)
import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync, renameSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const CHROME = args.chrome || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DUR = 156.6, fps = +(args.fps || 24);
const FRAMES_DIR = 'out/frames';
const CAPTURE = String(args.capture || 'screenshot').toLowerCase();
const FAST_CAPTURE = !args['no-fast-capture'];
const DEFAULT_WORKERS = 3;
const JPEG_QUALITY = Math.max(1, Math.min(100, Math.round(+(args.quality || 94))));
if (!['screenshot', 'dataurl'].includes(CAPTURE)) throw new Error(`Unknown --capture=${CAPTURE}; expected screenshot or dataurl`);

const run = (cmd, a) => new Promise((ok, bad) => { const p = spawn(cmd, a, { stdio: 'inherit' }); p.on('close', c => c ? bad(new Error(cmd + ' exited ' + c)) : ok()); });

if (args.encode) {
  const out = args.out || 'out/pdoom.mp4', n = readdirSync(FRAMES_DIR).filter(f => f.endsWith('.jpg')).length;
  const requested = String(args.encoder || 'auto').toLowerCase();
  const encoders = requested === 'auto' ? spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true }) : null;
  const nvencAvailable = !!encoders && encoders.status === 0 && /\bh264_nvenc\b/.test((encoders.stdout || '') + (encoders.stderr || ''));
  const useNvenc = requested === 'nvenc' || (requested === 'auto' && nvencAvailable);
  const videoArgs = useNvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', '17', '-b:v', '0']
    : ['-c:v', 'libx264', '-preset', 'slow', '-crf', '17'];
  console.log(`encoding ${n} frames → ${out}`);
  console.log(`video encoder: ${useNvenc ? 'h264_nvenc' : 'libx264'}${requested === 'auto' ? ' (auto)' : ''}`);
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-stats', '-framerate', String(fps), '-i', `${FRAMES_DIR}/f%05d.jpg`, '-i', 'assets/pdoom.mp3',
    '-map', '0:v', '-map', '1:a', ...videoArgs, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', '-shortest', out]);
  console.log('wrote ' + out);
  process.exit(0);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: args.headful ? false : true,
  protocolTimeout: 0,
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  args: [
    '--allow-file-access-from-files',
    '--enable-gpu',
    '--use-gl=angle',
    '--use-angle=d3d11',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--window-size=1920,1080',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion'
  ]
});
let printedGpu = false;
async function openPage(tag = '') {
  const page = await browser.newPage();
  page.on('console', m => { if (['error', 'warn'].includes(m.type())) console.log(`[page${tag}]`, m.text()); });
  page.on('pageerror', e => console.log(`[page error${tag}]`, e.message));
  await page.goto(pathToFileURL(resolve('studio.html')).href + '?render', { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.ready === true', { timeout: 60000 });
  if (CAPTURE === 'screenshot') {
    await page.addStyleTag({ content: `
      html, body { margin: 0 !important; padding: 0 !important; width: 1920px !important; height: 1080px !important; overflow: hidden !important; }
      main { margin: 0 !important; padding: 0 !important; display: block !important; width: 1920px !important; height: 1080px !important; }
      #out { display: block !important; width: 1920px !important; height: 1080px !important; max-width: none !important; }
      .bar { display: none !important; }
    ` });
  }
  if (args.loop) await page.evaluate(name => { window.LOOP = LOOPS[name]; }, args.loop);

  const gpu = await page.evaluate(() => window.gpuInfo());
  if (!printedGpu) {
    console.log('GPU:', gpu);
    console.log(`capture: ${CAPTURE}${CAPTURE === 'screenshot' && FAST_CAPTURE ? ' (optimizeForSpeed)' : ''}`);
    printedGpu = true;
  }
  if (!args['allow-software-gpu'] && /swiftshader|software raster|llvmpipe|microsoft basic render/i.test(gpu)) {
    await page.close();
    throw new Error(`Chrome is using software rendering instead of the GPU: ${gpu}`);
  }
  if (/intel|iris|uhd/i.test(gpu)) console.warn(`WARNING: Chrome appears to be using the integrated GPU: ${gpu}`);
  return page;
}
const frameOf = async (page, t, type, q) => {
  const timing = await page.evaluate(t => window.renderFrame(t), t);
  const t0 = Date.now();
  let buf;
  if (CAPTURE === 'screenshot') {
    const shotType = type === 'image/png' ? 'png' : 'jpeg';
    const shot = await page.screenshot({
      type: shotType,
      ...(shotType === 'jpeg' ? { quality: Math.max(1, Math.min(100, Math.round(q * 100))) } : {}),
      clip: { x: 0, y: 0, width: 1920, height: 1080 },
      captureBeyondViewport: false,
      fromSurface: true,
      optimizeForSpeed: FAST_CAPTURE
    });
    buf = Buffer.from(shot);
  } else {
    const url = await page.evaluate((type, q) => window.encodeFrame(type, q), type, q);
    buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  }
  return { buf, ...timing, captureMs: Date.now() - t0 };
};
const times = s => String(s).split(',').map(Number);

if (args.sheet) {
  const page = await openPage(), out = args.out || 'out/sheet.jpg'; mkdirSync(dirname(out), { recursive: true });
  const { url, ms } = await page.evaluate((ts, c, w) => window.renderSheet(ts, c, w), times(args.sheet), +(args.cols || 3), +(args.w || 640));
  writeFileSync(out, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  console.log(`${out}  ms/frame: ${ms.join(' ')}`);
} else if (args.stills) {
  const page = await openPage(), out = args.out || 'out/stills'; mkdirSync(out, { recursive: true });
  for (const s of times(args.stills)) {
    const t0 = Date.now(), r = await frameOf(page, s, 'image/png', 1);
    const f = `${out}/t${s.toFixed(2).replace('.', '_')}.png`; writeFileSync(f, r.buf);
    console.log(`${f}  ${Date.now() - t0} ms (draw ${r.drawMs.toFixed(0)} + composite ${r.compositeMs.toFixed(0)} + capture ${r.captureMs.toFixed(0)})`);
  }
} else if (args.bench) {
  const [a, b] = String(args.bench).split(':').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) throw new Error(`Bad --bench range: ${args.bench}`);
  const first = Math.round(a * fps), last = Math.round(b * fps) - 1;
  const frames = []; for (let i = first; i <= last; i++) frames.push(i);
  const workerList = String(args['worker-list'] || '1,2,3,4,6').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
  console.log(`benchmarking ${frames.length} frames from ${a}s to ${b}s`);
  const results = [];
  for (const workers of workerList) {
    const pages = await Promise.all(Array.from({ length: workers }, (_, w) => openPage(`#bench-${workers}-${w}`)));
    await Promise.all(pages.map((p, i) => frameOf(p, frames[i % frames.length] / fps, 'image/jpeg', JPEG_QUALITY / 100)));
    let next = 0; const start = Date.now();
    await Promise.all(pages.map(async page => {
      while (next < frames.length) {
        const i = frames[next++];
        await frameOf(page, i / fps, 'image/jpeg', JPEG_QUALITY / 100);
      }
    }));
    const effective = (Date.now() - start) / frames.length;
    await Promise.all(pages.map(p => p.close()));
    results.push({ workers, effective });
    console.log(`${workers} worker${workers === 1 ? '' : 's'}: ${effective.toFixed(0)} ms/frame effective (${(1000 / effective).toFixed(2)} fps)`);
  }
  results.sort((x, y) => x.effective - y.effective);
  console.log(`best: --workers=${results[0].workers} (${results[0].effective.toFixed(0)} ms/frame effective)`);
} else if (args.loop) {
  // One full cycle of a standalone loop scene as PNGs (t = loop time); frame n equals frame 0, so it isn't rendered.
  const out = args.out || `out/loop_${args.loop}`, workers = +(args.workers || DEFAULT_WORKERS); mkdirSync(out, { recursive: true });
  const probe = await openPage(), len = await probe.evaluate(() => window.LOOP.len), n = Math.round(len * fps);
  await probe.close();
  let next = 0; const start = Date.now();
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const page = await openPage('#' + w);
    while (next < n) { const i = next++, r = await frameOf(page, i / fps, 'image/png', 1); writeFileSync(`${out}/l${String(i).padStart(3, '0')}.png`, r.buf); }
  }));
  console.log(`${n} loop frames → ${out}  (${((Date.now() - start) / n).toFixed(0)} ms/frame)`);
} else if (args.frames) {
  // Parallel, resumable: each worker page pulls the next missing frame index; files are written atomically.
  const [a, b] = String(args.frames).split(':').map(Number), workers = +(args.workers || DEFAULT_WORKERS);
  mkdirSync(FRAMES_DIR, { recursive: true });
  const first = Math.round(a * fps), last = Math.min(Math.ceil(DUR * fps) - 1, Math.round(b * fps) - 1);
  const todo = []; for (let i = first; i <= last; i++) { const f = `${FRAMES_DIR}/f${String(i).padStart(5, '0')}.jpg`; if (!existsSync(f) || statSync(f).size < 1000) todo.push(i); }
  console.log(`${todo.length} frames to render (${last - first + 1 - todo.length} already done), ${workers} workers`);
  let next = 0, done = 0; const start = Date.now();
  const work = async w => {
    const page = await openPage('#' + w);
    while (next < todo.length) {
      const i = todo[next++], f = `${FRAMES_DIR}/f${String(i).padStart(5, '0')}.jpg`;
      const r = await frameOf(page, i / fps, 'image/jpeg', JPEG_QUALITY / 100);
      writeFileSync(f + '.tmp', r.buf); renameSync(f + '.tmp', f);
      if (++done % 24 === 0 || done === todo.length) {
        const el = (Date.now() - start) / 1000;
        console.log(`frame ${done}/${todo.length}  ${(el / done * 1000).toFixed(0)} ms/frame effective  eta ${((todo.length - done) * el / done / 60).toFixed(1)} min`);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, (_, w) => work(w)));
} else {
  const page = await openPage();
  const [a, b] = args.clip ? String(args.clip).split(':').map(Number) : [0, DUR];
  const out = args.out || 'out/clip.mp4'; mkdirSync(dirname(out), { recursive: true });
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-ss', String(a), '-t', String(b - a), '-i', 'assets/pdoom.mp3',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', out],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const n = Math.round((b - a) * fps), start = Date.now();
  for (let i = 0; i < n; i++) {
    const r = await frameOf(page, a + i / fps, 'image/jpeg', .92);
    if (!ff.stdin.write(r.buf)) await new Promise(res => ff.stdin.once('drain', res));
    if (i % 24 === 0 || i === n - 1) console.log(`frame ${i + 1}/${n}  ${((Date.now() - start) / (i + 1)).toFixed(0)} ms/frame`);
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r));
  console.log(`wrote ${out}`);
}
await browser.close();
