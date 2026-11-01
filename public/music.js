// Spokojna muzyka w tle generowana na żywo (Web Audio API) – bez plików i bez praw autorskich.
// Cztery akordy w pętli, miękkie tło (pad) i delikatna melodia z pogłosem.
const Music = (() => {
  const BPM = 68;
  const BEAT = 60 / BPM;
  const BAR = BEAT * 4;
  // Fmaj7 – Em7 – Dm7 – Cmaj7 (częstotliwości w Hz)
  const CHORDS = [
    [174.61, 220.0, 261.63, 329.63],
    [164.81, 196.0, 246.94, 293.66],
    [146.83, 174.61, 220.0, 261.63],
    [130.81, 164.81, 196.0, 246.94]
  ];
  const BASS = [87.31, 82.41, 73.42, 65.41];
  // pentatonika C – zawsze brzmi dobrze z tymi akordami
  const MELODY_NOTES = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];
  // stały wzór melodii (indeksy nut, null = pauza), 8 ósemek na takt
  const PATTERN = [
    [4, null, 2, null, 3, null, null, 1],
    [2, null, null, 0, 1, null, 2, null],
    [3, null, 1, null, null, 0, 1, null],
    [0, null, 2, null, 1, null, null, null]
  ];

  let ctx = null;
  let master = null;
  let reverb = null;
  let playing = false;
  let nextBarTime = 0;
  let bar = 0;
  let schedulerId = null;
  let volume = 0.3;

  function makeReverb() {
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    }
    const conv = ctx.createConvolver();
    conv.buffer = buf;
    return conv;
  }

  function init() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    reverb = makeReverb();
    const wet = ctx.createGain();
    wet.gain.value = 0.45;
    reverb.connect(wet).connect(master);
  }

  function voice(freq, start, dur, { type = 'sine', gain = 0.05, attack = 0.02, cutoff = 2000, wet = true } = {}) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    osc.type = type;
    osc.frequency.value = freq;
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(gain, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(f).connect(g);
    g.connect(master);
    if (wet) g.connect(reverb);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }

  function scheduleBar(t, i) {
    const chord = CHORDS[i % CHORDS.length];
    // pad – długie, miękkie akordy
    for (const n of chord) {
      voice(n, t, BAR * 1.15, { type: 'triangle', gain: 0.035, attack: 1.2, cutoff: 900 });
      voice(n * 1.003, t, BAR * 1.15, { type: 'sine', gain: 0.02, attack: 1.5, cutoff: 1200 });
    }
    // bas
    voice(BASS[i % BASS.length], t, BAR * 0.95, { type: 'sine', gain: 0.07, attack: 0.3, cutoff: 400, wet: false });
    // melodia – co drugi przebieg pętli trochę inna (odwrócony wzór)
    const pattern = PATTERN[i % PATTERN.length];
    const flip = Math.floor(i / 4) % 2 === 1;
    pattern.forEach((idx, step) => {
      if (idx == null) return;
      const note = MELODY_NOTES[flip ? MELODY_NOTES.length - 1 - idx : idx];
      voice(note, t + step * (BEAT / 2), BEAT * 2.5, { type: 'sine', gain: 0.03, attack: 0.01, cutoff: 3000 });
    });
  }

  function scheduler() {
    while (nextBarTime < ctx.currentTime + 1.5) {
      scheduleBar(nextBarTime, bar++);
      nextBarTime += BAR;
    }
  }

  function applyVolume(ramp = 0.3) {
    if (!master) return;
    const target = playing ? volume * volume : 0; // krzywa kwadratowa – suwak działa naturalniej
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(target, ctx.currentTime, ramp);
  }

  return {
    get playing() { return playing; },
    get volume() { return volume; },
    play() {
      if (!ctx) init();
      ctx.resume();
      if (!schedulerId) {
        nextBarTime = ctx.currentTime + 0.1;
        schedulerId = setInterval(scheduler, 250);
        scheduler();
      }
      playing = true;
      applyVolume(0.8);
    },
    pause() {
      playing = false;
      applyVolume(0.3);
      // po wyciszeniu usypiamy dźwięk, żeby nie obciążał komputera
      setTimeout(() => { if (!playing) ctx.suspend(); }, 1500);
    },
    setVolume(v) {
      volume = Math.min(1, Math.max(0, v));
      applyVolume(0.05);
    }
  };
})();
