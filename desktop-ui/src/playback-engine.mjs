// Two bounded PCM windows are scheduled at a time. Seeking and pausing invalidate
// outstanding IPC reads so late replies cannot restart audio.
export class PlaybackEngine {
  constructor({ durationMs, read, update, fail, createContext = () => new AudioContext() }) {
    Object.assign(this, { durationMs, read, update, fail, createContext });
    this.nodes = [];
    this.position = 0;
    this.generation = 0;
    this.playing = false;
  }
  current() {
    if (!this.context || !this.playing) return this.position;
    const now = this.context.currentTime;
    let position = this.position;
    for (const item of this.nodes) {
      if (now < item.at) break;
      position = Math.min(item.endMs, item.startMs + (now - item.at) * 1000 * this.speed);
    }
    return Math.min(this.durationMs, position);
  }
  pause() {
    this.position = this.current();
    this.generation++;
    this.playing = false;
    clearInterval(this.timer);
    for (const { node } of this.nodes) { node.stop(); node.disconnect(); }
    this.nodes = [];
    this.update({ playing: false, position: this.position });
  }
  seek(position) {
    this.pause();
    this.position = Math.max(0, Math.min(Math.floor(position), this.durationMs));
    this.update({ playing: false, position: this.position });
  }
  async play({ fromMs = this.position, speed = 1, source = "all" } = {}) {
    this.seek(fromMs >= this.durationMs ? 0 : fromMs);
    const generation = this.generation;
    try {
      this.context ??= this.createContext();
      await this.context.resume();
      if (generation !== this.generation) return;
      this.speed = speed;
      this.source = source;
      this.nextMs = this.position;
      this.nextAt = this.context.currentTime + 0.05;
      this.playing = true;
      this.update({ playing: true, position: this.position });
      const tick = () => {
        if (generation !== this.generation) return;
        this.position = this.current();
        const now = this.context.currentTime;
        this.nodes = this.nodes.filter((item) => {
          if (item.until > now) return true;
          item.node.disconnect();
          return false;
        });
        this.update({ playing: true, position: this.position });
        if (this.nextMs >= this.durationMs && !this.nodes.length && !this.loading) {
          this.position = this.durationMs;
          this.pause();
          return;
        }
        this.pump(generation);
      };
      this.timer = setInterval(tick, 80);
      await this.pump(generation);
    } catch (error) {
      if (generation === this.generation) { this.pause(); this.fail(error); }
    }
  }
  async pump(generation) {
    if (this.loading === generation || generation !== this.generation) return;
    this.loading = generation;
    try {
      while (generation === this.generation && this.nodes.length < 2 && this.nextMs < this.durationMs) {
        const startMs = this.nextMs;
        const data = await this.read({ startMs, durationMs: 5000, source: this.source });
        if (generation !== this.generation) return;
        const buffer = this.context.createBuffer(1, data.samples.length, data.sampleRate);
        buffer.copyToChannel(data.samples, 0);
        const node = this.context.createBufferSource();
        node.buffer = buffer;
        node.playbackRate.value = this.speed;
        node.connect(this.context.destination);
        const at = Math.max(this.nextAt, this.context.currentTime + 0.02);
        const until = at + buffer.duration / this.speed;
        this.nextMs = startMs + data.durationMs;
        this.nodes.push({ node, at, until, startMs, endMs: this.nextMs });
        node.start(at);
        this.nextAt = until;
      }
    } catch (error) {
      if (generation === this.generation) { this.pause(); this.fail(error); }
    } finally {
      if (this.loading === generation) this.loading = null;
    }
  }
  dispose() {
    this.pause();
    this.context?.close().catch(() => {});
  }
}
