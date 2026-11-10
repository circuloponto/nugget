/**
 * The Lab's audio transport. The engine renders a whole MusicIR document to one buffer in
 * which every note already sits on its exact sample frame (renderDocument). This class only
 * plays that buffer: a single looping AudioBufferSourceNode at the context's own sample rate
 * (so nothing is resampled), started at an exact audio-clock time. Timing therefore does
 * not depend on JavaScript timers or on how busy the page is.
 *
 * The playhead is read from the audio clock, not from a timer, so what the screen shows is
 * what the audio device is playing (minus the device's reported output latency).
 */

export class LabPlayer {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private total = 0;
  /** Audio-clock time at which the current source began playing `startFrame`. */
  private startAt = 0;
  private startFrame = 0;
  private running = false;
  /** Frame to resume from while stopped. */
  private resting = 0;

  /** Counters for diagnostics (exposed as window.__labPlayer in development). */
  readonly stats = { starts: 0, loads: 0 };

  constructor() {
    if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
      (window as unknown as { __labPlayer?: LabPlayer }).__labPlayer = this;
    }
  }

  /** The context, created on first use (it stays suspended until a user gesture resumes it). */
  get context(): AudioContext {
    if (!this.ctx) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error("Web Audio is not available in this browser");
      this.ctx = new Ctor();
    }
    return this.ctx;
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }
  get isPlaying(): boolean {
    return this.running;
  }
  get totalFrames(): number {
    return this.total;
  }
  get state(): string {
    return this.ctx?.state ?? "none";
  }

  /** Audio the user is hearing now lags the clock by the output latency. */
  private latency(): number {
    const c = this.ctx;
    if (!c) return 0;
    return (c as AudioContext & { outputLatency?: number }).outputLatency || c.baseLatency || 0;
  }

  private wrap(frame: number): number {
    return this.total > 0 ? ((Math.floor(frame) % this.total) + this.total) % this.total : 0;
  }

  /** Current position in frames: from the audio clock while playing, else where it stopped. */
  position(): number {
    if (!this.running || !this.ctx) return this.resting;
    const elapsed = (this.ctx.currentTime - this.startAt - this.latency()) * this.ctx.sampleRate;
    return this.wrap(this.startFrame + Math.max(0, elapsed));
  }

  /**
   * Swap in new samples (a re-rendered document). If it is playing it carries on from `atFrame`
   * (default: the current position) with a very short crossfade, so editing a rhythm while it
   * plays does not stop the music.
   */
  load(samples: Float32Array, atFrame?: number): void {
    const ctx = this.context;
    const at = atFrame ?? this.position();
    const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buf.copyToChannel(new Float32Array(samples), 0);
    this.buffer = buf;
    this.total = samples.length;
    this.resting = this.wrap(at);
    this.stats.loads++;
    if (this.running) this.start(this.resting);
  }

  private start(frame: number): void {
    const ctx = this.context;
    if (!this.buffer) return;
    const now = ctx.currentTime;
    const when = now + 0.02; // a fixed, exact audio-clock start time
    this.fadeOut(now, when);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(1, when + 0.008);
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = this.total / ctx.sampleRate;
    src.connect(gain).connect(ctx.destination);
    src.start(when, frame / ctx.sampleRate);

    this.source = src;
    this.gain = gain;
    this.startAt = when;
    this.startFrame = frame;
    this.running = true;
    this.stats.starts++;
  }

  private fadeOut(now: number, until: number): void {
    const { source, gain } = this;
    if (!source || !gain) return;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, until);
    source.stop(until + 0.01);
    this.source = null;
    this.gain = null;
  }

  async play(): Promise<void> {
    const ctx = this.context;
    if (ctx.state === "suspended") await ctx.resume(); // browsers only allow sound after a user gesture
    if (!this.buffer || this.running) return;
    this.start(this.resting);
  }

  pause(): void {
    if (!this.running) return;
    this.resting = this.position();
    this.fadeOut(this.context.currentTime, this.context.currentTime + 0.02);
    this.running = false;
  }

  /** Move the playhead (playing or not). */
  seek(frame: number): void {
    this.resting = this.wrap(frame);
    if (this.running) this.start(this.resting);
  }

  dispose(): void {
    this.fadeOut(this.ctx?.currentTime ?? 0, (this.ctx?.currentTime ?? 0) + 0.01);
    void this.ctx?.close();
    this.ctx = null;
    this.running = false;
  }
}
