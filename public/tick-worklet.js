// Runs on the audio thread and posts a tick every 8 render quanta (~21 ms).
// Used as the analysis clock because main-thread timers get throttled in
// background tabs, while audio processing does not.
class TickProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.count = 0;
  }

  process() {
    if (++this.count >= 8) {
      this.count = 0;
      this.port.postMessage(0);
    }
    return true;
  }
}

registerProcessor('tick', TickProcessor);
