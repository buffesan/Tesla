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
const redline = 7000;
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

class RealV8EngineV4 {
  constructor(){
    this.ctx = null;
    this.master = null;
    this.shiftGain = null;
    this.toneFilter = null;
    this.lowShelf = null;
    this.layers = [];
    this.manifest = null;
    this.loading = null;
    this.isShifting = false;
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

  async loadAudioBuffer(url){
    const res = await fetch(url + '?v=4', {cache:'no-store'});
    if(!res.ok) throw new Error('Sample fehlt: ' + url + ' (' + res.status + ')');
    const data = await res.arrayBuffer();
    return await this.ctx.decodeAudioData(data.slice(0));
  }

  async buildGraph(){
    const manifestRes = await fetch('assets/loops/loops.json?v=4', {cache:'no-store'});
    if(!manifestRes.ok) throw new Error('V4-Samplebank noch nicht verfügbar (' + manifestRes.status + ')');
    this.manifest = await manifestRes.json();

    this.shiftGain = this.ctx.createGain();
    this.shiftGain.gain.value = 1;

    this.toneFilter = this.ctx.createBiquadFilter();
    this.toneFilter.type = 'lowpass';
    this.toneFilter.frequency.value = 8500;
    this.toneFilter.Q.value = 0.45;

    this.lowShelf = this.ctx.createBiquadFilter();
    this.lowShelf.type = 'lowshelf';
    this.lowShelf.frequency.value = 150;
    this.lowShelf.gain.value = 4;

    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 14;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.12;

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.0001;

    this.shiftGain.connect(this.toneFilter).connect(this.lowShelf).connect(compressor).connect(this.master).connect(this.ctx.destination);

    const decoded = await Promise.all(this.manifest.loops.map(async info => ({
      info,
      buffer: await this.loadAudioBuffer(info.file)
    })));

    this.layers = decoded
      .map(({info,buffer}) => {
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        const gain = this.ctx.createGain();
        gain.gain.value = 0.0001;
        src.connect(gain).connect(this.shiftGain);
        src.start(0, Math.random() * Math.max(0.01, buffer.duration - 0.02));
        return {
          src,
          gain,
          baseRpm: Number(info.detected_rpm || info.target_rpm || 1000),
          name: info.name || 'sample'
        };
      })
      .sort((a,b)=>a.baseRpm-b.baseRpm);

    if(!this.layers.length) throw new Error('Keine V8-Loops geladen');
  }

  async start(){
    forcePlaybackAudioSession();
    if(this.ctx){
      await this.ensureRunning();
      return;
    }
    if(this.loading) return this.loading;

    this.loading = (async()=>{
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({latencyHint:'interactive'});
      await this.ctx.resume();
      ui.audioCtxState.textContent = this.ctx.state;
      ui.status.textContent = 'Lade echte V8-Samples …';
      await this.buildGraph();
      this.master.gain.setTargetAtTime(0.14, this.ctx.currentTime, 0.06);
      ui.audioState.textContent = 'ECHTER V8 · V4';
      ui.status.textContent = 'Echte V8-Samplebank geladen';
    })();

    try{
      await this.loading;
    }catch(e){
      ui.audioState.textContent = 'Fehler';
      ui.status.textContent = e.message;
      try{ if(this.ctx) await this.ctx.close(); }catch(_){}
      this.ctx = null;
      this.layers = [];
      throw e;
    }finally{
      this.loading = null;
    }
  }

  weightsForRpm(rpm){
    const n = this.layers.length;
    const w = new Array(n).fill(0);
    if(!n) return w;
    if(rpm <= this.layers[0].baseRpm){ w[0]=1; return w; }
    if(rpm >= this.layers[n-1].baseRpm){ w[n-1]=1; return w; }

    for(let i=0;i<n-1;i++){
      const a = this.layers[i].baseRpm;
      const b = this.layers[i+1].baseRpm;
      if(rpm >= a && rpm <= b){
        const t0 = Math.log(rpm/a)/Math.log(b/a);
        const t = clamp(t0,0,1);
        const s = t*t*(3-2*t);
        w[i] = Math.sqrt(1-s);
        w[i+1] = Math.sqrt(s);
        return w;
      }
    }
    w[0]=1;
    return w;
  }

  setEngine(rpm, accel, throttle){
    if(!this.ctx || !this.layers.length) return;
    const now = this.ctx.currentTime;
    const throttleN = clamp(throttle/100,0,1);
    const accelLoad = clamp(Math.max(accel,0)/5.5,0,1);
    const load = clamp(throttleN*0.72 + accelLoad*0.42, 0, 1);
    const weights = this.weightsForRpm(Math.max(rpm, idleRpm));

    this.layers.forEach((layer,i)=>{
      const rate = clamp(rpm / Math.max(1, layer.baseRpm), 0.72, 1.38);
      layer.src.playbackRate.setTargetAtTime(rate, now, 0.035);
      const targetGain = Math.max(0.0001, weights[i] * (0.70 + load*0.30));
      layer.gain.gain.setTargetAtTime(targetGain, now, 0.055);
    });

    const intensity = Number(ui.intensity.value)/100;
    const character = Number(ui.character.value)/100;
    const overrun = Number(ui.crackle.value)/100;
    const rpmN = clamp((rpm-idleRpm)/(redline-idleRpm),0,1);
    const offThrottle = throttleN < 0.08 && accel < 0;

    this.master.gain.setTargetAtTime((0.115 + 0.08*load + 0.025*rpmN) * intensity * (offThrottle ? 0.82 + 0.18*overrun : 1), now, 0.055);
    this.toneFilter.frequency.setTargetAtTime(2600 + rpmN*6200 + load*3800 + character*1800 - (offThrottle ? 800*(1-overrun) : 0), now, 0.05);
    this.lowShelf.gain.setTargetAtTime(2.5 + character*5.5, now, 0.08);
  }

  shiftBlip(){
    if(!this.ctx || !this.shiftGain || this.isShifting) return;
    this.isShifting = true;
    const t = this.ctx.currentTime;
    this.shiftGain.gain.cancelScheduledValues(t);
    this.shiftGain.gain.setValueAtTime(1,t);
    this.shiftGain.gain.linearRampToValueAtTime(0.25,t+0.028);
    this.shiftGain.gain.linearRampToValueAtTime(0.72,t+0.085);
    this.shiftGain.gain.linearRampToValueAtTime(1,t+0.15);
    setTimeout(()=>{ this.isShifting=false; },165);
  }

  async testRealSound(){
    await this.start();
    await this.ensureRunning();
    ui.status.textContent = 'Echter V8-Test · ca. 2800 rpm';
    this.setEngine(2800, 1.8, 75);
    setTimeout(()=>{
      if(this.ctx){
        this.setEngine(idleRpm, 0, 10);
        if(!running) ui.status.textContent = 'V4 bereit';
      }
    }, 1800);
  }

  stop(){
    if(!this.ctx) return;
    const ctx = this.ctx;
    if(this.master) this.master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
    setTimeout(()=>{
      ctx.close();
      if(this.ctx === ctx) this.ctx = null;
      this.layers = [];
      ui.audioState.textContent = 'Aus';
      ui.audioCtxState.textContent = 'geschlossen';
    },180);
  }
}

const audio = new RealV8EngineV4();

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
    audio.shiftBlip();
  }

  audio.setEngine(current.rpm,current.accel,current.throttle);
  render();
}

async function startEngine(){
  await audio.start();
  await audio.ensureRunning();
  running = true;
  ui.startBtn.textContent = 'ENGINE RUNNING';
  ui.status.textContent = 'Real V8 V4 läuft';
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
