// Convertit le micro (souvent 48 kHz) en PCM 16 bits mono 16 kHz, par paquets de 100 ms.
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;            // position fractionnaire dans le flux d'entrée
    this.prev = 0;           // dernier échantillon du bloc précédent (interpolation)
    this.out = new Int16Array(1600);
    this.n = 0;
    this.sumSq = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i === 0 ? this.prev : ch[i - 1];
      const b = ch[i];
      const s = Math.max(-1, Math.min(1, a + (b - a) * frac));
      this.sumSq += s * s;
      this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.out.length) {
        const rms = Math.sqrt(this.sumSq / this.n);
        this.port.postMessage({ pcm: this.out.buffer, rms }, [this.out.buffer]);
        this.out = new Int16Array(1600);
        this.n = 0;
        this.sumSq = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    this.prev = ch[ch.length - 1];
    return true;
  }
}
registerProcessor('mic-processor', MicProcessor);
