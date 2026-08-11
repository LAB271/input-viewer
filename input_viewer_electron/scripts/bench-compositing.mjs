#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2025-2026 Schuberg Philis / Lab271
/**
 * Benchmark the compositing paths (issue #62).
 *
 * #62 asks three questions and this answers them with numbers rather than
 * intuition:
 *
 *   1. Are capture frames imported zero-copy as WebGPU external textures?
 *   2. Is it worth moving compositing to an OffscreenCanvas in a worker, so
 *      settings-UI activity can never stutter video?
 *   3. How does any of it compare to the current pipeline at wall resolution?
 *
 * Three paths are measured on the SAME synthetic feeds at the same output size:
 *
 *   css     -- the shipped default: two <video> elements placed by CSS, the
 *              browser composites. Nothing is drawn by us.
 *   gpu     -- createGpuCompositor() on a main-thread canvas, one draw per rAF.
 *   worker  -- the same compositor on an OffscreenCanvas inside a Worker, fed
 *              VideoFrames from MediaStreamTrackProcessor.
 *
 * Each path runs twice: quiet, and again while the MAIN THREAD is deliberately
 * blocked for STALL_MS every second. That second run is the whole point of
 * question 2 -- a path that keeps presenting frames through a main-thread stall
 * is one where the settings UI cannot stutter video.
 *
 * Requires a real GPU. It runs headless Chrome WITHOUT the SwiftShader flags the
 * shader-check harness uses, because a software rasteriser makes every timing
 * here meaningless, and with a fake capture device so the run is reproducible and
 * needs no hardware.
 *
 * Usage:
 *   npm run bench                       # 1920x1080 output
 *   npm run bench -- --size 6000x1200   # the videowall
 *   npm run bench -- --seconds 8
 */
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const size = arg('size', '1920x1080')
const seconds = Number(arg('seconds', '6'))
const port = Number(arg('port', '5190'))
const [OUT_W, OUT_H] = size.split('x').map(Number)

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
]
const chrome = process.env.CHROME_PATH || CHROME_CANDIDATES.find((p) => existsSync(p))
if (!chrome) {
  console.error('bench: no Chrome/Chromium found. Set CHROME_PATH.')
  process.exit(2)
}

const root = path.resolve(import.meta.dirname, '..')

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>bench</title>
<style>html,body{margin:0;background:#000;overflow:hidden}
video,canvas{position:absolute;top:0;left:0}</style></head>
<body><script type="module" src="/__bench.js"></script></body></html>`

// The worker: the SHIPPED compositor, unmodified, on an OffscreenCanvas. It is
// fed VideoFrames rather than video elements -- importExternalTexture accepts
// either, which is why no change to gpu-compositor.js was needed for this.
const WORKER = `
import { createGpuCompositor } from '/gpu-compositor.js'
let comp = null
let frames = [null, null]
let drawn = 0
self.onmessage = async (e) => {
  const m = e.data
  if (m.type === 'init') {
    comp = await createGpuCompositor(m.canvas)
    postMessage({ type: 'ready', ok: Boolean(comp) })
    const loop = () => {
      if (comp && frames[0] && frames[1]) {
        comp.draw([
          { video: frames[0], offset: [0, 0], scale: [0.5, 1] },
          { video: frames[1], offset: [0.5, 0], scale: [0.5, 1] }
        ])
        drawn++
      }
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  } else if (m.type === 'frame') {
    if (frames[m.i]) frames[m.i].close()
    frames[m.i] = m.frame
  } else if (m.type === 'report') {
    postMessage({ type: 'report', drawn })
    drawn = 0
  }
}
`

const BENCH = `
import { createGpuCompositor, supportsGpuCompositing } from '/gpu-compositor.js'

const OUT_W = ${OUT_W}, OUT_H = ${OUT_H}
const SECONDS = ${seconds}
// How long the main thread is blocked, once a second, in the "loaded" runs. 120ms
// is a plausible settings-panel hitch: a layout plus a settings write.
const STALL_MS = 120

const log = (o) => console.log('BENCH ' + JSON.stringify(o))

async function twoStreams() {
  const a = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })
  const b = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })
  return [a, b]
}

function videoFor(stream) {
  const v = document.createElement('video')
  v.srcObject = stream
  v.muted = true
  v.autoplay = true
  v.playsInline = true
  document.body.appendChild(v)
  return v.play().then(() => v)
}

/** Block the main thread synchronously, the way a settings write would. */
function stall(ms) {
  const end = performance.now() + ms
  while (performance.now() < end) { /* deliberately busy */ }
}

/**
 * Run one path for SECONDS, optionally stalling the main thread once a second.
 * Returns frames presented per second, as counted by that path's own loop.
 */
async function run(path, streams, loaded) {
  const stop = []
  let count = 0
  let workerReport = null

  if (path === 'css') {
    // Nothing to draw: the browser composites the video elements. What we can
    // count is how often WE get a frame callback, which is the main-thread view.
    const vids = await Promise.all(streams.map(videoFor))
    vids.forEach((v, i) => {
      v.style.width = (OUT_W / 2) + 'px'
      v.style.height = OUT_H + 'px'
      v.style.left = (i * OUT_W / 2) + 'px'
    })
    let live = true
    const tick = () => { if (!live) return; count++; vids[0].requestVideoFrameCallback(tick) }
    vids[0].requestVideoFrameCallback(tick)
    stop.push(() => { live = false; vids.forEach((v) => v.remove()) })
  } else if (path === 'gpu') {
    const canvas = document.createElement('canvas')
    canvas.width = OUT_W; canvas.height = OUT_H
    document.body.appendChild(canvas)
    const comp = await createGpuCompositor(canvas)
    if (!comp) return { fps: null, note: 'no webgpu' }
    const vids = await Promise.all(streams.map(videoFor))
    vids.forEach((v) => { v.style.width = '1px'; v.style.height = '1px'; v.style.opacity = '0' })
    let live = true
    const loop = () => {
      if (!live) return
      comp.draw([
        { video: vids[0], offset: [0, 0], scale: [0.5, 1] },
        { video: vids[1], offset: [0.5, 0], scale: [0.5, 1] }
      ])
      count++
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    stop.push(() => { live = false; comp.destroy(); canvas.remove(); vids.forEach((v) => v.remove()) })
  } else if (path === 'worker') {
    if (typeof MediaStreamTrackProcessor === 'undefined') return { fps: null, note: 'no MediaStreamTrackProcessor' }
    const canvas = document.createElement('canvas')
    canvas.width = OUT_W; canvas.height = OUT_H
    document.body.appendChild(canvas)
    const off = canvas.transferControlToOffscreen()
    const w = new Worker('/__bench-worker.js', { type: 'module' })
    const ready = new Promise((r) => {
      w.addEventListener('message', (e) => {
        if (e.data.type === 'ready') r(e.data.ok)
        if (e.data.type === 'report') workerReport && workerReport(e.data.drawn)
      })
    })
    w.postMessage({ type: 'init', canvas: off }, [off])
    if (!await ready) { w.terminate(); return { fps: null, note: 'worker webgpu unavailable' } }

    // Pump VideoFrames to the worker. This is the piece the current pipeline does
    // not have: a video element cannot be handed to a worker, so the frames come
    // from MediaStreamTrackProcessor instead.
    const readers = streams.map((s, i) => {
      const proc = new MediaStreamTrackProcessor({ track: s.getVideoTracks()[0] })
      const reader = proc.readable.getReader()
      let live = true
      ;(async () => {
        while (live) {
          const { value, done } = await reader.read()
          if (done || !live) { value && value.close(); break }
          w.postMessage({ type: 'frame', i, frame: value }, [value])
        }
      })()
      return () => { live = false; reader.cancel().catch(() => {}) }
    })
    stop.push(() => { readers.forEach((f) => f()); w.terminate(); canvas.remove() })
    // The worker counts its own draws; ask it at the end.
    workerReport = null
    const askWorker = () => new Promise((r) => { workerReport = r; w.postMessage({ type: 'report' }) })
    // Warm up, then measure.
    await new Promise((r) => setTimeout(r, 400))
    await askWorker()
    const t0 = performance.now()
    const stalls = loaded ? setInterval(() => stall(STALL_MS), 1000) : null
    await new Promise((r) => setTimeout(r, SECONDS * 1000))
    if (stalls) clearInterval(stalls)
    const drawn = await askWorker()
    const elapsed = (performance.now() - t0) / 1000
    stop.forEach((f) => f())
    return { fps: drawn / elapsed }
  }

  // Main-thread paths: warm up, then count for SECONDS.
  await new Promise((r) => setTimeout(r, 400))
  count = 0
  const t0 = performance.now()
  const stalls = loaded ? setInterval(() => stall(STALL_MS), 1000) : null
  await new Promise((r) => setTimeout(r, SECONDS * 1000))
  if (stalls) clearInterval(stalls)
  const elapsed = (performance.now() - t0) / 1000
  const fps = count / elapsed
  stop.forEach((f) => f())
  return { fps }
}

async function main() {
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null
  const info = adapter ? (adapter.info || {}) : {}
  log({ type: 'env', output: OUT_W + 'x' + OUT_H, seconds: SECONDS,
        webgpu: Boolean(adapter), gpu: info.vendor ? (info.vendor + '/' + info.architecture) : 'unknown',
        supportsGpuCompositing: await supportsGpuCompositing() })

  // NOTE ON UNITS: css is counted with requestVideoFrameCallback, so it reports
  // capture frames arriving on the main thread and is bounded by the camera. gpu
  // and worker count composites we issue, bounded by refresh. Each path is only
  // meaningfully compared with ITSELF, quiet versus stalled.
  for (const p of ['css', 'gpu', 'worker']) {
    for (const loaded of [false, true]) {
      let r
      try {
        const streams = await twoStreams()
        r = await run(p, streams, loaded)
        streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
      } catch (e) {
        r = { fps: null, note: e.name + ': ' + e.message }
      }
      log({ type: 'result', path: p, loaded, fps: r.fps === null ? null : Number(r.fps.toFixed(1)), note: r.note })
      await new Promise((r2) => setTimeout(r2, 300))
    }
  }
  log({ type: 'done' })
}
main().catch((e) => log({ type: 'fatal', error: e.message }))
`

const server = await createServer({
  configFile: false,
  root: path.join(root, 'src/renderer'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port, strictPort: true, open: false },
  plugins: [{
    name: 'bench',
    configureServer(s) {
      s.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0]
        if (url === '/__bench.html') { res.setHeader('Content-Type', 'text/html'); return res.end(PAGE) }
        if (url === '/__bench.js') { res.setHeader('Content-Type', 'application/javascript'); return res.end(BENCH) }
        if (url === '/__bench-worker.js') { res.setHeader('Content-Type', 'application/javascript'); return res.end(WORKER) }
        next()
      })
    }
  }]
})
await server.listen()

const profile = mkdtempSync(path.join(tmpdir(), 'bench-profile-'))
const proc = spawn(chrome, [
  '--headless=new',
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--no-sandbox', '--disable-gpu-sandbox',
  // Deliberately NO SwiftShader flags: this is a timing run, and a software
  // rasteriser would make every number here meaningless.
  '--enable-unsafe-webgpu',
  // Synthetic capture, so the benchmark is reproducible and needs no hardware.
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-logging=stderr', '--v=0',
  `--window-size=${Math.min(OUT_W, 2000)},${Math.min(OUT_H, 1200)}`,
  `http://127.0.0.1:${port}/__bench.html`
], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })

let buf = ''
const results = []
const finished = new Promise((resolve) => {
  const onData = (d) => {
    buf += d
    let m
    const re = /BENCH (\{[^\n]*?\})/g
    while ((m = re.exec(buf))) {
      try {
        const o = JSON.parse(m[1])
        if (!results.some((r) => JSON.stringify(r) === JSON.stringify(o))) {
          results.push(o)
          if (o.type === 'env') {
            console.log(`bench: ${o.output}, ${o.seconds}s per run, GPU ${o.gpu}, WebGPU ${o.webgpu ? 'yes' : 'no'}`)
          }
          if (o.type === 'result') {
            const label = `${o.path}${o.loaded ? ' + main-thread stalls' : ''}`
            // Units differ by path, and conflating them is the easy way to draw a
            // wrong conclusion from this table. css counts VIDEO FRAMES reaching
            // the main thread (so it is capped by the capture rate); gpu and
            // worker count COMPOSITES we issued (capped by refresh). Compare each
            // path against its own quiet run, not against the others.
            const unit = o.path === 'css' ? 'video frames/s' : 'composites/s'
            console.log(`  ${label.padEnd(30)} ${o.fps === null ? '   n/a' : String(o.fps).padStart(6)} ${unit}${o.note ? '  (' + o.note + ')' : ''}`)
          }
          if (o.type === 'done' || o.type === 'fatal') resolve(o)
        }
      } catch { /* partial line */ }
    }
  }
  proc.stdout.on('data', onData)
  proc.stderr.on('data', onData)
  setTimeout(() => resolve({ type: 'timeout' }), (seconds * 2 * 3 + 60) * 1000)
})

const outcome = await finished
try { process.kill(-proc.pid, 'SIGKILL') } catch { /* already gone */ }
try { proc.kill('SIGKILL') } catch { /* already gone */ }
await server.close()
try { rmSync(profile, { recursive: true, force: true }) } catch { /* chrome exiting */ }

if (outcome.type !== 'done') {
  console.error(`bench: did not complete (${outcome.type}${outcome.error ? ': ' + outcome.error : ''})`)
  process.exit(1)
}
