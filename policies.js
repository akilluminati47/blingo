// policies.js — Copyright (c) 2026 akilluminati47 (AK & Co.). All rights reserved.
// Original work; see LICENSE. https://blingo.pages.dev
//
// The policies overlay: cousin-theme player + terms/privacy/ownership, rolled into the main
// page so it works identically on the web and in the desktop app. Opens from the picker's
// footer link (or a bare #policies hash); the TO THE BLOCK sign closes it.
import * as THREE from './libs/three.module.js';
import { getSong } from './themes.js';

const COUSINS = [
  {id:'blingo', name:'Blingo',  hex:'#ff8c42'},
  {id:'blazo',  name:'Blazo',   hex:'#ff4f42'},
  {id:'blizzy', name:'Blizzy',  hex:'#6fd8ff'},
  {id:'blomba', name:'Blomba',  hex:'#b06fff'},
  {id:'bloopy', name:'Bloopy',  hex:'#3fd8b0'},
  {id:'blondie',name:'Blondie', hex:'#ffd84a'},
];

const screenEl = document.getElementById('policiesscreen');
const gridEl   = document.getElementById('pgrid');
const nowEl    = document.getElementById('pnow');
const barEl    = document.getElementById('pscrub');
let built = false;   // blobs + tiles build lazily on first open (six WebGL contexts)

/* ------------------------------------------------------------------ *
 *  A small 3D blob per badge (same proportions as in-game buildBlob) *
 * ------------------------------------------------------------------ */
function makeBlob(hex){
  const color = parseInt(hex.slice(1),16);
  const g = new THREE.Group();
  const mat = c => new THREE.MeshLambertMaterial({color:c});
  const box = (w,h,d,c)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat(c));return m;};
  const ball= (r,c)=>{const m=new THREE.Mesh(new THREE.SphereGeometry(1,16,12),mat(c));m.scale.setScalar(r);return m;};
  const body = ball(0.55,color); body.scale.set(0.55,0.62,0.5); body.position.y=0.62; g.add(body);
  const head = new THREE.Group(); head.position.y=1.28; g.add(head);
  const skull= ball(0.42,color); skull.scale.set(0.42,0.4,0.4); head.add(skull);
  for(const s of [-1,1]){
    const eye=ball(0.13,0xffffff); eye.position.set(0.16*s,0.05,0.32); head.add(eye);
    const pup=ball(0.055,0x1a1a1a); pup.position.set(0.16*s,0.05,0.415); head.add(pup);
  }
  const mouth=box(0.16,0.05,0.05,0x7a3020); mouth.position.set(0,-0.16,0.36); head.add(mouth);
  const arms=[];
  for(const s of [-1,1]){
    const sh=new THREE.Group(); sh.position.set(0.5*s,0.95,0); g.add(sh);
    const arm=box(0.2,0.4,0.2,color); arm.position.y=-0.26; sh.add(arm);
    const hand=box(0.28,0.26,0.28,0xffd7a8); hand.position.y=-0.56; sh.add(hand);
    const knuck=box(0.3,0.09,0.14,0xf0c898); knuck.position.set(0,-0.52,0.13); sh.add(knuck);
    arms.push(sh);
  }
  for(const s of [-1,1]){
    const hip=new THREE.Group(); hip.position.set(0.2*s,0.42,0); g.add(hip);
    const leg=box(0.2,0.34,0.2,0x3a4a6b); leg.position.y=-0.2; hip.add(leg);
    const foot=box(0.22,0.13,0.34,0x2c2c34); foot.position.set(0,-0.42,0.06); hip.add(foot);
  }
  return {root:g, arms};
}

const blobs = {};
function initBlob(id, hex, canvas){
  const renderer = new THREE.WebGLRenderer({canvas, alpha:true, antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.setSize(112,112,false);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0x8fa3d0, 0x2e2a22, 1.2));
  const key = new THREE.DirectionalLight(0xfff2dd, 0.95); key.position.set(2.5,4,3); scene.add(key);
  const cam = new THREE.PerspectiveCamera(42, 1, 0.1, 50);
  cam.position.set(0, 1.18, 3.95); cam.lookAt(0, 0.92, 0);
  const b = makeBlob(hex); scene.add(b.root);
  blobs[id] = {renderer, scene, cam, root:b.root, arms:b.arms};
  renderIdle(id);
}
function poseBlob(id, out){
  const b = blobs[id]; if(!b) return;
  b.arms[0].rotation.set(out?-1.5:0, 0, out? 0.14:0);
  b.arms[1].rotation.set(out?-1.5:0, 0, out?-0.14:0);
}
function renderIdle(id){
  const b = blobs[id]; if(!b) return;
  poseBlob(id,false); b.root.rotation.y = 0;
  b.renderer.render(b.scene, b.cam);
}

let spinId = null, spinYaw = 0, spinRaf = null, spinLast = 0;
function spinFrame(t){
  const dt = spinLast ? Math.min(0.05,(t-spinLast)/1000) : 0.016; spinLast = t;
  if(spinId && blobs[spinId] && isOpen()){
    spinYaw += dt * 0.45;
    const b = blobs[spinId]; b.root.rotation.y = spinYaw;
    b.renderer.render(b.scene, b.cam);
    spinRaf = requestAnimationFrame(spinFrame);
  } else { spinRaf = null; spinLast = 0; }
}
function setPlayingBlob(id){
  for(const c of COUSINS){
    const on = c.id === id;
    document.querySelector('.ptile[data-id="'+c.id+'"]').classList.toggle('playing', on);
    if(!on) renderIdle(c.id);
  }
  if(id){ poseBlob(id,true); spinYaw = 0; spinId = id; if(!spinRaf) spinRaf = requestAnimationFrame(spinFrame); }
  else { spinId = null; }
}

/* ------------------------------------------------------------------ *
 *  Web Audio synth — the same chip-voices the game reaches for        *
 * ------------------------------------------------------------------ */
const LEAD_WAVE = {80:'square',81:'sawtooth',82:'sine',83:'triangle'};
const midiHz = m => 440 * Math.pow(2, (m-69)/12);

const P = { ctx:null, master:null, noise:null,
            notes:null, dur:0, program:null, idx:0, startAt:0,
            timer:null, raf:null, cousin:null, playing:false, nodes:[], vol:0.8, scrubbing:false };

function ensureCtx(){
  if(P.ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  P.ctx = new AC();
  const comp = P.ctx.createDynamicsCompressor();
  P.master = P.ctx.createGain();
  P.master.gain.value = P.vol * 0.9;
  P.master.connect(comp); comp.connect(P.ctx.destination);
  const n = P.ctx.sampleRate * 1;
  P.noise = P.ctx.createBuffer(1, n, P.ctx.sampleRate);
  const d = P.noise.getChannelData(0);
  for(let i=0;i<n;i++) d[i] = Math.random()*2-1;
}
function noiseSrc(){ const s=P.ctx.createBufferSource(); s.buffer=P.noise; return s; }
function track(node){ P.nodes.push(node); return node; }

function playPitched(n, when){
  const ctx=P.ctx, prog=P.program[n.ch];
  let type='square', gain=0.12, atk=0.005, tail=0.02, kind='';
  if(n.ch===0){ type=LEAD_WAVE[prog]||'square'; gain=0.16; }
  else if(n.ch===1){ type='triangle'; gain=0.24; }
  else if(n.ch===2){ type='sine'; gain=0.045; atk=0.05; kind='pad'; }
  else if(n.ch===3){ type='triangle'; gain=0.08; }
  const o=track(ctx.createOscillator()); o.type=type; o.frequency.value=midiHz(n.note);
  const g=ctx.createGain(); const vol=gain*(n.vel/127);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(vol, when+atk);
  if(kind==='pad') g.gain.setValueAtTime(vol, when+n.d*0.55);
  g.gain.exponentialRampToValueAtTime(0.0001, when+n.d+tail);
  o.connect(g); g.connect(P.master);
  o.start(when); o.stop(when+n.d+tail+0.03);
}
function playDrum(note, when, vel){
  const ctx=P.ctx, v=vel/127;
  const env=(node,peak,dec)=>{const g=ctx.createGain();g.gain.setValueAtTime(peak*v,when);
    g.gain.exponentialRampToValueAtTime(0.0001,when+dec);node.connect(g);g.connect(P.master);return g;};
  if(note===36){
    const o=track(ctx.createOscillator()); o.type='sine';
    o.frequency.setValueAtTime(140,when); o.frequency.exponentialRampToValueAtTime(45,when+0.11);
    env(o,0.9,0.15); o.start(when); o.stop(when+0.17);
  } else if(note===38||note===39){
    const s=track(noiseSrc()); const bp=ctx.createBiquadFilter();
    bp.type='bandpass'; bp.frequency.value=note===38?1800:1300; bp.Q.value=0.8;
    s.connect(bp); env(bp,0.5,note===38?0.15:0.10); s.start(when); s.stop(when+0.18);
    if(note===38){ const o=track(ctx.createOscillator()); o.type='triangle'; o.frequency.value=185;
      env(o,0.18,0.10); o.start(when); o.stop(when+0.12); }
  } else if(note===42||note===46){
    const s=track(noiseSrc()); const hp=ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=7000;
    const dec=note===42?0.03:0.16; s.connect(hp); env(hp,0.22,dec); s.start(when); s.stop(when+dec+0.03);
  } else if(note===49){
    const s=track(noiseSrc()); const hp=ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=5000;
    s.connect(hp); env(hp,0.3,0.6); s.start(when); s.stop(when+0.62);
  }
}
function scheduler(){
  const now=P.ctx.currentTime, elapsed=now-P.startAt;
  while(P.idx<P.notes.length && P.notes[P.idx].t < elapsed+0.15){
    const n=P.notes[P.idx++], when=Math.max(P.startAt+n.t, now);
    if(n.ch===9) playDrum(n.note, when, n.vel); else playPitched(n, when);
  }
  if(elapsed >= P.dur+0.25) stop(true);
}
function frame(){
  if(!P.playing) return;
  if(!P.scrubbing){
    const el=Math.min(P.ctx.currentTime-P.startAt, P.dur), pct=el/P.dur*100;
    document.getElementById('pnowFill').style.width=pct+'%';
    document.getElementById('pnowInfo').textContent=fmt(el)+' / '+fmt(P.dur);
    barEl.setAttribute('aria-valuenow', Math.round(pct));
  }
  P.raf=requestAnimationFrame(frame);
}
const fmt = s => { s=Math.max(0,Math.round(s)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); };

async function play(id){
  ensureCtx();
  if(P.ctx.state==='suspended') await P.ctx.resume();
  const wasSame = P.cousin===id && P.playing;
  if(P.playing) stop(false);
  if(wasSame) return;
  const c = COUSINS.find(x=>x.id===id);
  let song;
  try{ song = getSong(id); }
  catch(e){ document.getElementById('pnowInfo').textContent='could not load '+id+' theme'; return; }
  P.notes=song.notes; P.dur=song.duration; P.program=song.program;
  P.idx=0; P.cousin=id; P.playing=true; P.nodes=[];
  P.startAt=P.ctx.currentTime+0.08;
  P.timer=setInterval(scheduler, 25);
  P.raf=requestAnimationFrame(frame);
  const wave=(LEAD_WAVE[song.program[0]]||'square');
  setNow(id, c.name, wave+' · '+song.bpm+' BPM · '+fmt(song.duration), c.hex);
  nowEl.classList.add('armed');
  barEl.setAttribute('aria-valuenow', 0);
  setPlayingBlob(id);
  renderPips();
}
function stop(ended){
  if(P.timer){ clearInterval(P.timer); P.timer=null; }
  if(P.raf){ cancelAnimationFrame(P.raf); P.raf=null; }
  for(const n of P.nodes){ try{ n.stop(); }catch(e){} }
  P.nodes=[]; P.playing=false;
  setPlayingBlob(null);
  nowEl.classList.remove('playing'); nowEl.classList.add('idle');
  if(ended){ document.getElementById('pnowFill').style.width='100%';
    document.getElementById('pnowInfo').textContent='done · '+fmt(P.dur); }
}
function setNow(id, name, info, hex){
  nowEl.style.setProperty('--c', hex);
  nowEl.classList.remove('idle'); nowEl.classList.add('playing');
  document.getElementById('pnowName').textContent=name;
  document.getElementById('pnowInfo').textContent=info;
  document.getElementById('pnowFill').style.width='0%';
}

/* ---- notch volume, tied under the scrubber ---- */
let volN = 8;
function setVol(n){ volN=n; P.vol=n/10; if(P.master) P.master.gain.value=P.vol*0.9; renderPips(); }
function renderPips(){
  [...document.getElementById('ppips').children].forEach((pip,i)=>pip.classList.toggle('on', i<volN));
}

/* ------------------------------------------------------------------ *
 *  Scrubbing: tap/click or drag-release the head to any spot         *
 * ------------------------------------------------------------------ */
function barFrac(clientX){
  const r=barEl.getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientX-r.left)/r.width));
}
function showScrub(frac){
  const pct=frac*100;
  document.getElementById('pnowFill').style.width=pct+'%';
  if(P.dur) document.getElementById('pnowInfo').textContent=fmt(frac*P.dur)+' / '+fmt(P.dur);
  barEl.setAttribute('aria-valuenow', Math.round(pct));
}
async function seekTo(frac){
  if(!P.notes || !P.dur) return;
  ensureCtx();
  if(P.ctx.state==='suspended') await P.ctx.resume();
  const target=Math.max(0, Math.min(P.dur, frac*P.dur));
  for(const n of P.nodes){ try{ n.stop(); }catch(e){} }
  P.nodes=[];
  P.startAt=P.ctx.currentTime-target+0.03;
  let lo=0, hi=P.notes.length;
  while(lo<hi){ const mid=(lo+hi)>>1; if(P.notes[mid].t<target) lo=mid+1; else hi=mid; }
  P.idx=lo;
  if(!P.playing){
    P.playing=true;
    P.timer=setInterval(scheduler, 25);
    P.raf=requestAnimationFrame(frame);
    nowEl.classList.remove('idle'); nowEl.classList.add('playing');
    setPlayingBlob(P.cousin);
  }
  showScrub(target/P.dur);
}
let scrubFrac=0;
barEl.addEventListener('pointerdown', e=>{
  if(!P.notes || !P.dur) return;
  e.preventDefault();
  P.scrubbing=true; nowEl.classList.add('scrub');
  try{ barEl.setPointerCapture(e.pointerId); }catch(_){}
  scrubFrac=barFrac(e.clientX); showScrub(scrubFrac);
});
barEl.addEventListener('pointermove', e=>{
  if(!P.scrubbing) return;
  scrubFrac=barFrac(e.clientX); showScrub(scrubFrac);
});
function endScrub(e){
  if(!P.scrubbing) return;
  P.scrubbing=false; nowEl.classList.remove('scrub');
  try{ barEl.releasePointerCapture(e.pointerId); }catch(_){}
  seekTo(scrubFrac);
}
barEl.addEventListener('pointerup', endScrub);
barEl.addEventListener('pointercancel', endScrub);

/* ------------------------------------------------------------------ *
 *  Build the badge grid (once, on first open)                        *
 * ------------------------------------------------------------------ */
function build(){
  if(built) return; built = true;
  for(const c of COUSINS){
    const b=document.createElement('button');
    b.className='ptile'; b.dataset.id=c.id; b.style.setProperty('--c', c.hex);
    b.setAttribute('aria-label', c.name+' theme');
    const cv=document.createElement('canvas'); cv.className='pblobcv'; cv.width=112; cv.height=112;
    b.appendChild(cv);
    const nm=document.createElement('div'); nm.className='pnm'; nm.style.color=c.hex; nm.textContent=c.name;
    b.appendChild(nm);
    b.addEventListener('click', ()=>play(c.id));
    gridEl.appendChild(b);
    initBlob(c.id, c.hex, cv);
  }
  const pipBox=document.getElementById('ppips');
  for(let i=0;i<10;i++){ const pip=document.createElement('div'); pip.className='ppip';
    pip.addEventListener('click', ()=>setVol(i+1)); pipBox.appendChild(pip); }
  renderPips();
}

/* ------------------------------------------------------------------ *
 *  Open / close — the TO THE BLOCK sign returns you to the picker    *
 * ------------------------------------------------------------------ */
const isOpen = () => !screenEl.classList.contains('hidden');
function openPolicies(){
  build();
  screenEl.classList.remove('hidden');
  screenEl.scrollTop = 0;
  navIdx = -1;
  if(location.hash !== '#policies') history.replaceState(null, '', '#policies');
}
function closePolicies(){
  if(P.playing) stop(false);
  screenEl.classList.add('hidden');
  navIdx = -1; applyNav();
  if(location.hash === '#policies') history.replaceState(null, '', location.pathname + location.search);
  document.getElementById('policiesopen').blur();
}
document.getElementById('policiesopen').addEventListener('click', e=>{ e.preventDefault(); openPolicies(); });
document.getElementById('ptoblock').addEventListener('click', closePolicies);
addEventListener('hashchange', ()=>{ if(location.hash==='#policies' && !isOpen()) openPolicies(); });

/* ---- keyboard + gamepad navigation (only while the overlay is open) ---- */
function navItems(){ return [...document.querySelectorAll('.ptile'), document.getElementById('ptoblock')]; }
let navIdx = -1;
function applyNav(){
  const items=navItems();
  items.forEach((el,i)=>el.classList.toggle('navfocus', i===navIdx));
  if(navIdx>=0 && items[navIdx]) items[navIdx].focus({preventScroll:false});
}
function move(dir){
  const n=navItems().length;
  navIdx = navIdx<0 ? (dir>0?0:n-1) : (navIdx+dir+n)%n;
  applyNav();
}
addEventListener('keydown', e=>{
  if(!isOpen()) return;
  if(e.key==='Escape'){ e.preventDefault(); closePolicies(); return; }
  if(['ArrowRight','ArrowDown'].includes(e.key)){ e.preventDefault(); move(1); }
  else if(['ArrowLeft','ArrowUp'].includes(e.key)){ e.preventDefault(); move(-1); }
});

let gpPrev={};
function gpPoll(){
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for(const gp of pads){
    if(!gp) continue;
    const pressed=i=>!!(gp.buttons[i] && gp.buttons[i].pressed);
    const ax=gp.axes||[];
    const now={
      a:pressed(0), b:pressed(1),
      up:pressed(12)||ax[1]<-0.55, down:pressed(13)||ax[1]>0.55,
      left:pressed(14)||ax[0]<-0.55, right:pressed(15)||ax[0]>0.55,
    };
    if(isOpen()){
      if(now.right&&!gpPrev.right) move(1);
      if(now.down &&!gpPrev.down)  move(1);
      if(now.left &&!gpPrev.left)  move(-1);
      if(now.up   &&!gpPrev.up)    move(-1);
      if(now.a&&!gpPrev.a){ const el=navItems()[navIdx]; if(el) el.click(); }
      if(now.b&&!gpPrev.b) closePolicies();
    }
    gpPrev=now;
    break;
  }
  requestAnimationFrame(gpPoll);
}
requestAnimationFrame(gpPoll);

// deep link: landing on the page with #policies (e.g. forwarded from the old /policies/
// route) opens the overlay straight away
if(location.hash === '#policies') openPolicies();
