// Sample-accurate capture on the audio thread. The main thread schedules a
// job with an AudioContext start time; recording begins on the exact sample
// at that time (not when a main-thread timer happens to fire), runs for a
// fixed number of frames, and the buffer is transferred back zero-copy.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.job = null;
    this.port.onmessage = ({ data }) => {
      if (data.cmd === 'start') {
        this.job = { id: data.id, start: data.startTime, frames: data.frames, buf: new Float32Array(data.frames), pos: 0, began: null };
      } else if (data.cmd === 'cancel') {
        this.job = null;
      }
    };
  }

  process(inputs) {
    const job = this.job;
    const ch = inputs[0] && inputs[0][0];
    if (!job || !ch) return true;

    let offset = 0;
    if (job.began === null) {
      if (currentTime + ch.length / sampleRate <= job.start) return true;
      offset = Math.max(0, Math.round((job.start - currentTime) * sampleRate));
      job.began = currentTime + offset / sampleRate;
    }
    const n = Math.min(ch.length - offset, job.frames - job.pos);
    job.buf.set(ch.subarray(offset, offset + n), job.pos);
    job.pos += n;

    if (job.pos >= job.frames) {
      this.port.postMessage({ id: job.id, samples: job.buf, began: job.began, sampleRate }, [job.buf.buffer]);
      this.job = null;
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
