const $ = (id) => document.getElementById(id);

const ui = {
  speed: $('speed'), rpm: $('rpm'), rpmBar: $('rpmBar'), gear: $('gear'),
  gpsBadge: $('gpsBadge'), status: $('status'), accel: $('accel'), audioState: $('audioState'),
  startBtn: $('startBtn'), gpsBtn: $('gpsBtn'), demoBtn: $('demoBtn'), stopBtn: $('stopBtn'),
  intensity: $('intensity'), intensityValue: $('intensityValue'),
  crackle: $('crackle'), crackleValue: $('crackleValue'),
  demoPanel: $('demoPanel'), throttle: $('throttle')
};

let audio = null;
let watchId = null;
let demo = false;
let running = false;
let lastGps = null;
let current = { speedKmh: 0, accel: 0, rpm: 850, gear: 0, throttle: 0 };
let simTimer = null;

const gearRatios = [0, 3.20, 2.10, 1.52, 1.18, 0.96, 0.80];
const finalDrive = 3.15;
const wheelCircumferenceM = 2.25;
const idleRpm = 850;
const redline = 6500;

function clamp(v,min,max){ return Math.max(min, Math.min(max,v)); }

function calcGear(speedKmh, accel){
  if(speedKmh < 2) return 0;
  const shift = accel > 1.5 ? [0,28,58,92,132,178] : [0,22,48,80,118,160];
  let g = 1;
  for(let i=1;i<shift.length;i++) if(speedKmh >= shift[i]) g = i+1;
  return clamp(g,1,6);
}

function calcRpm(speedKmh, gear, accel){
  if(gear === 0) return idleRpm + clamp(accel*80,0,250);
  const speedMps = speedKmh / 3.6;
  const wheelRpm = (speedMps / wheelCircumferenceM) * 60;
  let rpm = wheelRpm * gearRatios[gear] * finalDrive;
  rpm += clamp(accel,0,6) * 180;
  return clamp(rpm, idleRpm, redline);
}

function updateModel(speedKmh, accel, throttle = null){
  current.speedKmh = Math.max(0, speedKmh);
  current.accel = accel || 0;
  if(throttle !== null) current.throttle = throttle;
  const prevGear = current.gear;
  current.gear = calcGear(current.speedKmh, current.accel);
  current.rpm = calcRpm(current.speedKmh, current.gear, current.accel);
  if(prevGear && current.gear !== prevGear) audio?.shiftBlip();
  audio?.setEngine(current.rpm, current.accel, current.throttle);
  render();
}

function render(){
  ui.speed.textContent = Math.round(current.speedKmh);
  ui.rpm.textContent = Math.round(current.rpm);
  ui.rpmBar.style.width = `${clamp((current.rpm/redline)*100, 4, 100)}%`;
  ui.gear.textContent = current.gear === 0 ? 'N' : current.gear;
  ui.accel.textContent = `${current.accel.toFixed(2)} m/s²`;
}

class V8Engine {
  constructor(){
    this.ctx = null; this.master = null; this.filter = null; this.oscs = []; this.noise = null;
    this.lastAccel = 0;
  }
  async start(){
    if(this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    await this.ctx.resume();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.0001;
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 1600;
    this.filter.Q.value = 0.7;

    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -18; compressor.knee.value = 12; compressor.ratio.value = 4;
    compressor.attack.value = 0.005; compressor.release.value = 0.15;

    this.filter.connect(compressor).connect(this.master).connect(this.ctx.destination);

    const partials = [1, 2, 3, 4.02];
    partials.forEach((mul,i)=>{
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = i < 2 ? 'sawtooth' : 'square';
      g.gain.value = [0.38,0.18,0.09,0.045][i];
      o.connect(g).connect(this.filter);
      o.start();
      this.oscs.push({o,g,mul});
    });

    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for(let i=0;i<data.length;i++) data[i] = (Math.random()*2-1) * 0.45;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer; src.loop = true;
    const ng = this.ctx.createGain(); ng.gain.value = 0.025;
    src.connect(ng).connect(this.filter); src.start();
    this.noise = {src,ng};

    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(0.16, now, 0.08);
    ui.audioState.textContent = 'An';
  }
  setEngine(rpm, accel, throttle){
    if(!this.ctx) return;
    const now = this.ctx.currentTime;
    const baseHz = Math.max(28, rpm/60 * 4);
    this.oscs.forEach(p=> p.o.frequency.setTargetAtTime(baseHz*p.mul, now, 0.025));
    const intensity = Number(ui.intensity.value)/100;
    const load = clamp((throttle/100) * 0.75 + Math.max(accel,0)/6 * 0.5, 0, 1.2);
    const gain = (0.045 + load*0.11) * intensity;
    this.master.gain.setTargetAtTime(gain, now, 0.04);
    this.filter.frequency.setTargetAtTime(650 + (rpm/redline)*2200 + load*900, now, 0.04);
    this.noise.ng.gain.setTargetAtTime(0.01 + load*0.035, now, 0.05);

    if(this.lastAccel > 0.8 && accel < -0.5 && Math.random() < (Number(ui.crackle.value)/100)*0.65){
      this.crackle();
    }
    this.lastAccel = accel;
  }
  shiftBlip(){
    if(!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const v = this.master.gain.value;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(v,t);
    this.master.gain.linearRampToValueAtTime(v*0.45,t+0.045);
    this.master.gain.linearRampToValueAtTime(v,t+0.13);
  }
  crackle(){
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square'; osc.frequency.value = 70 + Math.random()*110;
    g.gain.setValueAtTime(0.08,t);
    g.gain.exponentialRampToValueAtTime(0.001,t+0.07);
    osc.connect(g).connect(this.ctx.destination); osc.start(t); osc.stop(t+0.08);
  }
  stop(){
    if(!this.ctx) return;
    this.master.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.06);
    setTimeout(()=>{ this.ctx?.close(); this.ctx = null; ui.audioState.textContent='Aus'; },180);
  }
}

audio = new V8Engine();

async function startEngine(){
  await audio.start();
  running = true;
  ui.status.textContent = 'Motor läuft';
}

function startGps(){
  if(!navigator.geolocation){ ui.status.textContent='Geolocation nicht unterstützt'; return; }
  if(watchId !== null) return;
  lastGps = null;
  watchId = navigator.geolocation.watchPosition(pos=>{
    const ts = pos.timestamp;
    let speed = Number.isFinite(pos.coords.speed) ? pos.coords.speed : null;
    if(speed === null && lastGps){
      const R=6371000, toRad=d=>d*Math.PI/180;
      const dLat=toRad(pos.coords.latitude-lastGps.lat), dLon=toRad(pos.coords.longitude-lastGps.lon);
      const a=Math.sin(dLat/2)**2+Math.cos(toRad(lastGps.lat))*Math.cos(toRad(pos.coords.latitude))*Math.sin(dLon/2)**2;
      const d=2*R*Math.asin(Math.sqrt(a));
      const dt=(ts-lastGps.ts)/1000;
      if(dt>0.2) speed=d/dt;
    }
    if(speed === null) speed = current.speedKmh/3.6;
    const kmh = Math.max(0, speed*3.6);
    let accel = 0;
    if(lastGps){
      const dt=(ts-lastGps.ts)/1000;
      if(dt>0.15) accel=((kmh-lastGps.kmh)/3.6)/dt;
    }
    lastGps={lat:pos.coords.latitude,lon:pos.coords.longitude,ts,kmh};
    demo=false; ui.demoPanel.classList.add('hidden');
    ui.gpsBadge.textContent='GPS LIVE'; ui.gpsBadge.classList.add('live');
    ui.status.textContent=`GPS ±${Math.round(pos.coords.accuracy)} m`;
    updateModel(kmh, clamp(accel,-6,8), clamp(accel*18,0,100));
  },err=>{
    ui.status.textContent=`GPS Fehler: ${err.message}`;
    ui.gpsBadge.textContent='GPS FEHLER'; ui.gpsBadge.classList.remove('live');
  },{enableHighAccuracy:true,maximumAge:250,timeout:10000});
}

function stopGps(){ if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null;} ui.gpsBadge.textContent='GPS AUS'; ui.gpsBadge.classList.remove('live'); }

function startDemo(){
  demo = true; stopGps(); ui.demoPanel.classList.remove('hidden'); ui.status.textContent='Demo aktiv';
  if(simTimer) clearInterval(simTimer);
  simTimer = setInterval(()=>{
    const targetThrottle = Number(ui.throttle.value)/100;
    const drag = 0.006*current.speedKmh;
    const accel = targetThrottle*5.2 - drag - (targetThrottle < 0.03 ? 0.9 : 0);
    const next = Math.max(0,current.speedKmh + accel*3.6*0.1);
    updateModel(next, accel, targetThrottle*100);
  },100);
}

function stopAll(){
  running=false; stopGps(); demo=false; if(simTimer){clearInterval(simTimer);simTimer=null;}
  ui.demoPanel.classList.add('hidden'); audio.stop(); current={speedKmh:0,accel:0,rpm:idleRpm,gear:0,throttle:0}; render(); ui.status.textContent='Gestoppt';
}

ui.startBtn.addEventListener('click',startEngine);
ui.gpsBtn.addEventListener('click',async()=>{ if(!running) await startEngine(); startGps(); });
ui.demoBtn.addEventListener('click',async()=>{ if(!running) await startEngine(); startDemo(); });
ui.stopBtn.addEventListener('click',stopAll);
ui.intensity.addEventListener('input',()=>ui.intensityValue.textContent=`${ui.intensity.value}%`);
ui.crackle.addEventListener('input',()=>ui.crackleValue.textContent=`${ui.crackle.value}%`);

document.querySelectorAll('[data-speed]').forEach(btn=>btn.addEventListener('click',()=>{
  current.speedKmh = Number(btn.dataset.speed); updateModel(current.speedKmh,0,Number(ui.throttle.value));
}));

render();