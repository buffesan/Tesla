const $ = (id) => document.getElementById(id);

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

const idleRpm = 820;
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
    const idleLoad = clamp(Math.max(accel,0)*70, 0, 220);
    return idleRpm + idleLoad;
  }

  const speedMps = speedKmh / 3.6;
  const wheelRpm = (speedMps / wheelCircumferenceM) * 60;
  let rpm = wheelRpm * gearRatios[gear] * finalDrive;

  rpm += clamp(accel,0,6) * 210;
  return clamp(rpm, idleRpm, redline);
}

function render(){
  ui.speed.textContent = Math.round(current.speedKmh);
  ui.rpm.textContent = Math.round(current.rpm);
  ui.rpmBar.style.width = `${clamp((current.rpm/redline)*100, 4, 100)}%`;
  ui.gear.textContent = current.gear === 0 ? 'N' : current.gear;
  ui.accel.textContent = `${current.accel.toFixed(2)} m/s²`;
}

class V8EngineV2 {
  constructor(){
    this.ctx = null;
    this.master = null;
    this.engineBus = null;
    this.exhaustBus = null;
    this.intakeBus = null;
    this.lowShelf = null;
    this.exhaustFilter = null;
    this.intakeFilter = null;
    this.sources = [];
    this.noise = null;
    this.lastAccel = 0;
    this.lastThrottle = 0;
    this.idleLfo = null;
    this.idleDepth = null;
    this.isShifting = false;
  }

  makeDistortion(amount=28){
    const curve = new Float32Array(2048);
    const k = amount;
    for(let i=0;i<curve.length;i++){
      const x = i * 2 / (curve.length - 1) - 1;
      curve[i] = ((3+k)*x*20*Math.PI/180)/(Math.PI+k*Math.abs(x));
    }
    return curve;
  }

  makePeriodicWave(){
    const real = new Float32Array(12);
    const imag = new Float32Array(12);
    imag[1]=1.00; imag[2]=0.46; imag[3]=0.29; imag[4]=0.18;
    imag[5]=0.12; imag[6]=0.08; imag[7]=0.05; imag[8]=0.035;
    imag[9]=0.025; imag[10]=0.018; imag[11]=0.012;
    return this.ctx.createPeriodicWave(real, imag, {disableNormalization:false});
  }

  async ensureRunning(){
    if(!this.ctx) return false;
    try{
      if(this.ctx.state !== 'running') await this.ctx.resume();
      ui.audioCtxState.textContent = this.ctx.state;
      return this.ctx.state === 'running';
    }catch(e){
      ui.audioCtxState.textContent = 'Fehler';
      return false;
    }
  }

  async start(){
    if(this.ctx){
      await this.ensureRunning();
      return;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({latencyHint:'interactive'});
    await this.ctx.resume();
    ui.audioCtxState.textContent = this.ctx.state;

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.0001;

    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 18;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.14;

    this.lowShelf = this.ctx.createBiquadFilter();
    this.lowShelf.type = 'lowshelf';
    this.lowShelf.frequency.value = 150;
    this.lowShelf.gain.value = 7;

    this.engineBus = this.ctx.createGain();
    this.exhaustBus = this.ctx.createGain();
    this.intakeBus = this.ctx.createGain();

    const saturator = this.ctx.createWaveShaper();
    saturator.curve = this.makeDistortion(32);
    saturator.oversample = '2x';

    this.exhaustFilter = this.ctx.createBiquadFilter();
    this.exhaustFilter.type = 'lowpass';
    this.exhaustFilter.frequency.value = 1550;
    this.exhaustFilter.Q.value = 0.65;

    this.intakeFilter = this.ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.frequency.value = 1250;
    this.intakeFilter.Q.value = 0.85;

    this.engineBus.connect(saturator).connect(this.exhaustFilter).connect(this.exhaustBus);
    this.intakeBus.connect(this.intakeFilter);
    this.exhaustBus.connect(this.lowShelf);
    this.intakeFilter.connect(this.lowShelf);
    this.lowShelf.connect(compressor).connect(this.master).connect(this.ctx.destination);

    const wave = this.makePeriodicWave();
    const layers = [
      {mul:1.00, gain:0.28, detune:-4},
      {mul:0.50, gain:0.12, detune:3},
      {mul:2.00, gain:0.07, detune:-2},
      {mul:1.50, gain:0.045, detune:5}
    ];

    layers.forEach(layer=>{
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.setPeriodicWave(wave);
      osc.detune.value = layer.detune;
      gain.gain.value = layer.gain;
      osc.connect(gain).connect(this.engineBus);
      osc.start();
      this.sources.push({osc,gain,mul:layer.mul});
    });

    const noiseBuffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    let brown = 0;
    for(let i=0;i<data.length;i++){
      const white = Math.random()*2-1;
      brown = (brown + 0.02*white) / 1.02;
      data[i] = brown * 2.4;
    }

    const noiseSrc = this.ctx.createBufferSource();
    noiseSrc.buffer = noiseBuffer;
    noiseSrc.loop = true;
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = 0.02;
    noiseSrc.connect(noiseGain).connect(this.intakeBus);
    noiseSrc.start();
    this.noise = {src:noiseSrc,gain:noiseGain};

    this.idleLfo = this.ctx.createOscillator();
    this.idleLfo.type = 'sine';
    this.idleLfo.frequency.value = 6.7;
    this.idleDepth = this.ctx.createGain();
    this.idleDepth.gain.value = 0.010;
    this.idleLfo.connect(this.idleDepth).connect(this.master.gain);
    this.idleLfo.start();

    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(0.13, now, 0.06);
    ui.audioState.textContent = 'V8 V2';
  }

  setEngine(rpm, accel, throttle){
    if(!this.ctx) return;

    const now = this.ctx.currentTime;
    const ignitionHz = Math.max(42, rpm/60 * 4);
    const throttleN = clamp(throttle/100,0,1);
    const accelLoad = clamp(Math.max(accel,0)/5.5,0,1);
    const load = clamp(throttleN*0.68 + accelLoad*0.55, 0, 1.2);
    const intensity = Number(ui.intensity.value)/100;
    const character = Number(ui.character.value)/100;

    this.sources.forEach((s,i)=>{
      const f = ignitionHz * s.mul;
      s.osc.frequency.setTargetAtTime(f, now, 0.025);
      const dynamic = [0.30,0.11,0.065,0.04][i] * (0.75 + load*0.5);
      s.gain.gain.setTargetAtTime(dynamic, now, 0.05);
    });

    const rpmN = clamp((rpm-idleRpm)/(redline-idleRpm),0,1);
    const body = 0.045 + load*0.105 + rpmN*0.025;
    this.master.gain.setTargetAtTime(body * intensity, now, 0.045);

    this.exhaustFilter.frequency.setTargetAtTime(
      720 + rpmN*2000 + load*1100 + character*500,
      now, 0.04
    );

    this.exhaustFilter.Q.setTargetAtTime(0.5 + character*0.8, now, 0.05);
    this.lowShelf.gain.setTargetAtTime(4 + character*7, now, 0.08);
    this.intakeFilter.frequency.setTargetAtTime(850 + rpmN*2300, now, 0.05);
    this.noise.gain.gain.setTargetAtTime(0.012 + load*0.052 + rpmN*0.012, now, 0.05);
    this.idleDepth.gain.setTargetAtTime(rpm < 1200 ? 0.010*(1-rpmN) : 0.001, now, 0.08);

    const throttleDrop = this.lastThrottle - throttle;
    if((throttleDrop > 24 || (this.lastAccel > 1.1 && accel < -0.35)) &&
       Math.random() < (Number(ui.crackle.value)/100)*0.8){
      this.crackle(0.7 + rpmN*0.5);
    }

    this.lastAccel = accel;
    this.lastThrottle = throttle;
  }

  shiftBlip(direction=1){
    if(!this.ctx || !this.master || this.isShifting) return;
    this.isShifting = true;

    const t = this.ctx.currentTime;
    const v = Math.max(this.master.gain.value, 0.04);
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(v,t);
    this.master.gain.linearRampToValueAtTime(v*0.28,t+0.035);
    this.master.gain.linearRampToValueAtTime(v*0.72,t+0.095);
    this.master.gain.linearRampToValueAtTime(v,t+0.17);

    if(direction > 0) this.exhaustPop(0.045);
    setTimeout(()=>{ this.isShifting=false; },180);
  }

  exhaustPop(volume=0.05){
    if(!this.ctx) return;
    const t = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(95 + Math.random()*55,t);
    osc.frequency.exponentialRampToValueAtTime(45,t+0.09);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume,t);
    gain.gain.exponentialRampToValueAtTime(0.0001,t+0.11);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 650;

    osc.connect(lp).connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t+0.12);
  }

  crackle(strength=1){
    if(!this.ctx) return;
    const count = 1 + (Math.random() < 0.35 ? 1 : 0);

    for(let n=0;n<count;n++){
      const delay = n*0.055 + Math.random()*0.025;
      const t = this.ctx.currentTime + delay;
      const len = Math.floor(this.ctx.sampleRate*0.055);
      const buffer = this.ctx.createBuffer(1,len,this.ctx.sampleRate);
      const data = buffer.getChannelData(0);

      for(let i=0;i<len;i++){
        const env = Math.exp(-i/(len*0.18));
        data[i] = (Math.random()*2-1)*env;
      }

      const src = this.ctx.createBufferSource();
      src.buffer = buffer;

      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 180 + Math.random()*260;
      bp.Q.value = 0.8;

      const gain = this.ctx.createGain();
      gain.gain.value = 0.035 * strength;

      src.connect(bp).connect(gain).connect(this.master);
      src.start(t);
    }
  }

  stop(){
    if(!this.ctx) return;
    const ctx = this.ctx;
    this.master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
    setTimeout(()=>{
      ctx.close();
      if(this.ctx === ctx) this.ctx = null;
      ui.audioState.textContent = 'Aus';
      ui.audioCtxState.textContent = 'geschlossen';
    },180);
  }

  async testTone(){
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
      gain.gain.exponentialRampToValueAtTime(0.35,t+0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001,t+0.65);

      osc.connect(gain).connect(testCtx.destination);
      osc.start(t);
      osc.stop(t+0.7);

      ui.audioState.textContent = 'TESTTON';
      ui.status.textContent = 'Testton 440→880 Hz';

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

const audio = new V8EngineV2();

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
  ui.status.textContent = 'V8 Performance läuft';
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
    ui.status.textContent=`GPS ±${Math.round(pos.coords.accuracy)} m`;

    updateModel(kmh,accel,inferredThrottle);
  },err=>{
    ui.status.textContent=`GPS Fehler: ${err.message}`;
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
ui.testBtn.addEventListener('click',async()=>{
  await audio.testTone();
});
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
  ui.intensityValue.textContent=`${ui.intensity.value}%`;
});
ui.character.addEventListener('input',()=>{
  ui.characterValue.textContent=`${ui.character.value}%`;
});
ui.crackle.addEventListener('input',()=>{
  ui.crackleValue.textContent=`${ui.crackle.value}%`;
});

document.querySelectorAll('[data-speed]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    filteredSpeed=Number(btn.dataset.speed);
    current.speedKmh=filteredSpeed;
    updateModel(filteredSpeed,0,Number(ui.throttle.value));
  });
});

render();