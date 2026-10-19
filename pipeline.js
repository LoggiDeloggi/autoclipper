// video -> audio -> whisper.cpp -> Gemini ranking -> ffmpeg cuts of the best moments.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked'); // binaries can't run from inside asar

const EXE = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
const GEMINI = 'gemini-2.5-flash'; // free tier, ~1M token context
const BLOCK = 3600; // seconds of transcript per Gemini call (ponytail: fixed blocks, not token-counted)

// onOut/onErr receive raw chunks (used for progress parsing); stdout is always drained so the child can't block.
const run = (cmd, args, opts, onOut, onErr) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args.map(String), { windowsHide: true, ...opts });
    let err = '';
    p.stdout.on('data', (d) => onOut && onOut(String(d)));
    p.stderr.on('data', (d) => {
      err += d;
      onErr && onErr(String(d));
    });
    p.on('error', reject);
    p.on('close', (c) => {
      const why = err.split(/\r?\n/).filter((l) => /error/i.test(l)).slice(0, 3).join(' | ');
      c ? reject(new Error(`${path.basename(cmd)} exited ${c}: ${why || err.slice(-500)}`)) : resolve();
    });
  });

// ffmpeg with -progress: reports 0-99% via onPct. `total` = expected output seconds; if unknown, read from the input's Duration line.
function ffmpegRun(args, opts, onPct, total) {
  let dur = total;
  return run(
    ffmpeg,
    ['-progress', 'pipe:1', '-nostats', ...args],
    opts,
    (t) => {
      const m = [...t.matchAll(/out_time_us=(\d+)/g)].pop();
      if (m && dur) onPct(Math.min(99, Math.round((Number(m[1]) / 1e6 / dur) * 100)));
    },
    (t) => {
      const m = !dur && t.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (m) dur = +m[1] * 3600 + +m[2] * 60 + +m[3];
    }
  );
}

// Lists Vulkan devices with a throwaway run and returns the best one as {i, name} (a discrete GPU beats an integrated one,
// which whisper would otherwise pick first on hybrid laptops and run ~4x slower), or null if there is no Vulkan GPU.
async function pickVulkanDevice(cfg, work) {
  const probe = path.join(work, 'probe.wav');
  await ffmpegRun(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', 1, probe], undefined, () => {});
  let out = '';
  const grab = (s) => (out += s);
  try {
    await run(path.join(cfg.whisperDir, EXE), ['-m', cfg.model, '-f', probe, '-l', cfg.lang], undefined, grab, grab);
  } catch {}
  const devs = [...out.matchAll(/ggml_vulkan: (\d+) = (.*?) \| uma: (\d)/g)].map((m) => ({ i: +m[1], name: m[2], integrated: m[3] === '1' }));
  return devs.length ? devs.find((d) => !d.integrated) || devs[0] : null;
}

// Tries engines fastest-first and falls through on failure, always ending at forced CPU:
//   1. CUDA (optional NVIDIA download)   2. Vulkan GPU of the bundled build (AMD/Intel/NVIDIA)   3. bundled build with -ng (CPU only)
// cfg.mode: 'auto' = all of them, 'cpu' = only #3.
async function transcribe(wav, cfg, emit, work) {
  // whisper-cli reads argv in the ANSI codepage, so any other character in these paths (accents, emoji) breaks it.
  for (const p of process.platform === 'win32' ? [cfg.model, cfg.whisperDir, cfg.cudaDir, wav] : []) {
    if (/[^\x00-\x7F]/.test(p)) throw new Error(`Caminho com acentos ou simbolos nao suportado pelo Whisper: ${p}. Instale o app em uma pasta sem acentos.`);
  }
  const base = ['-m', cfg.model, '-f', wav, '-l', cfg.lang, '-pp', '-oj', '-of', wav];
  const tries = [];
  if (cfg.mode !== 'cpu' && fs.existsSync(path.join(cfg.cudaDir, EXE))) tries.push({ dir: cfg.cudaDir, extra: [], label: 'GPU NVIDIA (CUDA)' });
  if (cfg.mode !== 'cpu' && process.platform === 'darwin') {
    tries.push({ dir: cfg.whisperDir, extra: [], label: 'GPU (Metal)' }); // the Mac build uses Apple's GPU by default
  } else if (cfg.mode !== 'cpu') {
    emit(1, 0, 'Detectando GPU');
    const dev = await pickVulkanDevice(cfg, work);
    if (dev) tries.push({ dir: cfg.whisperDir, extra: ['-dev', dev.i], label: `GPU (Vulkan): ${dev.name}` });
  }
  tries.push({ dir: cfg.whisperDir, extra: ['-ng'], label: 'CPU' });
  let failure;
  for (const [i, t] of tries.entries()) {
    const label = t.label;
    emit(1, 0, label);
    const prog = (s) => {
      const m = [...s.matchAll(/progress =\s*(\d+)%/g)].pop();
      if (m) emit(1, Math.min(99, +m[1]), label);
    };
    try {
      await run(path.join(t.dir, EXE), [...base, ...t.extra], undefined, prog, prog);
      failure = null;
      break;
    } catch (e) {
      failure = e;
      if (i < tries.length - 1) emit(1, 0, `${label} falhou, tentando outro modo`);
    }
  }
  if (failure) throw failure;
  const j = JSON.parse(fs.readFileSync(wav + '.json', 'utf8'));
  return j.transcription.map((t) => ({ start: t.offsets.from / 1000, end: t.offsets.to / 1000, text: t.text.trim() }));
}

// Move LLM-proposed times onto the nearest sentence/segment boundaries so cuts don't land mid-word.
function snap(c, segs) {
  const near = (key, v) => segs.reduce((a, b) => (Math.abs(b[key] - v) < Math.abs(a[key] - v) ? b : a));
  const start = near('start', c.start).start;
  return { ...c, start, end: Math.max(near('end', c.end).end, start) };
}

async function askGemini(prompt, key) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3, thinkingConfig: { thinkingBudget: 1024 } } }), // bounded "thinking": ~3x faster than the default, same clip count
    });
    if (r.ok) {
      const text = (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('O Gemini nao devolveu resposta (conteudo bloqueado?)');
      return JSON.parse(text);
    }
    if (r.status === 400 || r.status === 403) throw new Error('Chave do Gemini invalida. Confira em Configuracoes.');
    if (![429, 500, 503].includes(r.status) || attempt === 3) {
      throw new Error(r.status === 429 ? 'Limite gratuito do Gemini atingido. Tente novamente mais tarde.' : `Gemini indisponivel (erro ${r.status})`);
    }
    await new Promise((res) => setTimeout(res, 5000 * attempt)); // transient: back off and retry
  }
}

// One Gemini call per BLOCK seconds of transcript.
async function collect(segs, key, onPct) {
  const end = segs[segs.length - 1].end;
  const total = Math.ceil(end / BLOCK);
  let done = 0;
  onPct(0);
  // Blocks are independent, so ask for all of them at once (the free tier allows ~10 requests/min).
  const parts = await Promise.all(Array.from({ length: total }, async (_, n) => {
    const t0 = n * BLOCK;
    const part = segs.filter((s) => s.start >= t0 && s.start < t0 + BLOCK);
    if (!part.length) return [];
    const want = Math.max(3, Math.round(Math.min(BLOCK, end - t0) / 300)); // ~1 candidate per 5 min
    const prompt =
      `Voce edita clips virais para TikTok/Reels/Shorts. Abaixo a transcricao com [segundo] no inicio de cada linha.\n` +
      `Escolha ate ${want} trechos de 20 a 60 segundos com forte gancho nos primeiros 3s, historia completa, emocao ou polemica. Seja criterioso na nota: reserve 8-10 so para os melhores.\n` +
      `Responda so JSON: {"clips":[{"start":<seg>,"end":<seg>,"score":<1-10>,"title":"<titulo curto>","reason":"<por que pode viralizar, 1 frase>"}]}\n\n` +
      part.map((s) => `[${Math.round(s.start)}] ${s.text}`).join('\n');
    const clips = (await askGemini(prompt, key)).clips || [];
    onPct(Math.round((++done / total) * 100));
    return clips;
  }));
  return parts.flat();
}

async function rank(segs, key, emit) {
  const found = await collect(segs, key, (p) => emit(2, p, 'Gemini'));
  const max = Math.min(12, Math.max(5, Math.round(segs[segs.length - 1].end / 300))); // final list size grows with video length
  const out = [];
  for (const c of found
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end))
    .map((c) => snap(c, segs))
    .filter((c) => c.end - c.start >= 10 && c.end - c.start <= 90)
    .sort((a, b) => b.score - a.score)) {
    if (out.length < max && !out.some((o) => c.start < o.end && c.end > o.start)) out.push(c);
  }
  return out;
}

// Cuts only: keeps the original resolution/aspect, no crop, no captions (user edits them).
// 'fast' (default) copies the streams: near-instant, but a clip starts at the keyframe just before c.start (a little extra lead-in).
// 'precise' re-encodes for frame-accurate cuts. If a copy fails (e.g. a codec mp4 can't hold), that clip is re-encoded.
async function render(file, c, i, outDir, onPct, cuts) {
  const out = `clip${i + 1}.mp4`;
  const cut = (codec) => ffmpegRun(['-y', '-ss', c.start, '-to', c.end, '-i', file, ...codec, out], { cwd: outDir }, onPct, c.end - c.start);
  const precise = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', 18, '-c:a', 'aac'];
  if (cuts === 'precise') await cut(precise);
  else await cut(['-c', 'copy', '-avoid_negative_ts', 'make_zero']).catch(() => cut(precise));
  return path.join(outDir, out);
}

// log receives {step: 0-3 (4 = done), pct: 0-100, msg}; only changed values are sent.
// cfg: {geminiKey, mode: 'auto'|'cpu'|'cuda', lang, whisperDir, model, cudaDir}
async function processVideo(file, outDir, log = () => {}, cfg) {
  if (!cfg.geminiKey) throw new Error('Cole sua chave do Gemini em Configuracoes antes de comecar.');
  let last = '';
  const t = {}; // seconds spent per step
  let cur = -1, since = Date.now(), engine = '';
  const emit = (step, pct, msg = '') => {
    const k = `${step}:${pct}:${msg}`;
    if (k === last) return;
    last = k;
    if (step !== cur) {
      if (cur >= 0) t[cur] = Math.round((Date.now() - since) / 1000);
      cur = step;
      since = Date.now();
    }
    if (step === 1 && msg && !/Detectando|falhou/.test(msg)) engine = msg;
    log({ step, pct, msg });
  };
  fs.mkdirSync(outDir, { recursive: true });
  // Scratch audio lives in an ASCII-only folder (ProgramData) because whisper-cli can't take non-ANSI paths; removed when done.
  const work = fs.mkdtempSync(path.join(process.env.ProgramData || os.tmpdir(), 'AutoClipper-'));
  try {
    const wav = path.join(work, 'audio.wav');
    emit(0, 0);
    await ffmpegRun(['-y', '-i', file, '-ar', 16000, '-ac', 1, wav], undefined, (p) => emit(0, p));
    const segs = await transcribe(wav, cfg, emit, work);
    if (!segs.length) throw new Error('Nenhuma fala detectada');
    emit(2, 0, 'Gemini');
    const clips = await rank(segs, cfg.geminiKey, emit);
    const results = [];
    for (const [i, c] of clips.entries()) {
      const msg = `clip ${i + 1}/${clips.length}: ${c.title || ''}`;
      emit(3, Math.round((i / clips.length) * 100), msg);
      results.push({ ...c, file: await render(file, c, i, outDir, (p) => emit(3, Math.round(((i + p / 100) / clips.length) * 100), msg), cfg.cuts) });
    }
    emit(4, 100, 'Pronto');
    return { clips: results, timings: { audio: t[0], transcribe: t[1], rank: t[2], cut: t[3], engine } };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { processVideo, snap };
