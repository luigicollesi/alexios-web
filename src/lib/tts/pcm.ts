import { CARTESIA_BYTES_PER_SAMPLE } from "./key-manager.ts";

/**
 * Cartesia streams raw little-endian float32 PCM. HTTP chunk boundaries have
 * no relation to sample boundaries; collect 2,048 samples (~46 ms) per Web
 * Audio source and preserve incomplete frames across network reads.
 */
export class PcmF32Chunker {
  private pending = new Uint8Array(0);
  private readonly framesPerChunk: number;

  constructor(framesPerChunk = 2048) {
    this.framesPerChunk = framesPerChunk;
    if (!Number.isSafeInteger(framesPerChunk) || framesPerChunk < 1) {
      throw new Error("Invalid PCM frame count.");
    }
  }

  private decode(bytes: Uint8Array): Float32Array {
    if (bytes.byteLength % CARTESIA_BYTES_PER_SAMPLE !== 0) {
      throw new Error("PCM alignment lost.");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array(bytes.byteLength / CARTESIA_BYTES_PER_SAMPLE);
    for (let i = 0; i < samples.length; i++) {
      const value = view.getFloat32(i * CARTESIA_BYTES_PER_SAMPLE, true);
      samples[i] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    }
    return samples;
  }

  push(bytes: Uint8Array): Float32Array[] {
    if (!bytes.length) return [];
    const merged = new Uint8Array(this.pending.length + bytes.length);
    merged.set(this.pending);
    merged.set(bytes, this.pending.length);
    const byteCount = this.framesPerChunk * CARTESIA_BYTES_PER_SAMPLE;
    const frames: Float32Array[] = [];
    let cursor = 0;
    while (merged.length - cursor >= byteCount) {
      frames.push(this.decode(merged.subarray(cursor, cursor + byteCount)));
      cursor += byteCount;
    }
    this.pending = merged.slice(cursor);
    return frames;
  }

  flush(): Float32Array | null {
    if (!this.pending.length) return null;
    if (this.pending.length % CARTESIA_BYTES_PER_SAMPLE !== 0) {
      throw new Error("Incomplete PCM sample at end of Cartesia stream.");
    }
    const tail = this.decode(this.pending);
    this.pending = new Uint8Array(0);
    return tail;
  }
}
