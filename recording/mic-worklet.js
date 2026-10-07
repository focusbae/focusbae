class PcmBatch extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(1600);
    this.index = 0;
    this.stopped = false;
    this.pending = 0;
    this.port.onmessage = ({ data }) => {
      if (data === "ack") {
        this.pending = Math.max(0, this.pending - 1);
        return;
      }
      this.flush();
      this.stopped = true;
      this.port.postMessage("stopped");
    };
  }
  flush() {
    if (this.index) {
      if (this.pending >= 10) {
        this.stopped = true;
        this.port.postMessage("overflow");
        this.index = 0;
        return;
      }
      const data = this.samples.slice(0, this.index);
      this.pending++;
      this.port.postMessage(data.buffer, [data.buffer]);
      this.index = 0;
    }
  }
  process(inputs) {
    if (this.stopped) return false;
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (const value of samples) {
      if (this.stopped) return false;
      const sample = Math.max(-1, Math.min(1, value));
      this.samples[this.index++] = sample < 0 ? sample * 32768 : sample * 32767;
      if (this.index === this.samples.length) this.flush();
    }
    return true;
  }
}
registerProcessor("pcm-batch", PcmBatch);
