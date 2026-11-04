// Fast concat (Mediabunny, MPL-2.0, WebCodecs): joins MP4/H.264 clips by
// copying their encoded packets — no re-encode, seconds instead of a
// real-time render. It is ONLY valid when every piece is MP4 with an
// H.264 video track at identical dimensions; anything else must use the
// render export. This module never guesses: it validates each input with
// Mediabunny first and reports the exact reason when a set doesn't
// qualify, so the UI can fall back loudly instead of silently dropping
// a polish pass or mangling a file.
//
// Audio: pieces with an AAC track are concatenated; a piece with NO audio
// track (the silent brand cards) contributes a silent gap of the same
// length only implicitly — packet timelines are offset by each piece's
// own duration, which keeps the audible pieces in the right order and
// position. A non-AAC audio codec (or mismatched sample rates/channels)
// disqualifies the set.

export interface ConcatPiece {
  label: string
  blob: Blob
  duration: number
}

export type ConcatCheck =
  | { ok: true }
  | { ok: false; reason: string }

interface PieceInfo {
  width: number
  height: number
  duration: number
  hasAudio: boolean
  audioCodec: string | null
}

async function inspectPiece(mb: typeof import('mediabunny'), piece: ConcatPiece): Promise<PieceInfo> {
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(piece.blob) })
  const format = await input.getFormat()
  if (format !== mb.MP4) throw new Error(`"${piece.label}" is not an MP4 file`)
  const video = await input.getPrimaryVideoTrack()
  if (!video) throw new Error(`"${piece.label}" has no video track`)
  const codec = await video.getCodec()
  if (codec !== 'avc') throw new Error(`"${piece.label}" is not H.264 (it is ${codec ?? 'unknown'})`)
  const duration = (await input.computeDuration()) || piece.duration
  const audio = await input.getPrimaryAudioTrack()
  return {
    width: video.codedWidth,
    height: video.codedHeight,
    duration,
    hasAudio: !!audio,
    audioCodec: audio ? await audio.getCodec() : null,
  }
}

export async function checkConcat(pieces: ConcatPiece[]): Promise<ConcatCheck> {
  if (pieces.length < 2) return { ok: false, reason: 'Fast concat needs at least two clips.' }
  if (pieces.some((p) => !p.blob)) return { ok: false, reason: 'One of the clips is not loaded yet.' }
  try {
    const mb = await import('mediabunny')
    const infos: PieceInfo[] = []
    for (const p of pieces) infos.push(await inspectPiece(mb, p))
    const { width, height } = infos[0]
    for (let i = 1; i < infos.length; i++) {
      if (infos[i].width !== width || infos[i].height !== height) {
        return { ok: false, reason: `"${pieces[i].label}" is ${infos[i].width}×${infos[i].height} but "${pieces[0].label}" is ${width}×${height} — fast concat needs identical sizes. The render export scales to fit instead.` }
      }
    }
    const withAudio = infos.filter((i) => i.hasAudio)
    if (withAudio.length && withAudio.some((i) => i.audioCodec !== 'aac')) {
      return { ok: false, reason: 'An audio track is not AAC — fast concat copies packets as-is, so mixed audio codecs need the render export.' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Could not inspect the clips.' }
  }
}

export async function fastConcat(
  pieces: ConcatPiece[],
  onProgress?: (p: number) => void,
  isCancelled?: () => boolean,
): Promise<{ blob: Blob; durationSec: number }> {
  const mb = await import('mediabunny')
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() })
  const videoSource = new mb.EncodedVideoPacketSource('avc')
  output.addVideoTrack(videoSource)
  let audioSource: InstanceType<typeof mb.EncodedAudioPacketSource> | null = null

  // First pass: durations (packet timeline offsets) per piece.
  const inputs: InstanceType<typeof mb.Input>[] = []
  const durations: number[] = []
  for (const piece of pieces) {
    const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(piece.blob) })
    inputs.push(input)
    durations.push((await input.computeDuration()) || piece.duration)
  }
  const total = durations.reduce((a, b) => a + b, 0)

  // The audio track can only be added once we know some piece has AAC audio.
  let anyAudio = false
  for (const input of inputs) {
    if (await input.getPrimaryAudioTrack()) { anyAudio = true; break }
  }
  if (anyAudio) {
    audioSource = new mb.EncodedAudioPacketSource('aac')
    output.addAudioTrack(audioSource)
  }

  await output.start()
  let offset = 0
  let videoMetaSent = false
  let audioMetaSent = false
  try {
    for (let i = 0; i < pieces.length; i++) {
      if (isCancelled?.()) throw new Error('Fast concat cancelled — nothing was saved.')
      const input = inputs[i]
      const videoTrack = await input.getPrimaryVideoTrack()
      if (!videoTrack) throw new Error(`"${pieces[i].label}" has no video track`)
      const videoSink = new mb.EncodedPacketSink(videoTrack)
      for await (const packet of videoSink.packets()) {
        const shifted = packet.clone({ timestamp: packet.timestamp + offset })
        if (!videoMetaSent) {
          const decoderConfig = await videoTrack.getDecoderConfig()
          await videoSource.add(shifted, decoderConfig ? { decoderConfig } : undefined)
          videoMetaSent = true
        } else {
          await videoSource.add(shifted)
        }
      }
      const audioTrack = await input.getPrimaryAudioTrack()
      if (audioTrack && audioSource) {
        const audioSink = new mb.EncodedPacketSink(audioTrack)
        for await (const packet of audioSink.packets()) {
          const shifted = packet.clone({ timestamp: packet.timestamp + offset })
          if (!audioMetaSent) {
            const decoderConfig = await audioTrack.getDecoderConfig()
            await audioSource.add(shifted, decoderConfig ? { decoderConfig } : undefined)
            audioMetaSent = true
          } else {
            await audioSource.add(shifted)
          }
        }
      }
      offset += durations[i]
      onProgress?.(offset / total)
    }
  } catch (e) {
    await output.cancel().catch(() => {})
    throw e
  }
  await output.finalize()
  const buffer = (output.target as unknown as { buffer: ArrayBuffer | null }).buffer
  if (!buffer) throw new Error('Fast concat produced no data')
  return { blob: new Blob([buffer as BlobPart], { type: 'video/mp4' }), durationSec: total }
}
