// On-device captions: Whisper running in the browser via Transformers.js
// (Apache-2.0 — the pick from docs/OSS-SURVEY.md). The model downloads
// ONCE from Hugging Face (~78 MB, whisper-tiny.en quantized) and is then
// cached by the browser; transcription itself never leaves the machine.
// The library is lazy-loaded only when the user taps "Generate captions",
// so the recorder's first paint and bundle stay exactly as they were.

import type { CaptionCue } from './recorder'

export type { CaptionCue }

const MODEL_ID = 'Xenova/whisper-tiny.en'

type ProgressInfo = { status?: string; progress?: number }
type AsrPipeline = (
  audio: Float32Array,
  opts: Record<string, unknown>,
) => Promise<{ chunks?: { text: string; timestamp: [number, number] }[] }>

let pipelinePromise: Promise<AsrPipeline> | null = null

async function getTranscriber(onProgress: (pct: number | null) => void): Promise<AsrPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      // Loose typing on purpose: the package's types shift between majors;
      // the runtime surface used here (pipeline/env) is stable.
      const tf = (await import('@huggingface/transformers')) as unknown as {
        pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<AsrPipeline>
        env: { allowLocalModels: boolean }
      }
      tf.env.allowLocalModels = false
      return tf.pipeline('automatic-speech-recognition', MODEL_ID, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (p: ProgressInfo) => {
          if (p?.status === 'progress' && typeof p.progress === 'number') onProgress(Math.round(p.progress))
        },
      })
    })()
    // a failed load shouldn't poison later attempts
    pipelinePromise.catch(() => { pipelinePromise = null })
  }
  return pipelinePromise
}

/** Decode any take blob to 16 kHz mono PCM — what Whisper eats. */
async function toWhisperAudio(blob: Blob): Promise<Float32Array> {
  const raw = await blob.arrayBuffer()
  const actx = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await actx.decodeAudioData(raw)
  } finally {
    void actx.close().catch(() => {})
  }
  const targetRate = 16000
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate))
  const off = new OfflineAudioContext(1, frames, targetRate)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  const rendered = await off.startRendering()
  return rendered.getChannelData(0)
}

export async function transcribeTake(
  blob: Blob,
  onProgress: (stage: string, pct: number | null) => void,
): Promise<CaptionCue[]> {
  onProgress('Loading Whisper model (one-time download, ~78 MB)…', null)
  const transcriber = await getTranscriber((pct) => onProgress('Downloading model…', pct))
  onProgress('Reading audio…', null)
  const audio = await toWhisperAudio(blob)
  onProgress('Transcribing on this machine…', null)
  const out = await transcriber(audio, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  })
  const cues: CaptionCue[] = (out.chunks ?? [])
    .map((c) => ({
      start: Math.max(0, c.timestamp?.[0] ?? 0),
      end: Math.max(0, c.timestamp?.[1] ?? 0),
      text: (c.text ?? '').trim(),
    }))
    .filter((c) => c.text && c.end > c.start)
  if (!cues.length) throw new Error('Whisper heard no speech in this take')
  return cues
}

function stamp(sec: number, comma: boolean): string {
  const ms = Math.round((sec - Math.floor(sec)) * 1000)
  const s = Math.floor(sec) % 60
  const m = Math.floor(sec / 60) % 60
  const h = Math.floor(sec / 3600)
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${p(h)}:${p(m)}:${p(s)}${comma ? ',' : '.'}${p(ms, 3)}`
}

export function toSrt(cues: CaptionCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.start, true)} --> ${stamp(c.end, true)}\n${c.text}\n`)
    .join('\n')
}

export function toVtt(cues: CaptionCue[]): string {
  return 'WEBVTT\n\n' + cues
    .map((c) => `${stamp(c.start, false)} --> ${stamp(c.end, false)}\n${c.text}\n`)
    .join('\n')
}

export function transcriptText(cues: CaptionCue[]): string {
  return cues.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim()
}
