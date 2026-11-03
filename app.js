const $ = (id) => document.getElementById(id);

function forcePlaybackAudioSession(){
  try{
    if(navigator.audioSession){
      navigator.audioSession.type = 'playback';
    }
  }catch(e){}
}
forcePlaybackAudioSession();

const ui = {
  speed: $('speed'), rpm: $('rpm'), rpmBar: $('rpmBar'), gear: $('gear'),
  gpsBadge: $('gpsBadge'), status: $('status'), accel: $('accel'), audioState: $('audioState'),
  startBtn: $('startBtn'), testBtn: $('testBtn'), gpsBtn: $('gpsBtn'), demoBtn: $('demoBtn'), stopBtn: $('stopBtn'),
  intensity: $('intensity'), intensityValue: $('intensityValue'),
  character: $('character'), characterValue: $('characterValue'),
  crackle: $('crackle'), crackleValue: $('crackleValue'),
  demoPanel: $('demoPanel'), throttle: $('throttle'), audioCtxState: $('audioCtxState')
};

let watchId = null;
let running = false;
let lastGps = null;
let simTimer = null;
let filteredSpeed = 0;
let filteredAccel = 0;

const idleRpm = 850;
const redline = 6800;
const gearRatios = [0, 3.15, 2.08, 1.50, 1.17, 0.94, 0.78];
const finalDrive = 3.10;
const wheelCircumferenceM = 2.25;

let current = { speedKmh: 0, accel: 0, rpm: idleRpm, gear: 0, throttle: 0 };

function clamp(v,min,max){ return Math.max(min, Math.min(max,v)); }
function lerp(a,b,t){ return a + (b-a)*t; }

function chooseGear(speedKmh, accel, previousGear){
  if(speedKmh < 2) return 0;

  const hard = accel > 1.5;
  const up = hard ? [0,34,69,108,151,205] : [0,29,61,96,137,187];
  const down = [0,20,44,72,108,150];

  let gear = previousGear || 1;
  gear = clamp(gear,1,6);

  while(gear < 6 && speedKmh >= up[gear]) gear++;
  while(gear > 1 && speedKmh < down[gear-1]) gear--;

  return gear;
}

function calculateRpm(speedKmh, gear, accel){
  if(gear === 0){
    const idleLoad = clamp(Math.max(accel,0)*75, 0, 260);
    return idleRpm + idleLoad;
  }

  const speedMps = speedKmh / 3.6;
  const wheelRpm = (speedMps / wheelCircumferenceM) * 60;
  let rpm = wheelRpm * gearRatios[gear] * finalDrive;

  rpm += clamp(accel,0,6) * 220;
  return clamp(rpm, idleRpm, redline);
}

function render(){
  ui.speed.textContent = Math.round(current.speedKmh);
  ui.rpm.textContent = Math.round(current.rpm);
  ui.rpmBar.style.width = clamp((current.rpm/redline)*100, 4, 100) + '%';
  ui.gear.textContent = current.gear === 0 ? 'N' : current.gear;
  ui.accel.textContent = current.accel.toFixed(2) + ' m/s²';
}

class V8EngineV3 {
  constructor(){
    this.ctx = null;
    this.master = null;
    this.shiftGain = null;
    this.engineMix = null;
    this.intakeGain = null;
    this.intakeFilter = null;
    this.bodyFilter = null;
    this.lowShelf = null;
    this.dryGain = null;
    this.wetGain = null;
    this.loopLayers = [];
    this.noiseSource = null;
    this.noiseGain = null;
    this.lastAccel = 0;
    this.lastThrottle = 0;
    this.isShifting = false;
    this.startedAt = 0;
    this.anchors = [
      { rpm: 900,  name: 'idle' },
      { rpm: 2200, name: 'mid' },
      { rpm: 4200, name: 'pull' },
      { rpm: 6200, name: 'high' }
    ];
  }

  async ensureRunning(){
    if(!this.ctx) return false;
    try{
      forcePlaybackAudioSession();
      if(this.ctx.state !== 'running') await this.ctx.resume();
      ui.audioCtxState.textContent = this.ctx.state;
      return this.ctx.state === 'running';
    }catch(e){
      ui.audioCtxState.textContent = 'Fehler';
      return false;
    }
  }

  makeLoopBuffer(baseRpm, loadAmount){
    const sr = this.ctx.sampleRate;
    const firingHz = baseRpm / 60 * 4;
    const pulseCount = baseRpm < 1400 ? 96 : (baseRpm < 3500 ? 128 : 192);
    const duration = pulseCount / firingHz;
    const length = Math.max(2048, Math.floor(duration * sr));
    const buffer = this.ctx.createBuffer(1, length, sr);
    const out = buffer.getChannelData(0);

    const pattern = loadAmount > 0.5
      ? [1.00,0.78,0.93,0.72,1.06,0.80,0.95,0.74]
      : [0.84,0.72,0.80,0.68,0.88,0.73,0.82,0.69];

    let hpPrevX = 0;
    let hpPrevY = 0;
    const hpA = 0.996;

    for(let i=0;i<length;i++){
      const t = i / sr;
      const cycle = t * firingHz;
      const pulseIndex = Math.floor(cycle);
      const p = cycle - pulseIndex;
      const amp = pattern[pulseIndex % 8];
      const bankSwing = 1 + 0.055 * Math.sin((pulseIndex % 8) / 8 * Math.PI * 2);

      const attack = Math.exp(-p * (loadAmount > 0.5 ? 16 : 21));
      const chamber =
        Math.sin(Math.PI * 2 * (p * 0.82 + 0.06)) * 0.78 +
        Math.sin(Math.PI * 2 * (p * 1.72 + 0.19)) * 0.34 +
        Math.sin(Math.PI * 2 * (p * 3.45 + 0.41)) * 0.18 +
        Math.sin(Math.PI * 2 * (p * 6.10 + 0.13)) * 0.07;

      const exhaustPulse = amp * bankSwing * attack * chamber;
      const body =
        0.15 * Math.sin(Math.PI * 2 * (cycle / 2)) +
        0.08 * Math.sin(Math.PI * 2 * (cycle / 4 + 0.17));
      const valve = 0.025 * Math.sin(Math.PI * 2 * (p * 7.6 + (pulseIndex % 4) * 0.11));

      let x = exhaustPulse * (0.74 + loadAmount * 0.38) + body + valve;
      x = Math.tanh(x * (1.45 + loadAmount * 0.9));

      const y = x - hpPrevX + hpA * hpPrevY;
      hpPrevX = x;
      hpPrevY = y;
      out[i] = y * 0.52;
    }

    return buffer;
  }

  makeNoiseBuffer(seconds=2){
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let brown = 0;
    for(let i=0;i<len;i++){
      const white = Math.random()*2-1;
      brown = (brown + white*0.035) / 1.035;
      data[i] = brown * 2.1;
    }
    return buffer;
  }

  makeExhaustIR(){
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * 0.075);
    const buffer = this.ctx.createBuffer(1, len, sr);
    const data = buffer.getChannelData(0);
    for(let i=0;i<len;i++){
      const t = i / sr;
      const env = Math.exp(-t * 38);
      const ring =
        Math.sin(2*Math.PI*92*t) * 0.54 +
        Math.sin(2*Math.PI*147*t + 0.7) * 0.30 +
        Math.sin(2*Math.PI*225*t + 1.2) * 0.16;
      data[i] = ring * env * 0.55;
    }
    data[0] += 0.7;
    return buffer;
  }

  bankWeights(rpm){
    const a = this.anchors;
    if(rpm <= a[0].rpm) return [1,0,0,0];
    if(rpm >= a[a.length-1].rpm) return [0,0,0,1];

    const weights = [0,0,0,0];
    for(let i=0;i<a.length-1;i++){
      if(rpm >= a[i].rpm && rpm <= a[i+1].rpm){
        const t = (rpm-a[i].rpm)/(a[i+1].rpm-a[i].rpm);
        const smooth = t*t*(3-2*t);
        weights[i] = 1-smooth;
        weights[i+1] = smooth;
        break;
      }
    }
    return weights;
  }

  async start(){
    forcePlaybackAudioSession();
    if(this.ctx){
      await this.ensureRunning();
      return;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({latencyHint:'interactive'});
    await this.ctx.resume();
    ui.audioCtxState.textContent = this.ctx.state;
    this.startedAt = this.ctx.currentTime;

    this.engineMix = this.ctx.createGain();
    this.engineMix.gain.value = 0.92;

    const convolver = this.ctx.createConvolver();
    convolver.buffer = this.makeExhaustIR();
    convolver.normalize = true;

    this.dryGain = this.ctx.createGain();
    this.dryGain.gain.value = 0.86;
    this.wetGain = this.ctx.createGain();
    this.wetGain.gain.value = 0.22;

    this.shiftGain = this.ctx.createGain();
    this.shiftGain.gain.value = 1;

    this.bodyFilter = this.ctx.createBiquadFilter();
    this.bodyFilter.type = 'lowpass';
    this.bodyFilter.frequency.value = 2200;
    this.bodyFilter.Q.value = 0.58;

    this.lowShelf = this.ctx.createBiquadFilter();
    this.lowShelf.type = 'lowshelf';
    this.lowShelf.frequency.value = 155;
    this.lowShelf.gain.value = 6;

    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -17;
    compressor.knee.value = 16;
    compressor.ratio.value = 4.5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.12;

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.0001;

    this.engineMix.connect(this.dryGain).connect(this.shiftGain);
    this.engineMix.connect(convolver).connect(this.wetGain).connect(this.shiftGain);
    this.shiftGain.connect(this.bodyFilter).connect(this.lowShelf).connect(compressor).connect(this.master).connect(this.ctx.destination);

    this.loopLayers = [];
    this.anchors.forEach((anchor, anchorIndex)=>{
      [0,1].forEach(loadFamily=>{
        const src = this.ctx.createBufferSource();
        src.buffer = this.makeLoopBuffer(anchor.rpm, loadFamily);
        src.loop = true;
        src.playbackRate.value = idleRpm / anchor.rpm;

        const gain = this.ctx.createGain();
        gain.gain.value = 0.0001;
        src.connect(gain).connect(this.engineMix);
        src.start();

        this.loopLayers.push({
          src,
          gain,
          anchorIndex,
          baseRpm: anchor.rpm,
          loadFamily
        });
      });
    });

    const noiseSrc = this.ctx.createBufferSource();
    noiseSrc.buffer = this.makeNoiseBuffer();
    noiseSrc.loop = true;
    this.intakeFilter = this.ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.frequency.value = 950;
    this.intakeFilter.Q.value = 0.8;
    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.value = 0.0001;
    noiseSrc.connect(this.intakeFilter).connect(this.noiseGain).connect(this.shiftGain);
    noiseSrc.start();
    this.noiseSource = noiseSrc;

    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(0.15, now, 0.07);
    ui.audioState.textContent = 'V8 V3 · Loop-Bank';
  }

  setEngine(rpm, accel, throttle){
    if(!this.ctx) return;

    const now = this.ctx.currentTime;
    const throttleN = clamp(throttle/100,0,1);
    const accelLoad = clamp(Math.max(accel,0)/5.5,0,1);
    const load = clamp(throttleN*0.72 + accelLoad*0.48, 0, 1);
    const overrun = throttleN < 0.08 && accel < -0.25;
    const intensity = Number(ui.intensity.value)/100;
    const character = Number(ui.character.value)/100;
    const rpmN = clamp((rpm-idleRpm)/(redline-idleRpm),0,1);

    const idleLope = rpm < 1200
      ? 1 + Math.sin((now-this.startedAt)*Math.PI*2*1.75)*0.012*(1-rpmN)
      : 1;

    const weights = this.bankWeights(rpm);
    const loadMix = overrun ? 0.06 : clamp(0.08 + load*0.92, 0.05, 1);
    const cruiseMix = 1 - loadMix*0.78;

    this.loopLayers.forEach(layer=>{
      const bankW = weights[layer.anchorIndex];
      const familyW = layer.loadFamily ? loadMix : cruiseMix;
      const gainTarget = Math.max(0.0001, bankW * familyW * (layer.loadFamily ? 0.27 : 0.22));
      layer.gain.gain.setTargetAtTime(gainTarget, now, 0.055);

      const rate = clamp((rpm / layer.baseRpm) * idleLope, 0.55, 1.85);
      layer.src.playbackRate.setTargetAtTime(rate, now, 0.035);
    });

    this.bodyFilter.frequency.setTargetAtTime(
      1050 + rpmN*3200 + load*1050 + character*650,
      now,
      0.055
    );
    this.bodyFilter.Q.setTargetAtTime(0.45 + character*0.5, now, 0.08);
    this.lowShelf.gain.setTargetAtTime(4.5 + character*6.5 + load*1.5, now, 0.08);
    this.wetGain.gain.setTargetAtTime(0.14 + character*0.17, now, 0.08);

    this.intakeFilter.frequency.setTargetAtTime(900 + rpmN*2550, now, 0.05);
    this.intakeFilter.Q.setTargetAtTime(0.7 + load*0.55, now, 0.06);
    this.noiseGain.gain.setTargetAtTime(0.006 + load*0.09 + rpmN*0.025, now, 0.05);

    const level = (0.11 + load*0.075 + rpmN*0.025) * intensity;
    this.master.gain.setTargetAtTime(level, now, 0.06);

    const throttleDrop = this.lastThrottle - throttle;
    const crackleChance = Number(ui.crackle.value)/100;
    if((throttleDrop > 20 || (this.lastAccel > 1.0 && accel < -0.3)) && Math.random() < crackleChance*0.72){
      this.crackle(0.65 + rpmN*0.65);
    }

    this.lastAccel = accel;
    this.lastThrottle = throttle;
  }

  shiftBlip(direction=1){
    if(!this.ctx || !this.shiftGain || this.isShifting) return;
    this.isShifting = true;

    const t = this.ctx.currentTime;
    this.shiftGain.gain.cancelScheduledValues(t);
    this.shiftGain.gain.setValueAtTime(1,t);
    this.shiftGain.gain.linearRampToValueAtTime(0.28,t+0.032);
    this.shiftGain.gain.linearRampToValueAtTime(0.70,t+0.085);
    this.shiftGain.gain.linearRampToValueAtTime(1,t+0.16);

    if(direction > 0) this.exhaustPop(0.075);
    setTimeout(()=>{ this.isShifting=false; },175);
  }

  exhaustPop(volume=0.07){
    if(!this.ctx) return;
    const t = this.ctx.currentTime;

    const len = Math.floor(this.ctx.sampleRate * 0.11);
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let lp = 0;
    for(let i=0;i<len;i++){
      const env = Math.exp(-i/(len*0.20));
      const n = Math.random()*2-1;
      lp += (n-lp)*0.18;
      data[i] = lp*env;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 145 + Math.random()*110;
    bp.Q.value = 0.75;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    src.connect(bp).connect(gain).connect(this.shiftGain);
    src.start(t);
  }

  crackle(strength=1){
    if(!this.ctx) return;
    const count = 1 + (Math.random() < 0.45 ? 1 : 0) + (Math.random() < 0.12 ? 1 : 0);

    for(let n=0;n<count;n++){
      const delay = n*0.045 + Math.random()*0.03;
      const t = this.ctx.currentTime + delay;
      const len = Math.floor(this.ctx.sampleRate*0.05);
      const buffer = this.ctx.createBuffer(1,len,this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let shaped = 0;

      for(let i=0;i<len;i++){
        const env = Math.exp(-i/(len*0.17));
        shaped += ((Math.random()*2-1)-shaped)*0.27;
        data[i] = shaped*env;
      }

      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 180 + Math.random()*300;
      bp.Q.value = 0.7;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.048 * strength;
      src.connect(bp).connect(gain).connect(this.shiftGain);
      src.start(t);
    }
  }

  stop(){
    if(!this.ctx) return;
    const ctx = this.ctx;
    this.master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.045);
    setTimeout(()=>{
      ctx.close();
      if(this.ctx === ctx) this.ctx = null;
      this.loopLayers = [];
      this.noiseSource = null;
      ui.audioState.textContent = 'Aus';
      ui.audioCtxState.textContent = 'geschlossen';
    },170);
  }

  async testTone(){
    forcePlaybackAudioSession();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const temp = !this.ctx;
    const testCtx = this.ctx || new Ctx({latencyHint:'interactive'});

    try{
      if(testCtx.state !== 'running') await testCtx.resume();
      ui.audioCtxState.textContent = testCtx.state;

      const t = testCtx.currentTime;
      const osc = testCtx.createOscillator();
      const gain = testCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440,t);
      osc.frequency.exponentialRampToValueAtTime(880,t+0.45);
      gain.gain.setValueAtTime(0.0001,t);
      gain.gain.exponentialRampToValueAtTime(0.28,t+0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001,t+0.65);
      osc.connect(gain).connect(testCtx.destination);
      osc.start(t);
      osc.stop(t+0.7);

      ui.audioState.textContent = 'TESTTON';
      ui.status.textContent = 'Audiotest läuft';

      setTimeout(async()=>{
        if(!running) ui.audioState.textContent = 'Aus';
        if(temp){
          try{ await testCtx.close(); }catch(e){}
          if(!running) ui.audioCtxState.textContent = 'geschlossen';
        }
      },800);
    }catch(e){
      ui.status.textContent = 'Audio-Fehler: ' + e.message;
      ui.audioCtxState.textContent = 'Fehler';
    }
  }
}

const audio = new V8EngineV3();

function updateModel(speedKmh, accel, throttle=null){
  filteredSpeed = lerp(filteredSpeed, Math.max(0,speedKmh), 0.34);
  filteredAccel = lerp(filteredAccel, accel || 0, 0.26);

  current.speedKmh = filteredSpeed;
  current.accel = filteredAccel;
  if(throttle !== null) current.throttle = lerp(current.throttle, throttle, 0.35);

  const previousGear = current.gear;
  const nextGear = chooseGear(current.speedKmh,current.accel,previousGear);
  current.gear = nextGear;

  const targetRpm = calculateRpm(current.speedKmh,current.gear,current.accel);
  current.rpm = lerp(current.rpm,targetRpm,0.36);

  if(previousGear && nextGear !== previousGear){
    audio.shiftBlip(nextGear > previousGear ? 1 : -1);
  }

  audio.setEngine(current.rpm,current.accel,current.throttle);
  render();
}

async function startEngine(){
  await audio.start();
  await audio.ensureRunning();
  running = true;
  ui.startBtn.textContent = 'ENGINE RUNNING';
  ui.status.textContent = 'V8 V3 Loop-Engine läuft';
}

function startGps(){
  if(!navigator.geolocation){
    ui.status.textContent='Geolocation nicht unterstützt';
    return;
  }
  if(watchId !== null) return;

  lastGps = null;

  watchId = navigator.geolocation.watchPosition(pos=>{
    const ts = pos.timestamp;
    let speedMps = Number.isFinite(pos.coords.speed) ? pos.coords.speed : null;

    if(speedMps === null && lastGps){
      const R=6371000;
      const toRad=d=>d*Math.PI/180;
      const dLat=toRad(pos.coords.latitude-lastGps.lat);
      const dLon=toRad(pos.coords.longitude-lastGps.lon);
      const a=Math.sin(dLat/2)**2+
        Math.cos(toRad(lastGps.lat))*Math.cos(toRad(pos.coords.latitude))*Math.sin(dLon/2)**2;
      const distance=2*R*Math.asin(Math.sqrt(a));
      const dt=(ts-lastGps.ts)/1000;
      if(dt>0.2) speedMps=distance/dt;
    }

    if(speedMps === null) speedMps=current.speedKmh/3.6;

    const kmh=Math.max(0,speedMps*3.6);
    let accel=0;

    if(lastGps){
      const dt=(ts-lastGps.ts)/1000;
      if(dt>0.15){
        accel=((kmh-lastGps.kmh)/3.6)/dt;
      }
    }

    accel=clamp(accel,-5,7);
    const inferredThrottle=clamp(accel*22 + Math.max(0,kmh-current.speedKmh)*3,0,100);

    lastGps={lat:pos.coords.latitude,lon:pos.coords.longitude,ts,kmh};
    ui.demoPanel.classList.add('hidden');
    ui.gpsBadge.textContent='GPS LIVE';
    ui.gpsBadge.classList.add('live');
    ui.status.textContent='GPS ±' + Math.round(pos.coords.accuracy) + ' m';

    updateModel(kmh,accel,inferredThrottle);
  },err=>{
    ui.status.textContent='GPS Fehler: ' + err.message;
    ui.gpsBadge.textContent='GPS FEHLER';
    ui.gpsBadge.classList.remove('live');
  },{
    enableHighAccuracy:true,
    maximumAge:100,
    timeout:10000
  });
}

function stopGps(){
  if(watchId!==null){
    navigator.geolocation.clearWatch(watchId);
    watchId=null;
  }
  ui.gpsBadge.textContent='GPS AUS';
  ui.gpsBadge.classList.remove('live');
}

function startDemo(){
  stopGps();
  ui.demoPanel.classList.remove('hidden');
  ui.status.textContent='Demo aktiv';

  if(simTimer) clearInterval(simTimer);

  simTimer=setInterval(()=>{
    const throttle=Number(ui.throttle.value)/100;
    const aeroDrag=0.0045*current.speedKmh;
    const rolling=0.12;
    const decel=throttle<0.02 ? 1.15 : rolling;
    const accel=throttle*6.0-aeroDrag-decel;
    const next=Math.max(0,current.speedKmh+accel*3.6*0.1);
    updateModel(next,accel,throttle*100);
  },100);
}

function stopAll(){
  running=false;
  stopGps();
  if(simTimer){ clearInterval(simTimer); simTimer=null; }
  ui.demoPanel.classList.add('hidden');
  audio.stop();

  filteredSpeed=0;
  filteredAccel=0;
  current={speedKmh:0,accel:0,rpm:idleRpm,gear:0,throttle:0};
  render();
  ui.status.textContent='Gestoppt';
  ui.startBtn.textContent='START ENGINE';
}

ui.startBtn.addEventListener('click',startEngine);
ui.testBtn.addEventListener('click',async()=>{ await audio.testTone(); });
ui.gpsBtn.addEventListener('click',async()=>{
  if(!running) await startEngine();
  startGps();
});
ui.demoBtn.addEventListener('click',async()=>{
  if(!running) await startEngine();
  startDemo();
});
ui.stopBtn.addEventListener('click',stopAll);

ui.intensity.addEventListener('input',()=>{
  ui.intensityValue.textContent=ui.intensity.value + '%';
});
ui.character.addEventListener('input',()=>{
  ui.characterValue.textContent=ui.character.value + '%';
});
ui.crackle.addEventListener('input',()=>{
  ui.crackleValue.textContent=ui.crackle.value + '%';
});

document.querySelectorAll('[data-speed]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    filteredSpeed=Number(btn.dataset.speed);
    current.speedKmh=filteredSpeed;
    updateModel(filteredSpeed,0,Number(ui.throttle.value));
  });
});

render();
