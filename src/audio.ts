// Everything you hear is synthesised: no audio files.
// The context starts on the first click (browsers require a gesture).
export class Sound {
  ctx: AudioContext | null = null;
  master!: GainNode;
  private noise!: AudioBuffer;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private fireGain!: GainNode;
  private shimmer!: GainNode;
  private crackleTimer = 0;
  enabled = true;
  fire = 1;

  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.8 : 0;
    // a touch of space on everything
    const verb = ctx.createConvolver();
    verb.buffer = this.impulse(2.6);
    const wet = ctx.createGain(); wet.gain.value = 0.32;
    this.master.connect(ctx.destination);
    verb.connect(wet).connect(ctx.destination);
    this.master.connect(verb);

    const len = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.95 * b2 + w * 0.048;
      d[i] = (b0 + b1 + b2 + w * 0.02) * 0.9; // pinkish
    }
    // wind bed
    const wind = ctx.createBufferSource(); wind.buffer = this.noise; wind.loop = true;
    this.windFilter = ctx.createBiquadFilter(); this.windFilter.type = 'bandpass'; this.windFilter.frequency.value = 380; this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0.18;
    wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
    wind.start();
    // fire bed (low roar), crackles are scheduled in update()
    const roar = ctx.createBufferSource(); roar.buffer = this.noise; roar.loop = true; roar.playbackRate.value = 0.7;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
    this.fireGain = ctx.createGain(); this.fireGain.gain.value = 0;
    roar.connect(lp).connect(this.fireGain).connect(this.master);
    roar.start();
    // aurora shimmer: detuned high sines, silent until you hold the sky
    this.shimmer = ctx.createGain(); this.shimmer.gain.value = 0;
    const trem = ctx.createOscillator(); trem.frequency.value = 0.35;
    const tremG = ctx.createGain(); tremG.gain.value = 0.25;
    for (const [f, g] of [[659.25, 0.05], [987.77, 0.035], [1318.5, 0.02], [662.1, 0.04]] as const) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = g;
      trem.connect(tremG).connect(og.gain);
      o.connect(og).connect(this.shimmer);
      o.start();
    }
    trem.start();
    this.shimmer.connect(this.master);
  }

  private impulse(sec: number) {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    return b;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.ctx) this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.2);
  }

  /** Lake ice "singing": a falling, ringing pew with a sharp snap in front. */
  crack(strength = 1) {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime;
    // snap
    const n = ctx.createBufferSource(); n.buffer = this.noise; n.playbackRate.value = 2;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.9 * strength, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    n.connect(hp).connect(ng).connect(this.master); n.start(t, Math.random()); n.stop(t + 0.15);
    // the pew: a chirp travelling down through the ice, echoed a few times
    for (let k = 0; k < 3; k++) {
      const s = t + 0.03 + k * (0.09 + Math.random() * 0.08);
      const o = ctx.createOscillator(); o.type = 'sine';
      const f0 = 2600 + Math.random() * 900;
      o.frequency.setValueAtTime(f0, s);
      o.frequency.exponentialRampToValueAtTime(260 + Math.random() * 120, s + 0.32);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.22 * strength / (k + 1), s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.45);
      o.connect(g).connect(this.master); o.start(s); o.stop(s + 0.5);
    }
    // low boom
    const b = ctx.createOscillator(); b.type = 'sine';
    b.frequency.setValueAtTime(90, t); b.frequency.exponentialRampToValueAtTime(38, t + 0.6);
    const bg = ctx.createGain(); bg.gain.setValueAtTime(0.35 * strength, t); bg.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    b.connect(bg).connect(this.master); b.start(t); b.stop(t + 0.9);
  }

  /** Snow sliding off branches and landing. */
  whump() {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = this.noise;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, t); lp.frequency.exponentialRampToValueAtTime(260, t + 0.7);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(0.7, t + 0.05); g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    n.connect(lp).connect(g).connect(this.master); n.start(t, Math.random()); n.stop(t + 1);
  }

  /** A soft crunch for clicking the snow. */
  crunch() {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = this.noise; n.playbackRate.value = 1.6;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    n.connect(bp).connect(g).connect(this.master); n.start(t, Math.random()); n.stop(t + 0.2);
  }

  /** Fire lighting up with a whoosh. */
  whoosh() {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = this.noise;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.7;
    bp.frequency.setValueAtTime(200, t); bp.frequency.exponentialRampToValueAtTime(1600, t + 0.5);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(0.6, t + 0.25); g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
    n.connect(bp).connect(g).connect(this.master); n.start(t, Math.random()); n.stop(t + 1.2);
  }

  update(dt: number, gust: number, fireLit: number, fireDist: number, surge: number) {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime;
    this.windGain.gain.setTargetAtTime(0.14 + gust * 0.5, t, 0.3);
    this.windFilter.frequency.setTargetAtTime(330 + gust * 500, t, 0.3);
    const near = Math.max(0, 1 - fireDist / 45);
    this.fireGain.gain.setTargetAtTime(0.5 * fireLit * near * near, t, 0.2);
    this.shimmer.gain.setTargetAtTime(surge * 0.55, t, 0.25);
    // crackles: little bursts at random times, louder close to the fire
    this.crackleTimer -= dt;
    if (fireLit > 0.3 && near > 0.05 && this.crackleTimer <= 0) {
      this.crackleTimer = 0.04 + Math.random() * 0.35;
      const n = ctx.createBufferSource(); n.buffer = this.noise; n.playbackRate.value = 2.5;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2000 + Math.random() * 3000; bp.Q.value = 3;
      const g = ctx.createGain(); const a = (0.15 + Math.random() * 0.5) * near * fireLit;
      g.gain.setValueAtTime(a, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.03 + Math.random() * 0.05);
      n.connect(bp).connect(g).connect(this.master); n.start(t, Math.random() * 2); n.stop(t + 0.1);
    }
  }
}
