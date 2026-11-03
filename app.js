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
  speed: $('speed'),
  rpm: $('rpm'),
  rpmBar: $('rpmBar'),
  gear: $('gear'),
  gpsBadge: $('gpsBadge'),
  status: $('status'),
  accel: $('accel'),
  audioState: $('audioState'),
  audioCtxState: $('audioCtxState'),
  startBtn: $('startBtn'),
  testBtn: $('testBtn'),
  gpsBtn: $('gpsBtn'),
  demoBtn: $('demoBtn'),
  stopBtn: $('stopBtn'),
  intensity: $('intensity'),
  intensityValue: $('intensityValue'),
  character: $('character'),
  characterValue: $('characterValue'),
  crackle: $('crackle'),
  crackleValue: $('crackleValue'),
  demoPanel: $('demoPanel'),
  throttle: $('throttle')
};

const clamp = (v,min,max) => Math.max(min, Math.min(max,v));
const lerp = (a,b,t) => a + (b-a)*t;

const idleRpm = 900;
const redline = 6500;
const gearRatios = [0, 3.15, 2.08, 1.50, 1.17, 0.94, 0.78];
const finalDrive = 3.10;
const wheelCircumferenceM = 2.25;

let watchId = null;
let simTimer = null;
let lastGps = null;
let filteredSpeed = 0;
let filteredAccel = 0;
let running = false;
let current = {speedKmh:0, accel:0, rpm:idleRpm, gear:0, throttle:0};

function chooseGear(speedKmh, accel, previousGear){
  if(speedKmh < 2) return 0;

  const hard = accel > 1.5;
  const up = hard ? [0,34,69,108,151,205] : [0,29,61,96,137,187];
  const down = [0,20,44,72,108,150];

  let gear = clamp(previousGear || 1,1,6);
  while(gear < 6 && speedKmh >= up[gear]) gear++;
  while(gear > 1 && speedKmh < down[gear-1]) gear--;
  return gear;
}

function calculateRpm(speedKmh, gear, accel){
  if(gear === 0){
    return idleRpm + clamp(Math.max(accel,0)*70,0,250);
  }

  const speedMps = speedKmh / 3.6;
  const wheelRpm = (speedMps / wheelCircumferenceM) * 60;
  const rpm = wheelRpm * gearRatios[gear] * finalDrive + clamp(accel,0,6)*210;
  return clamp(rpm,idleRpm,redline);
}

function render(){
  ui.speed.textContent = Math.round(current.speedKmh);
  ui.rpm.textContent = Math.round(current.rpm);
  ui.rpmBar.style.width = clamp((current.rpm/redline)*100,4,100) + '%';
  ui.gear.textContent = current.gear === 0 ? 'N' : current.gear;
  ui.accel.textContent = current.accel.toFixed(2) + ' m/s²';
}

class StationaryLoopEngineV5 {
  constructor(){
    this.ctx = null;
    this.master = null;
    this.shiftGain = null;
    this.lowShelf = null;
    this.toneFilter = null;
    this.layers = [];
    this.loading = null;
    this.isShifting = false;
    this.testTimers = [];
    this.anchors = [900,1800,2800,3800,5000,6500];
    this.urls = [
      'assets/v5/engine_0.wav',
      'assets/v5/engine_1.wav',
      'assets/v5/engine_2.wav',
      'assets/v5/engine_3.wav',
      'assets/v5/engine_4.wav',
      'assets/v5/engine_5.wav'
    ];
  }

  async ensureRunning(){
    if(!this.ctx) return false;
    forcePlaybackAudioSession();
    if(this.ctx.state !== 'running'){
      await this.ctx.resume();
    }
    ui.audioCtxState.textContent = this.ctx.state;
    return this.ctx.state === 'running';
  }

  async loadBuffer(url){
    const res = await fetch(url + '?v=5', {cache:'no-store'});
    if(!res.ok) throw new Error('Sounddatei fehlt: ' + url + ' (' + res.status + ')');
    const bytes = await res.arrayBuffer();
    return await this.ctx.decodeAudioData(bytes.slice(0));
  }

  async build(){
    this.shiftGain = this.ctx.createGain();
    this.shiftGain.gain.value = 1;

    this.toneFilter = this.ctx.createBiquadFilter();
    this.toneFilter.type = 'lowpass';
    this.toneFilter.frequency.value = 9000;
    this.toneFilter.Q.value = 0.45;

    this.lowShelf = this.ctx.createBiquadFilter();
    this.lowShelf.type = 'lowshelf';
    this.lowShelf.frequency.value = 150;
    this.lowShelf.gain.value = 4;

    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 18;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.14;

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.0001;

    this.shiftGain
      .connect(this.toneFilter)
      .connect(this.lowShelf)
      .connect(compressor)
      .connect(this.master)
      .connect(this.ctx.destination);

    ui.status.textContent = 'Lade 6 stationäre Motorloops …';
    const buffers = await Promise.all(this.urls.map(u => this.loadBuffer(u)));

    this.layers = buffers.map((buffer,i)=>{
      const src = this.ctx.createBufferSource();
      const gain = this.ctx.createGain();

      src.buffer = buffer;
      src.loop = true;
      src.playbackRate.value = 1;
      gain.gain.value = 0.0001;

      src.connect(gain).connect(this.shiftGain);

      // Different phase offsets reduce comb filtering while crossfading.
      const offset = (i * 0.137) % Math.max(0.01,buffer.duration);
      src.start(0,offset);

      return {
        src,
        gain,
        anchorRpm:this.anchors[i]
      };
    });

    this.setEngine(idleRpm,0,8);
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

      await this.build();
      await this.ensureRunning();

      this.master.gain.setTargetAtTime(0.62,this.ctx.currentTime,0.05);
      ui.audioState.textContent = 'REAL LOOPS · V5';
      ui.status.textContent = 'V5 Motorbank bereit';
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
    const w = new Array(this.anchors.length).fill(0);
    if(rpm <= this.anchors[0]){
      w[0] = 1;
      return w;
    }
    if(rpm >= this.anchors[this.anchors.length-1]){
      w[w.length-1] = 1;
      return w;
    }

    for(let i=0;i<this.anchors.length-1;i++){
      const a = this.anchors[i];
      const b = this.anchors[i+1];
      if(rpm >= a && rpm <= b){
        const t = clamp((rpm-a)/(b-a),0,1);
        // Equal-power crossfade.
        w[i] = Math.cos(t*Math.PI/2);
        w[i+1] = Math.sin(t*Math.PI/2);
        return w;
      }
    }

    w[0] = 1;
    return w;
  }

  setEngine(rpm,accel,throttle){
    if(!this.ctx || !this.layers.length) return;

    const now = this.ctx.currentTime;
    const throttleN = clamp(throttle/100,0,1);
    const accelLoad = clamp(Math.max(accel,0)/5.5,0,1);
    const load = clamp(throttleN*0.7 + accelLoad*0.45,0,1);
    const weights = this.weightsForRpm(clamp(rpm,idleRpm,redline));

    const intensity = Number(ui.intensity.value)/100;
    const character = Number(ui.character.value)/100;
    const dynamics = Number(ui.crackle.value)/100;
    const rpmN = clamp((rpm-idleRpm)/(redline-idleRpm),0,1);

    this.layers.forEach((layer,i)=>{
      const anchor = layer.anchorRpm;

      // Keep pitch correction deliberately small. Most RPM change comes
      // from crossfading to the next genuine stationary loop.
      const rawRate = rpm / anchor;
      const rate = clamp(rawRate,0.90,1.12);
      layer.src.playbackRate.setTargetAtTime(rate,now,0.055);

      const loadGain = 0.36 + load*(0.25 + dynamics*0.18);
      const target = Math.max(0.0001,weights[i]*loadGain);
      layer.gain.gain.setTargetAtTime(target,now,0.065);
    });

    this.master.gain.setTargetAtTime(
      (0.52 + load*0.20) * intensity,
      now,
      0.07
    );

    this.toneFilter.frequency.setTargetAtTime(
      4200 + rpmN*5200 + load*2500 + character*1300,
      now,
      0.07
    );

    this.lowShelf.gain.setTargetAtTime(
      2 + character*7,
      now,
      0.09
    );
  }

  shiftBlip(){
    if(!this.ctx || !this.shiftGain || this.isShifting) return;

    this.isShifting = true;
    const t = this.ctx.currentTime;
    this.shiftGain.gain.cancelScheduledValues(t);
    this.shiftGain.gain.setValueAtTime(1,t);
    this.shiftGain.gain.linearRampToValueAtTime(0.32,t+0.035);
    this.shiftGain.gain.linearRampToValueAtTime(0.72,t+0.095);
    this.shiftGain.gain.linearRampToValueAtTime(1,t+0.17);

    setTimeout(()=>{ this.isShifting=false; },180);
  }

  clearTestTimers(){
    this.testTimers.forEach(clearTimeout);
    this.testTimers = [];
  }

  async testSequence(){
    await this.start();
    await this.ensureRunning();
    this.clearTestTimers();

    const stage = (delay,rpm,throttle,label)=>{
      this.testTimers.push(setTimeout(()=>{
        ui.status.textContent = label;
        this.setEngine(rpm,1.2,throttle);
        current.rpm = rpm;
        render();
      },delay));
    };

    stage(0,900,8,'Test: Leerlauf 900 rpm');
    stage(1300,2200,35,'Test: 2.200 rpm');
    stage(2800,3800,65,'Test: 3.800 rpm');
    stage(4400,5600,90,'Test: 5.600 rpm');

    this.testTimers.push(setTimeout(()=>{
      this.setEngine(idleRpm,0,8);
      current.rpm = idleRpm;
      render();
      ui.status.textContent = 'V5 Test beendet';
    },6100));
  }

  stop(){
    this.clearTestTimers();
    if(!this.ctx) return;

    const ctx = this.ctx;
    if(this.master){
      this.master.gain.setTargetAtTime(0.0001,ctx.currentTime,0.045);
    }

    setTimeout(()=>{
      ctx.close();
      if(this.ctx === ctx) this.ctx = null;
      this.layers = [];
      ui.audioState.textContent = 'Aus';
      ui.audioCtxState.textContent = 'geschlossen';
    },180);
  }
}

const audio = new StationaryLoopEngineV5();

function updateModel(speedKmh,accel,throttle=null){
  filteredSpeed = lerp(filteredSpeed,Math.max(0,speedKmh),0.34);
  filteredAccel = lerp(filteredAccel,accel || 0,0.26);

  current.speedKmh = filteredSpeed;
  current.accel = filteredAccel;

  if(throttle !== null){
    current.throttle = lerp(current.throttle,throttle,0.35);
  }

  const previousGear = current.gear;
  current.gear = chooseGear(current.speedKmh,current.accel,previousGear);

  const targetRpm = calculateRpm(current.speedKmh,current.gear,current.accel);
  current.rpm = lerp(current.rpm,targetRpm,0.34);

  if(previousGear && current.gear !== previousGear){
    audio.shiftBlip();
  }

  audio.setEngine(current.rpm,current.accel,current.throttle);
  render();
}

async function startEngine(){
  try{
    await audio.start();
    await audio.ensureRunning();
    running = true;
    ui.startBtn.textContent = 'ENGINE RUNNING';
    ui.status.textContent = 'V5 läuft';
  }catch(e){
    ui.status.textContent = 'Audio-Fehler: ' + e.message;
  }
}

function startGps(){
  if(!navigator.geolocation){
    ui.status.textContent = 'Geolocation nicht unterstützt';
    return;
  }

  if(watchId !== null) return;

  lastGps = null;

  watchId = navigator.geolocation.watchPosition(pos=>{
    const ts = pos.timestamp;
    let speedMps = Number.isFinite(pos.coords.speed) ? pos.coords.speed : null;

    if(speedMps === null && lastGps){
      const R = 6371000;
      const toRad = d => d*Math.PI/180;
      const dLat = toRad(pos.coords.latitude-lastGps.lat);
      const dLon = toRad(pos.coords.longitude-lastGps.lon);
      const a =
        Math.sin(dLat/2)**2 +
        Math.cos(toRad(lastGps.lat)) *
        Math.cos(toRad(pos.coords.latitude)) *
        Math.sin(dLon/2)**2;
      const distance = 2*R*Math.asin(Math.sqrt(a));
      const dt = (ts-lastGps.ts)/1000;
      if(dt > 0.2) speedMps = distance/dt;
    }

    if(speedMps === null){
      speedMps = current.speedKmh/3.6;
    }

    const kmh = Math.max(0,speedMps*3.6);
    let accel = 0;

    if(lastGps){
      const dt = (ts-lastGps.ts)/1000;
      if(dt > 0.15){
        accel = ((kmh-lastGps.kmh)/3.6)/dt;
      }
    }

    accel = clamp(accel,-5,7);
    const inferredThrottle = clamp(
      accel*22 + Math.max(0,kmh-current.speedKmh)*3,
      0,
      100
    );

    lastGps = {
      lat:pos.coords.latitude,
      lon:pos.coords.longitude,
      ts,
      kmh
    };

    ui.demoPanel.classList.add('hidden');
    ui.gpsBadge.textContent = 'GPS LIVE';
    ui.gpsBadge.classList.add('live');
    ui.status.textContent = 'GPS ±' + Math.round(pos.coords.accuracy) + ' m';

    updateModel(kmh,accel,inferredThrottle);
  },err=>{
    ui.status.textContent = 'GPS Fehler: ' + err.message;
    ui.gpsBadge.textContent = 'GPS FEHLER';
    ui.gpsBadge.classList.remove('live');
  },{
    enableHighAccuracy:true,
    maximumAge:100,
    timeout:10000
  });
}

function stopGps(){
  if(watchId !== null){
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  ui.gpsBadge.textContent = 'GPS AUS';
  ui.gpsBadge.classList.remove('live');
}

function startDemo(){
  stopGps();
  ui.demoPanel.classList.remove('hidden');
  ui.status.textContent = 'Demo aktiv';

  if(simTimer) clearInterval(simTimer);

  simTimer = setInterval(()=>{
    const throttle = Number(ui.throttle.value)/100;
    const aeroDrag = 0.0045*current.speedKmh;
    const rolling = 0.12;
    const decel = throttle < 0.02 ? 1.15 : rolling;
    const accel = throttle*6.0-aeroDrag-decel;
    const next = Math.max(0,current.speedKmh+accel*3.6*0.1);
    updateModel(next,accel,throttle*100);
  },100);
}

function stopAll(){
  running = false;
  stopGps();

  if(simTimer){
    clearInterval(simTimer);
    simTimer = null;
  }

  ui.demoPanel.classList.add('hidden');
  audio.stop();

  filteredSpeed = 0;
  filteredAccel = 0;
  current = {speedKmh:0,accel:0,rpm:idleRpm,gear:0,throttle:0};
  render();

  ui.status.textContent = 'Gestoppt';
  ui.startBtn.textContent = 'START ENGINE';
}

ui.startBtn.addEventListener('click',startEngine);

ui.testBtn.addEventListener('click',async()=>{
  try{
    await audio.testSequence();
  }catch(e){
    ui.status.textContent = 'Testfehler: ' + e.message;
  }
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
  ui.intensityValue.textContent = ui.intensity.value + '%';
});

ui.character.addEventListener('input',()=>{
  ui.characterValue.textContent = ui.character.value + '%';
});

ui.crackle.addEventListener('input',()=>{
  ui.crackleValue.textContent = ui.crackle.value + '%';
});

document.querySelectorAll('[data-speed]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    filteredSpeed = Number(btn.dataset.speed);
    current.speedKmh = filteredSpeed;
    updateModel(filteredSpeed,0,Number(ui.throttle.value));
  });
});

render();
