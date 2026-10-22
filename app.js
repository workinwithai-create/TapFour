// TapFour — WorkinWithAI. Tap the rhythm, get the chords: play your chord RHYTHM on any one key (or Space / the pads / a MIDI pad)
// over a real band at YOUR tempo, and every tap becomes YOUR 4 chords, voice-led, on a real piano. Hold length = chord length,
// velocity = velocity, how high you tap = how high the voicing sits. Every loop pass is a new take. Exports WAV + multi-track MIDI.
// Live samples only (FluidR3 + CC0 Virtuosity kit), pinned to commit SHAs.
const APP = "tapfour";
const FLUID_SHA = "044fab8e1456bfafc5776e86dfd6bb8697149aef"; // gleitz/midi-js-soundfonts
const KIT_SHA = "9f04cf9a734527edfbb0a4eee1f674e45bbf71bc";   // sfzinstruments/virtuosity_drums
const FLUID = `https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@${FLUID_SHA}/FluidR3_GM`;
const KIT = `https://cdn.jsdelivr.net/gh/sfzinstruments/virtuosity_drums@${KIT_SHA}/Samples`;
const SR = 48000, LOOKAHEAD_MS = 25, SCHEDULE_AHEAD = 0.12, STEPS = 16, MAX_SHIFT = 4, LOOP_BARS = 4, L = LOOP_BARS*STEPS;
const NAMES = ["C","C#","D","Eb","E","F","F#","G","Ab","A","Bb","B"];
const FLAT = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
const noteName = n => FLAT[n%12] + (Math.floor(n/12)-1);
const CHAIRS = [
  { id:"chords", name:"Your chords (tapped)", ch:1 },
  { id:"bass", name:"Finger bass (FluidR3 Electric Bass finger)", ch:0 },
  { id:"pad",  name:"String pad (FluidR3 String Ensemble 1)", ch:2 },
  { id:"kit",  name:"Backing kit (Virtuosity Drums, CC0)", ch:9 },
];
const SETS = { piano:"Acoustic grand piano (FluidR3)", ep:"Electric piano (FluidR3 Electric Piano 1)", bass:"Finger bass (FluidR3)", pad:"String ensemble (FluidR3)" };
const RANGE = { bass:[28,55], piano:[45,86], ep:[45,86], pad:[52,76] };
const PROGRAM = { bass:"electric_bass_finger", piano:"acoustic_grand_piano", ep:"electric_piano_1", pad:"string_ensemble_1" };
const KITMAP = { 36:"kickmic/kick/kickmic_kick_snoff_vl3_rr1.flac", 38:"mid/snare/mid_snare_center_vl24.flac", 42:"mid/hh/mid_hh_closed_vl3_rr1.flac" };
const KITNAME = { 36:"kick", 38:"snare", 42:"closed hi-hat" };
const LIFTS = ["low","mid","high"];
const recipes = [
  { id:"sixteenths", name:"Snap to 16ths", blurb:"Every tap and every release on the nearest 16th. The default." },
  { id:"eighths", name:"Snap to 8ths", blurb:"Tighter, simpler: starts and lengths on 8th notes." },
  { id:"raw", name:"Your feel", blurb:"No quantize. Your exact timing and lengths." },
  { id:"push", name:"Push the changes", blurb:"16ths, and a tap in the last 8th of a bar plays the NEXT chord (anticipation)." },
];
const grooves = [
  { id:"dusty", name:"Dusty Room", bpm:92, chords:"Am7 Dm7 G Cmaj7" },
  { id:"lofi",  name:"Lo-fi Desk", bpm:76, chords:"Fmaj7 Em7 Dm7 Cmaj7" },
  { id:"bounce",name:"Bounce Back", bpm:100, chords:"Cm Ab Eb Bb" },
];
const QUAL = {"":[0,4,7], m:[0,3,7], min:[0,3,7], "7":[0,4,7,10], m7:[0,3,7,10], maj7:[0,4,7,11], dim:[0,3,6], sus2:[0,2,7], sus4:[0,5,7]};
const ROOT = {C:0,D:2,E:4,F:5,G:7,A:9,B:11};
const pc = x => ((x%12)+12)%12;
const inRange = (n,lo,hi) => { while(n<lo) n+=12; while(n>hi) n-=12; return n; };

// ---------- state (one mutable object, persisted) ----------
const DEFAULT = { bpm:92, keyRoot:9, chords:"Am7 Dm7 G Cmaj7", groove:"dusty", recipe:"sixteenths", bars:8, audioOut:"", chordInst:"piano", legato:true,
  recClick:true, layer:false, pitchLift:true,
  mutes:{chords:false,bass:false,pad:false,kit:false}, gains:{chords:0.75,bass:0.8,pad:0.22,kit:0.7},
  midiIn:"", midiOut:"", midiTransport:false, liveInst:"tap", liveOct:4, liveGain:0.9 };
const state = Object.assign({}, DEFAULT, JSON.parse(localStorage.getItem(APP+"-settings")||"{}"));
state.mutes = Object.assign({}, DEFAULT.mutes, state.mutes); state.gains = Object.assign({}, DEFAULT.gains, state.gains);
if(!recipes.some(r=>r.id===state.recipe)) state.recipe="sixteenths";
const save = () => localStorage.setItem(APP+"-settings", JSON.stringify(state));
function parseChord(s){ const m=/^([A-G])(#|b)?(maj7|min|m7|m|7|dim|sus2|sus4)?$/.exec(s.trim()); if(!m) return null;
  return { root:pc(ROOT[m[1]]+(m[2]==="#"?1:m[2]==="b"?-1:0)), ivs:QUAL[m[3]||""], minor:/^m(?!aj)|^min|^dim/.test(m[3]||""), name:s.trim() }; }
function parseProg(str){ const t=str.trim().split(/[\s,|]+/).filter(Boolean); if(t.length!==4) return null; const c=t.map(parseChord); return c.includes(null)?null:c; }
let prog = parseProg(state.chords) || parseProg(DEFAULT.chords);
const transpose = () => pc(state.keyRoot - prog[0].root);
const keyLabel = () => NAMES[state.keyRoot].replace("#","s") + (prog[0].minor?"m":"");
const chordName = i => NAMES[pc(prog[i].root+transpose())] + prog[i].name.replace(/^[A-G](#|b)?/,"");
function chordAtBar(bar, st, pr){ const c=pr[((bar%4)+4)%4], r=pc(c.root+pc(st.keyRoot-pr[0].root)); return {root:r, ivs:c.ivs, tones:c.ivs.map(iv=>pc(r+iv))}; }

// ---------- voicing: close position, voice-led across the 4 bars; "lift" raises it by inversions (deterministic) ----------
let vlCache={key:null};
function closeVoicings(c){ const out=[]; for(let lo=50;lo<=62;lo++){ if(!c.tones.includes(pc(lo))) continue; const v=[lo]; for(const t of c.tones) if(t!==pc(lo)) v.push(lo+pc(t-lo)); out.push(v.sort((a,b)=>a-b)); } return out; }
function ledVoicings(st, pr){ const key=JSON.stringify([st.keyRoot,pr.map(c=>c.name)]); if(vlCache.key===key) return vlCache.v;
  const v=[]; let prev=null;
  for(let b=0;b<4;b++){ const cand=closeVoicings(chordAtBar(b,st,pr)); let best=cand[0], bs=Infinity;
    for(const x of cand){ const s = prev ? x.reduce((a,n,i)=>a+Math.abs(n-(prev[Math.min(i,prev.length-1)])),0) : Math.abs(x[0]-55); if(s<bs){bs=s;best=x;} }
    v.push(best); prev=best; }
  vlCache={key,v}; return v; }
function voicing(bar, lift, st, pr){ let v=ledVoicings(st,pr)[((bar%4)+4)%4].slice(); for(let k=0;k<lift;k++){ v.push(v.shift()+12); } if(v[v.length-1]>84) v=v.map(n=>n-12); return v; }

// ---------- takes: every loop pass while recording is a NEW take; persisted ----------
const TAKE_CAP=16, TAKE_KEY=APP+"-takes";
const takes=(()=>{ try{ const a=JSON.parse(localStorage.getItem(TAKE_KEY)||"[]"); return Array.isArray(a)?a.filter(t=>t&&Array.isArray(t.hits)):[]; }catch(e){ return []; } })();
let takesVer=1, editIdx=takes.length?takes.length-1:-1;
function saveTakes(){ takesVer++; try{ localStorage.setItem(TAKE_KEY,JSON.stringify(takes)); }catch(e){ setStatus("Could not save takes in this browser (storage full?). Export them now."); } }
const audible = t => t.mode==="loop" && !t.muted && t.hits.length>0;
// typed demo rhythm (NOT tapped) so the desk plays before you record. Replaced by your takes as soon as you have one.
const DEMO = (()=>{ const hits=[]; for(let b=0;b<LOOP_BARS;b++){ const o=b*STEPS; hits.push({pos:o,len:3,vel:0.9,lift:1},{pos:o+3,len:3,vel:0.7,lift:1},{pos:o+8,len:2,vel:0.75,lift:1},{pos:o+10,len:6,vel:0.8,lift:b%2?2:1}); }
  return {n:0,name:"Demo rhythm (typed, not tapped)",mode:"loop",muted:false,hits,demo:true}; })();
// recipe transform: one pure function feeds live, WAV and MIDI (deterministic, no randomness)
function takeHits(tk, st){
  const q = st.recipe==="eighths" ? 2 : st.recipe==="raw" ? 0 : 1, out=new Map();
  for(const h of tk.hits){ let pos=h.pos, len=Math.max(0.25,h.len||1);
    if(q){ const end=Math.round((pos+len)/q)*q; pos=Math.round(pos/q)*q; len=Math.max(q,end-pos); }
    if(pos<0) pos=0; if(pos>=L) continue; len=Math.min(len,L-pos);
    const bar = Math.floor((pos+(st.recipe==="push"?2:0.5))/STEPS);
    const k=Math.round(pos*1000), prev=out.get(k); if(!prev||prev.vel<h.vel) out.set(k,{pos,len,vel:h.vel,lift:h.lift|0,bar}); }
  const arr=[...out.values()].sort((a,b)=>a.pos-b.pos);
  if(st.legato!==false) for(let i=0;i<arr.length-1;i++) arr[i].len=Math.max(0.25,Math.min(arr[i].len, arr[i+1].pos-arr[i].pos));
  return arr; }
const chordSources = (st, rec) => takes.length ? takes.filter(audible) : (rec ? [] : [DEMO]);
let chCache={key:null};
function chordSteps(st, rec, only){ // -> Map(step -> [{note, vel, off, dur}]) for the 4-bar loop
  const key=only?null:JSON.stringify([takesVer,st.recipe,st.legato,st.keyRoot,st.chords,!!rec,takes.length]);
  if(key&&chCache.key===key) return chCache.map;
  const map=new Map(); for(const tk of (only?[only]:chordSources(st,rec))) for(const h of takeHits(tk,st)){ const s=Math.floor(h.pos);
    for(const n of voicing(h.bar,h.lift,st,prog)) (map.get(s)||map.set(s,[]).get(s)).push({note:n,vel:h.vel,off:h.pos-s,dur:h.len}); }
  if(key) chCache={key,map}; return map; }

// ---------- arrangement: one function feeds live, WAV and MIDI (deterministic) ----------
function stepEvents(step, st, pr, opt){
  opt=opt||{}; const out=[], bar=Math.floor(step/STEPS), s=step%STEPS, c=chordAtBar(bar,st,pr), root=c.root;
  const b=inRange(28+pc(root-28),28,39), pv=c.ivs.slice(0,4).map(iv=>inRange(57+pc(root+iv-57),57,70)).sort((x,y)=>x-y);
  if(!st.mutes.bass){ if(s===0) out.push({part:"bass",src:"bass",note:b,dur:6,vel:0.95}); if(s===8) out.push({part:"bass",src:"bass",note:b,dur:4,vel:0.8}); if(s===14) out.push({part:"bass",src:"bass",note:b+12,dur:2,vel:0.6}); }
  if(!st.mutes.pad && s===0) for(const n of pv) out.push({part:"pad",src:"pad",note:n,dur:16,vel:0.5});
  if(!st.mutes.kit){ if(s===0||s===10) out.push({part:"kit",src:"kit",note:36,dur:1,vel:s?0.75:0.95}); if(s===4||s===12) out.push({part:"kit",src:"kit",note:38,dur:1,vel:0.8});
    if(s%2===0) out.push({part:"kit",src:"kit",note:42,dur:1,vel:s%4?0.35:0.5}); }
  if(!st.mutes.chords && !opt.noChords){ const k=chordSteps(st, opt.rec, opt.only).get(step%L); if(k) for(const h of k) out.push({part:"chords",src:st.chordInst,note:h.note,dur:h.dur,vel:h.vel,off:h.off}); }
  return out;
}

// ---------- samples: pinned CDN, raw ArrayBuffers kept for export ----------
const files = [];
for (const id of ["piano","ep","bass","pad"]) for (let n=RANGE[id][0]; n<=RANGE[id][1]; n++) files.push({ id, note:n, url:`${FLUID}/${PROGRAM[id]}-mp3/${noteName(n)}.mp3`, label:SETS[id] });
for (const [n,p] of Object.entries(KITMAP)) files.push({ id:"kit", note:+n, url:`${KIT}/${p}`, label:`Kit ${KITNAME[n]} (Virtuosity Drums)` });
const raw = {}, missing = new Set(); let loaded = 0, loadDone = false;
const loadAll = (async () => {
  let i = 0; const worker = async () => { while (i < files.length) { const f = files[i++];
    try { const r = await fetch(f.url); if (!r.ok) throw new Error(r.status); raw[f.url] = await r.arrayBuffer(); }
    catch (e) { missing.add(f.label + " (" + f.url.split("/").pop() + ")"); }
    loaded++; showLoad(); } };
  await Promise.all(Array.from({length:8}, worker)); loadDone = true; showLoad();
})();
function showLoad(){
  const el = document.getElementById("status"); if(!el) return;
  if (missing.size) { el.className="status miss"; const inst=[...new Set([...missing].map(m=>m.replace(/ \(.*$/,"")))];
    el.textContent = `Missing instruments, playback and export disabled: ${inst.join(", ")} — ${missing.size} file(s) failed, e.g. ${[...missing].slice(0,3).join(", ")}`; }
  else el.textContent = loadDone ? `Piano and band seated ${loaded}/${files.length} · live FluidR3 + CC0 kit` : `Seating piano and band ${loaded}/${files.length}`;
  const ok = loadDone && !missing.size; ["playA","playB","recBtn","recBtn2","exportWav","exportMid","exportStems"].forEach(id=>{ const b=document.getElementById(id); if(b) b.disabled=!ok; });
}
async function decodeAll(c){ // -> {id:{note:{buf,offset}}}; offset skips MP3 encoder padding so notes land on the grid
  const out={};
  await Promise.all(files.map(async f => { const buf = await c.decodeAudioData(raw[f.url].slice(0));
    const d0=buf.getChannelData(0); let pk=0; for(let i=0;i<d0.length;i++){ const a=Math.abs(d0[i]); if(a>pk) pk=a; }
    let on=0; while(on<d0.length && Math.abs(d0[on])<pk*0.01) on++; on=Math.max(0,on-2);
    (out[f.id]=out[f.id]||{})[f.note] = { buf, offset:on/buf.sampleRate }; }));
  return out;
}
function pick(id, note){ if(id==="kit") return note; const [lo,hi]=RANGE[id]; const n=Math.min(hi,Math.max(lo,note)); if(Math.abs(n-note)>MAX_SHIFT) throw new Error(id+" out of range "+note); return n; }

// ---------- sampler voice ----------
const REL = { kit:0.03, bass:0.06, piano:0.15, ep:0.12, pad:0.25 };
const HOLD = id => id==="pad"; // the pad holds with crossfaded retriggers
function voice(c, bufs, dest, ev, t, sd, track){
  const id = ev.src, r = pick(id, ev.note), smp = bufs[id][r], buf = smp.buf, rate = Math.pow(2,(ev.note-r)/12);
  t += (ev.off||0)*sd;
  const end = t + ev.dur*sd, rel = REL[id], g = c.createGain(); g.connect(dest);
  const usable = (buf.duration - smp.offset)/rate - 0.05;
  let off = id==="kit" ? t + Math.min(usable, ev.note===42?0.22:0.7) : end;
  if (!HOLD(id)) off = Math.min(off, t + usable - rel);
  if (id==="kit") g.gain.setValueAtTime(ev.vel, t);
  else { g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(ev.vel, t+(id==="pad"?0.12:0.003)); }
  g.gain.setValueAtTime(ev.vel, off); g.gain.linearRampToValueAtTime(0, off+rel);
  const srcs=[]; const XF=0.25, LOOP_FROM=1.0; let segStart=t, segOff=smp.offset, first=true;
  for(;;){
    const s=c.createBufferSource(); s.buffer=buf; s.playbackRate.value=rate; const sg=c.createGain(); s.connect(sg); sg.connect(g);
    const segEnd = segStart + (buf.duration-segOff)/rate - 0.05;
    if(!first){ sg.gain.setValueAtTime(0,segStart); sg.gain.linearRampToValueAtTime(1,segStart+XF); }
    s.start(segStart, segOff);
    if(HOLD(id) && segEnd < off+rel){ sg.gain.setValueAtTime(1,segEnd-XF); sg.gain.linearRampToValueAtTime(0,segEnd); s.stop(segEnd+0.01); srcs.push(s); segStart=segEnd-XF; segOff=LOOP_FROM; first=false; }
    else { s.stop(off+rel+0.01); srcs.push(s); break; }
  }
  if(track) for(const s of srcs){ active.add(s); s.onended=()=>active.delete(s); }
}
function makeComp(c){ const k=c.createDynamicsCompressor(); k.threshold.value=-8; k.knee.value=6; k.ratio.value=12; k.attack.value=0.003; k.release.value=0.15; return k; }
function buildBus(c, gains){ const comp=makeComp(c), master=c.createGain(); comp.connect(master); master.connect(c.destination); const chairs={};
  for(const ch of CHAIRS){ const g=c.createGain(); g.gain.value=gains[ch.id]; g.connect(comp); chairs[ch.id]=g; } return {comp,master,chairs}; }

// ---------- live engine: lookahead scheduler on the audio clock ----------
let ctx=null, bus=null, liveBufs=null, timerId=null, nextStepTime=0, step=0, playing=false, mode=null;
const active=new Set(), stepLog=[]; window.__schedLog=[];
async function ensureCtx(){
  if(!ctx){ ctx=new (window.AudioContext||window.webkitAudioContext)({sampleRate:SR}); bus=buildBus(ctx,state.gains); applySink(); }
  await ctx.resume(); if(!liveBufs){ await loadAll; if(!missing.size) liveBufs=await decodeAll(ctx); }
}
let passNo=0;
async function start(m){
  if(!ctx||ctx.state!=="running"||!liveBufs||missing.size) return;
  stop(); const mk = m==="band" ? await makeupGain() : 1; bus.master.gain.setValueAtTime(mk, ctx.currentTime); mode=m;
  nextStepTime=ctx.currentTime+0.1; step=0; stepLog.length=0; playing=true; passNo=0;
  timerId=setInterval(scheduler, LOOKAHEAD_MS); scheduler(); requestAnimationFrame(draw); paintDock();
}
function scheduler(){ while(nextStepTime < ctx.currentTime+SCHEDULE_AHEAD){ scheduleStep(step, nextStepTime); nextStepTime += 60/state.bpm/4; step=(step+1)%L; } if(mode==="rec") recTick(); }
function scheduleStep(st, time){
  const sd=60/state.bpm/4, evs = stepEvents(st, state, prog, {noChords:mode==="band", rec:mode==="rec"});
  if(mode==="rec" && state.recClick && st%4===0) evs.push({part:"kit",src:"kit",note:42,dur:1,vel:st%16===0?0.5:0.3,click:true});
  for(const ev of evs){ voice(ctx, liveBufs, bus.chairs[ev.part], ev, time, sd, true); if(!ev.click) midiSend(ev, time, sd); }
  if(st===0){ passNo++; if(mode==="rec") recPasses.push({pass:passNo, time, sd, done:false}); }
  stepLog.push({bar:Math.floor(st/STEPS), s:st%STEPS, st, pass:passNo, time}); if(stepLog.length>256) stepLog.shift();
  window.__schedLog.push({step:st, time, bpm:state.bpm, recipe:state.recipe, keyRoot:state.keyRoot, mode, mutes:Object.assign({},state.mutes), notes:evs.map(e=>e.part+":"+e.note)});
  if(window.__schedLog.length>3000) window.__schedLog.shift();
}
function stop(){
  const wasRec = mode==="rec"; const stopAt = ctx ? ctx.currentTime : 0;
  clearInterval(timerId); timerId=null; playing=false; mode=null;
  for(const s of active){ try{ s.stop(); }catch(e){} } active.clear();
  if(midiOut) for(const c of CHAIRS) midiOut.send([0xB0|c.ch,123,0]);
  document.querySelectorAll(".gbar").forEach(b=>b.classList.remove("active"));
  if(wasRec) finishRec(stopAt);
  paintDock();
}
function draw(){ // playhead from ctx.currentTime
  if(!playing) return; const now=ctx.currentTime; let cur=null;
  for(const e of stepLog){ if(e.time<=now) cur=e; else break; }
  if(cur){ const fr=(cur.s+Math.min(1,(now-cur.time)/(60/state.bpm/4)))/STEPS;
    document.querySelectorAll(".gbar").forEach((el,i)=>{ el.classList.toggle("active",i===cur.bar); if(i===cur.bar) el.querySelector(".ph").style.left=(fr*100)+"%"; }); }
  updateHint(); requestAnimationFrame(draw);
}
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="hidden"){ if(playing){ stop(); setStatus("Stopped (tab hidden). Press play to start again."); } liveAllOff(); } });

// ---------- export ----------
let compLatency=null;
async function measureCompLatency(){
  if(compLatency!==null) return compLatency;
  const oc=new OfflineAudioContext(1,4096,SR), b=oc.createBuffer(1,600,SR), x=b.getChannelData(0); for(let i=0;i<600;i++) x[i]=0.3*Math.sin(2*Math.PI*60*i/SR);
  const s=oc.createBufferSource(); s.buffer=b; const k=makeComp(oc); s.connect(k); k.connect(oc.destination); s.start(0);
  const d=(await oc.startRendering()).getChannelData(0); let best=0,bv=-Infinity;
  for(let Lg=0;Lg<1024;Lg++){ let c=0; for(let i=0;i<600;i++) c+=x[i]*d[i+Lg]; if(c>bv){bv=c;best=Lg;} } return compLatency=best;
}
function merged(o){ const st=Object.assign({},state,o||{}); st.mutes=Object.assign({},state.mutes,(o||{}).mutes); st.gains=Object.assign({},state.gains,(o||{}).gains); return st; }
async function renderLoop(o, noNorm){
  await loadAll; if(missing.size) throw new Error("Missing samples");
  const st=merged(o), N=Math.round(st.bars*4*60/st.bpm*SR), TAIL=Math.round(3*SR), D=await measureCompLatency();
  const pr=st.chords!==state.chords ? (parseProg(st.chords)||prog) : prog, saved=prog; prog=pr; vlCache.key=null;
  try{
    const oc=new OfflineAudioContext(2, D+N+TAIL, SR), bufs=await decodeAll(oc), b=buildBus(oc, st.gains), sd=60/st.bpm/4;
    for(let s=0;s<st.bars*STEPS;s++){ for(const ev of stepEvents(s, st, pr, {only:st.onlyTake})) voice(oc, bufs, b.chairs[ev.part], ev, s*sd, sd, false); }
    const buf=await oc.startRendering();
    const ch=[0,1].map(i=>{ const d=buf.getChannelData(i), x=new Float32Array(N); x.set(d.subarray(D,D+N)); for(let j=0;j<TAIL;j++) x[j%N]+=d[D+N+j]; return x; });
    if(noNorm) return {ch,N,st};
    let pk=0; for(const d of ch) for(let i=0;i<N;i++){ const a=Math.abs(d[i]); if(a>pk) pk=a; }
    let k=pk>0?Math.pow(10,-1.1/20)/pk:1; if(st.stem) k=Math.min(1,k); for(const d of ch) for(let i=0;i<N;i++) d[i]*=k;
    return {ch,N,st};
  } finally { prog=saved; vlCache.key=null; chCache.key=null; }
}
// A (band only) and B (band + your chords) play at matched loudness: makeup gain measured offline on the same 4 bars
let mkCache={key:null,v:1};
async function makeupGain(){ const key=JSON.stringify([takesVer,state.recipe,state.legato,state.gains,state.mutes,state.chords,state.keyRoot,state.bpm,state.chordInst]);
  if(mkCache.key===key) return mkCache.v;
  try{ const rms=r=>{ let s=0; for(const d of r.ch) for(let i=0;i<r.N;i++) s+=d[i]*d[i]; return Math.sqrt(s/(2*r.N)); };
    const a=await renderLoop({bars:4,mutes:{chords:true}},true), b=await renderLoop({bars:4},true);
    const v=rms(a)>1e-6?Math.min(4,Math.max(0.25,rms(b)/rms(a))):1; mkCache={key,v}; window.__makeup={A_rms:rms(a),B_rms:rms(b),gain:v}; return v; }
  catch(e){ return 1; } }
function wav24(ch,N){ const nc=2,len=N*nc*3,b=new ArrayBuffer(44+len),v=new DataView(b); let p=0;
  const str=s=>{for(const c of s) v.setUint8(p++,c.charCodeAt(0));}, u32=x=>{v.setUint32(p,x,true);p+=4}, u16=x=>{v.setUint16(p,x,true);p+=2};
  str("RIFF");u32(36+len);str("WAVE");str("fmt ");u32(16);u16(1);u16(nc);u32(SR);u32(SR*nc*3);u16(nc*3);u16(24);str("data");u32(len);
  for(let i=0;i<N;i++) for(let c=0;c<nc;c++){ let x=Math.round(Math.max(-1,Math.min(1,ch[c][i]))*8388607); if(x<0)x+=16777216; v.setUint8(p++,x&255);v.setUint8(p++,(x>>8)&255);v.setUint8(p++,(x>>16)&255); }
  return new Uint8Array(b); }
function midiFile(st){
  const PPQ=480,T=PPQ/4, total=st.bars*STEPS*T, vlq=n=>{const a=[n&127]; while(n>>=7) a.unshift((n&127)|128); return a;};
  const trk=evs=>{ evs.sort((a,b)=>a.t-b.t||a.o-b.o); let last=0; const d=[]; for(const e of evs){ d.push(...vlq(e.t-last),...e.b); last=e.t; }
    d.push(...vlq(Math.max(0,total-last)),0xFF,0x2F,0); return [0x4D,0x54,0x72,0x6B,(d.length>>>24)&255,(d.length>>16)&255,(d.length>>8)&255,d.length&255,...d]; };
  const name=s=>{const c=[...s].map(x=>x.charCodeAt(0)&127); return [0xFF,0x03,c.length,...c];}, us=Math.round(60000000/st.bpm);
  const tracks=[trk([{t:0,o:0,b:name(APP+" "+keyLabel())},{t:0,o:1,b:[0xFF,0x51,3,(us>>16)&255,(us>>8)&255,us&255]},{t:0,o:2,b:[0xFF,0x58,4,4,2,24,8]}])];
  const add=(evs,ch,note,t0,t1,vel)=>{ const v=Math.max(1,Math.round(vel*110)); evs.push({t:t0,o:2,b:[0x90|ch,note,v]}); evs.push({t:Math.max(t0+1,Math.min(total,t1)),o:1,b:[0x80|ch,note,0]}); };
  for(const c of CHAIRS.filter(c=>c.id!=="chords")){ const evs=[{t:0,o:0,b:name(c.name)}];
    for(let s=0;s<st.bars*STEPS;s++) for(const ev of stepEvents(s,st,prog,{noChords:true})) if(ev.part===c.id) add(evs,c.ch,ev.note,s*T,(s+ev.dur)*T,ev.vel);
    tracks.push(trk(evs)); }
  const chordTrack=(tk,label)=>{ const evs=[{t:0,o:0,b:name(label)}]; if(st.mutes.chords) return trk(evs);
    for(let s=0;s<st.bars*STEPS;s++){ const k=chordSteps(st,false,tk).get(s%L); if(k) for(const h of k){ const t0=Math.round((s+h.off)*T); add(evs,1,h.note,t0,Math.round((s+h.off+h.dur)*T),h.vel); } }
    return trk(evs); };
  if(!takes.length) tracks.push(chordTrack(DEMO,"Chords: demo rhythm (typed, not tapped)"));
  for(const tk of takes) if(tk.hits.length) tracks.push(chordTrack(tk,`Chords: ${tk.name} (${tk.mode==="loop"&&!tk.muted?"loop":tk.muted?"muted":"silent"})`));
  return new Uint8Array([].concat([0x4D,0x54,0x68,0x64,0,0,0,6,0,1,0,tracks.length,PPQ>>8,PPQ&255],...tracks));
}
const fileBase = st => `${APP}-${st.recipe}-${st.bpm}bpm-${keyLabel()}`;
function download(bytes,name,type){ const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([bytes],{type})); a.download=name; document.body.appendChild(a); a.click(); a.remove(); }
async function exportWavBytes(o){ const r=await renderLoop(o); return {bytes:wav24(r.ch,r.N), name:fileBase(r.st)+".wav", frames:r.N}; }
function exportMidBytes(o){ const st=merged(o); return {bytes:midiFile(st), name:fileBase(st)+".mid"}; }
function crc32(b){ let c,crc=-1; for(let i=0;i<b.length;i++){ c=(crc^b[i])&255; for(let k=0;k<8;k++) c=c&1?(c>>>1)^0xEDB88320:c>>>1; crc=(crc>>>8)^c; } return (crc^-1)>>>0; }
function zipStore(fl){ const parts=[], cen=[]; let off=0; const enc=new TextEncoder();
  const le=(n,w)=>{ const a=[]; for(let i=0;i<w;i++) a.push((n>>>(8*i))&255); return a; };
  for(const f of fl){ const nm=enc.encode(f.name), c=crc32(f.bytes), sz=f.bytes.length;
    const h=new Uint8Array([0x50,0x4B,3,4,20,0,0,0,0,0,0,0,0x21,0,...le(c,4),...le(sz,4),...le(sz,4),...le(nm.length,2),0,0,...nm]);
    parts.push(h,f.bytes); cen.push(new Uint8Array([0x50,0x4B,1,2,20,0,20,0,0,0,0,0,0,0,0x21,0,...le(c,4),...le(sz,4),...le(sz,4),...le(nm.length,2),0,0,0,0,0,0,0,0,0,0,0,0,...le(off,4),...nm]));
    off+=h.length+sz; }
  const cl=cen.reduce((a,x)=>a+x.length,0), end=new Uint8Array([0x50,0x4B,5,6,0,0,0,0,...le(fl.length,2),...le(fl.length,2),...le(cl,4),...le(off,4),0,0]);
  const out=new Uint8Array(off+cl+end.length); let p=0; for(const x of [...parts,...cen,end]){ out.set(x,p); p+=x.length; } return out; }
async function exportStemsBytes(o){ const list=takes.filter(t=>t.hits.length); if(!list.length) throw new Error("No takes to export yet");
  const fl=[]; for(const t of list){ const r=await renderLoop(Object.assign({},o,{onlyTake:t,stem:true,mutes:{chords:false,bass:true,pad:true,kit:true}}));
    fl.push({name:`${APP}-take${t.n}-${r.st.bpm}bpm-${keyLabel()}.wav`,bytes:wav24(r.ch,r.N),frames:r.N}); }
  return {files:fl, zip:zipStore(fl), name:`${APP}-takes-${merged(o).bpm}bpm-${keyLabel()}.zip`}; }

// ---------- license gate (Lemon Squeezy License API) ----------
// ONE place to configure checkout. PLACEHOLDERS until Mark creates the Lemon Squeezy product (license keys ON):
// paste checkoutUrl, storeId and productId below. While storeId/productId are null NO key unlocks anything.
const LEMON = { checkoutUrl: "", storeId: null, productId: null, price: "$19 once" };
window.__lemon=LEMON; // test hook (config only, no secrets)
const LS_API="https://api.lemonsqueezy.com/v1/licenses/";
const lic = JSON.parse(localStorage.getItem(APP+"-license")||'{"valid":false}');
const configured = () => !!(LEMON.storeId && LEMON.productId);
async function lsCall(action, params){ const r=await fetch(LS_API+action,{method:"POST",headers:{"Accept":"application/json","Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(params).toString()}); return r.json(); }
const ours = j => !!j && j.meta && +j.meta.store_id===+LEMON.storeId && +j.meta.product_id===+LEMON.productId;
async function activateKey(key){
  if(!configured()) return {ok:false, reason:"Checkout is not live yet. License keys cannot be checked until the store is set up."};
  const j=await lsCall("activate",{license_key:key, instance_name:"TapFour "+(navigator.platform||"web")});
  if(!j.activated) return {ok:false, reason:j.error||"That key could not be activated."};
  if(!ours(j)){ if(j.instance) lsCall("deactivate",{license_key:key, instance_id:j.instance.id}).catch(()=>{}); return {ok:false, reason:"That key is for a different product."}; }
  return {ok:true, instance:j.instance.id}; }
async function validateKey(key, instance){ if(!configured()) return false; const j=await lsCall("validate", instance?{license_key:key, instance_id:instance}:{license_key:key}); return !!j.valid && ours(j); }
function saveLic(){ localStorage.setItem(APP+"-license",JSON.stringify(lic)); }
const licUI = () => { document.getElementById("licOff").hidden=!lic.valid; document.getElementById("licState").textContent = lic.valid ? "Licensed: 8 and 16-bar WAV and take-stem exports unlocked." : `Free demo: tapping, recording, all takes, playback, MIDI export, MIDI I/O, 4-bar WAV and stems. A license (${LEMON.price}) unlocks 8 and 16-bar WAV and stems.`; };
const gated = () => !lic.valid && state.bars>4;

// ---------- Web MIDI ----------
let midiAccess=null, midiOut=null, midiInPort=null;
function midiSend(ev,time,sd){ if(!midiOut||!ctx) return; const c=CHAIRS.find(x=>x.id===ev.part), at=performance.now()+(time+(ev.off||0)*sd-ctx.currentTime)*1000, v=Math.max(1,Math.round(ev.vel*110));
  midiOut.send([0x90|c.ch,ev.note,v],at); midiOut.send([0x80|c.ch,ev.note,0],at+ev.dur*sd*1000-5); }
function onMidi(e){ const d=e.data, s=d[0], cmd=s&0xF0, n=d[1], v=d[2];
  // Transport: ONLY MIDI realtime Start/Continue/Stop, and only if the user opted in. Notes never touch transport.
  if(s===0xFA||s===0xFB){ if(state.midiTransport&&!playing) ensureCtx().then(()=>start("full")); return; }
  if(s===0xFC){ if(state.midiTransport&&playing) stop(); return; }
  if(s>=0xF0) return;
  if(cmd===0xB0&&n===64){ setSustain(v>=64); return; }
  if(cmd===0xB0&&(n===123||n===120)){ liveAllOff(); return; }
  const on=cmd===0x90&&v>0, off=cmd===0x80||(cmd===0x90&&v===0);
  if(on) liveOn(n,v/127,"midi"); else if(off) liveOff(n,"midi"); }
function refreshMidi(){ if(!midiAccess) return;
  const fill=(sel,ports,cur)=>{ sel.innerHTML='<option value="">(none)</option>'+[...ports.values()].map(p=>`<option value="${p.id}">${p.name}</option>`).join(""); sel.value=[...ports.keys()].includes(cur)?cur:""; };
  fill(ui.midiIn,midiAccess.inputs,state.midiIn); fill(ui.midiOut,midiAccess.outputs,state.midiOut);
  if(midiInPort) midiInPort.onmidimessage=null; midiInPort=midiAccess.inputs.get(ui.midiIn.value)||null; if(midiInPort) midiInPort.onmidimessage=onMidi;
  midiOut=midiAccess.outputs.get(ui.midiOut.value)||null; }

// ---------- live play-along ----------
// "tap" mode: ANY key/pad = the current bar's chord (voice-led), how high you play = voicing height, velocity + sustain kept.
// "piano"/"ep"/"bass"/"pad" modes: play real notes. Triggered at ctx.currentTime; never touches the scheduler or transport.
const liveVoices=new Map(); let sustain=false, liveGainNode=null; window.__liveLog=[];
const setStatus=t=>{ const el=document.getElementById("status"); el.className="status"; el.textContent=t; };
function liveDest(){ if(!liveGainNode){ liveGainNode=ctx.createGain(); liveGainNode.gain.value=state.liveGain; liveGainNode.connect(bus.comp); } return liveGainNode; }
const liftFor = (note, src) => src==="midi" ? (state.pitchLift ? (note<60?0:note<72?1:2) : 1) : (note>=0&&note<=2 ? note : 1);
function oneVoice(id, n, vg, t){ const r=pick(id,n), smp=liveBufs[id][r], buf=smp.buf, rate=Math.pow(2,(n-r)/12), g=ctx.createGain(); g.connect(liveDest());
  const s=ctx.createBufferSource(); s.buffer=buf; s.playbackRate.value=rate;
  if(HOLD(id)){ s.loop=true; s.loopStart=Math.min(1.0,buf.duration*0.4); s.loopEnd=buf.duration-0.05; }
  s.connect(g); g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(vg,t+(HOLD(id)?0.04:0.003));
  s.start(t,smp.offset); if(!HOLD(id)) s.stop(t+(buf.duration-smp.offset)/rate); return {s,g}; }
function liveOn(note,vel,src){
  if(!ctx||ctx.state!=="running"||!liveBufs){ setStatus("Tap to start audio first, then play."); return; }
  const key=src+":"+note, t=ctx.currentTime;
  if(liveVoices.has(key)) releaseVoice(liveVoices.get(key),t);
  const vg=Math.max(0.05,Math.pow(vel,1.5)); let vo;
  if(state.liveInst==="tap"){ const lift=liftFor(note,src), p=transportPos(t), b=p?Math.floor(((p.pos+(state.recipe==="push"?2:0.5))%L)/STEPS):0;
    const id=state.chordInst, notes=voicing(b,lift,state,prog); vo={parts:notes.map(n=>oneVoice(id,n,vg*0.55,t)),id,vg,sustained:false,done:false,lift,notes};
    recTapOn(key,vel,lift,t); }
  else { const id=state.liveInst, lo=RANGE[id][0]-MAX_SHIFT, hi=RANGE[id][1]+MAX_SHIFT, n=inRange(note,lo,hi); vo={parts:[oneVoice(id,n,vg,t)],id,vg,sustained:false,done:false,notes:[n]}; }
  let left=vo.parts.length; for(const p of vo.parts) p.s.onended=()=>{ if(--left<=0){ vo.done=true; if(liveVoices.get(key)===vo) liveVoices.delete(key); } };
  liveVoices.set(key,vo); keyVis(note,true,src,vo.lift);
  window.__liveLog.push({ev:"on",note,vel,src,inst:state.liveInst,lift:vo.lift,notes:vo.notes,perf:performance.now(),startAt:t,ctxNow:ctx.currentTime}); if(window.__liveLog.length>500) window.__liveLog.shift();
}
function releaseVoice(vo,t){ if(vo.done) return; vo.done=true; const rel=REL[vo.id]||0.1;
  for(const p of vo.parts){ const g=p.g.gain; g.cancelScheduledValues(t); g.setValueAtTime(g.value,t); g.linearRampToValueAtTime(0,t+rel); try{ p.s.stop(t+rel+0.02); }catch(e){} } }
function liveOff(note,src){ const key=src+":"+note, vo=liveVoices.get(key); keyVis(note,false,src);
  window.__liveLog.push({ev:"off",note,src,perf:performance.now(),ctxNow:ctx?ctx.currentTime:0,sustain});
  if(!vo) return; if(sustain){ vo.sustained=true; return; } liveVoices.delete(key); releaseVoice(vo,ctx.currentTime); recTapOff(key,ctx.currentTime); }
function setSustain(down){ sustain=down; if(!down&&ctx) for(const [k,vo] of liveVoices) if(vo.sustained){ liveVoices.delete(k); releaseVoice(vo,ctx.currentTime); recTapOff(k,ctx.currentTime); } }
function liveAllOff(){ if(!ctx) return; for(const [k,vo] of liveVoices){ releaseVoice(vo,ctx.currentTime); recTapOff(k,ctx.currentTime); } liveVoices.clear(); sustain=false; document.querySelectorAll(".down").forEach(k=>k.classList.remove("down")); }
function transportPos(t){ if(!playing) return null; let cur=null; for(const e of stepLog){ if(e.time<=t) cur=e; else break; } if(!cur) return null; return {pos:cur.st+(t-cur.time)/(60/state.bpm/4), pass:cur.pass}; }

// ---------- the looping recorder: chord taps -> a new take on every loop pass ----------
let recPasses=[], passTaps=new Map(), openTaps=new Map();
function recTapOn(key,vel,lift,t){ if(mode!=="rec") return; const p=transportPos(t); if(!p||p.pass<1) return; let pos=p.pos, pass=p.pass;
  if(pos>=L-0.5){ pos=0; pass++; } // a tap just before the loop wraps belongs to the next pass's downbeat
  const h={pos:+pos.toFixed(4),len:null,vel:+(0.35+0.65*vel).toFixed(3),lift,t0:t,sd:60/state.bpm/4,pass};
  (passTaps.get(pass)||passTaps.set(pass,[]).get(pass)).push(h); openTaps.set(key,h); }
function recTapOff(key,t){ const h=openTaps.get(key); if(!h) return; openTaps.delete(key); h.len=+Math.max(0.25,Math.min(L-h.pos,(t-h.t0)/h.sd)).toFixed(4); }
function finishPass(p){ p.done=true; const hs=passTaps.get(p.pass)||[]; passTaps.delete(p.pass);
  for(const h of hs) if(h.len===null){ h.len=+(L-h.pos).toFixed(4); for(const [k,v] of openTaps) if(v===h) openTaps.delete(k); } // still held at loop end: clip to the loop
  if(hs.length) addTake(hs.map(h=>({pos:h.pos,len:h.len,vel:h.vel,lift:h.lift})),"tapped"); }
function recTick(){ if(!ctx) return; for(const p of recPasses) if(!p.done && ctx.currentTime > p.time + L*p.sd + 0.03) finishPass(p); }
function addTake(hits, src){
  if(takes.length>=TAKE_CAP){ setStatus(`Take limit (${TAKE_CAP}) reached, this pass was not kept. Export or delete takes to record more.`); return null; }
  const n=takes.reduce((m,t)=>Math.max(m,t.n),0)+1;
  if(!state.layer) for(const t of takes) if(t.mode==="loop") t.mode="silent"; // newest take loops; older ones go silent unless Layer is on
  const tk={id:Date.now()+"-"+n,n,name:"Take "+n,mode:"loop",muted:false,src,bpm:state.bpm,hits};
  takes.push(tk); editIdx=takes.length-1; saveTakes(); renderTakes(); paintGrid(); return tk; }
async function startRec(){
  await ensureCtx(); if(!liveBufs) return; stop();
  if(state.liveInst!=="tap"){ state.liveInst="tap"; save(); syncInputs(); renderKeys(); }
  recPasses=[]; passTaps=new Map(); openTaps=new Map();
  bus.master.gain.setValueAtTime(1, ctx.currentTime);
  const bd=4*60/state.bpm, T0=ctx.currentTime+0.15+bd;
  for(let i=0;i<4;i++) voice(ctx, liveBufs, bus.chairs.kit, {src:"kit",note:i?42:38,dur:1,vel:i?0.6:0.85}, T0-bd+i*bd/4, 60/state.bpm/4, true); // count-in
  mode="rec"; nextStepTime=T0; step=0; stepLog.length=0; playing=true; passNo=0; ui.bpm.disabled=true;
  timerId=setInterval(scheduler, LOOKAHEAD_MS); requestAnimationFrame(draw); paintDock();
  setStatus("Recording: one bar count-in, then tap your chord rhythm (Space, J K L, the pads, or any MIDI key). Every 4-bar pass becomes a new take. Press Stop when done.");
}
function finishRec(stopAt){
  for(const [k] of [...openTaps]) recTapOff(k,stopAt);
  for(const p of recPasses) if(!p.done && stopAt>p.time) finishPass(p);
  recPasses=[]; ui.bpm.disabled=false; setStatus(takes.length?`${takes.length} take${takes.length>1?"s":""} saved. Press B to hear your chords with the band.`:"No taps recorded. Press ● Record and tap after the count-in.");
}

// ---------- audio output device (AudioContext.setSinkId where supported) ----------
const sinkOK = () => typeof (window.AudioContext||function(){}).prototype.setSinkId === "function";
async function listOutputs(){ const sel=document.getElementById("audioOut"), note=document.getElementById("audioOutNote");
  if(!sinkOK()){ sel.innerHTML='<option value="">System default</option>'; sel.disabled=true; note.textContent="This browser can't route Web Audio to a chosen device (no AudioContext.setSinkId). Sound goes to your system output; change it in your OS sound settings."; return; }
  let devs=[]; try{ devs=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==="audiooutput"&&d.deviceId&&d.deviceId!=="default"); }catch(e){}
  sel.innerHTML='<option value="">System default</option>'+devs.map((d,i)=>`<option value="${d.deviceId}">${d.label||"Audio output "+(i+1)}</option>`).join("");
  sel.value=devs.some(d=>d.deviceId===state.audioOut)?state.audioOut:""; if(sel.value!==state.audioOut&&state.audioOut) note.textContent="Saved output is not connected; using system default.";
  else if(devs.length && !devs[0].label) note.textContent="Device names are hidden until the browser grants media permission; outputs are numbered."; }
async function applySink(){ if(!ctx||!sinkOK()) return; const note=document.getElementById("audioOutNote");
  try{ const want=state.audioOut||""; if((typeof ctx.sinkId==="string"?ctx.sinkId:"")!==want) await ctx.setSinkId(want); note.textContent = state.audioOut ? "Playing through the selected output." : "Playing through the system default output."; }
  catch(e){ note.textContent="Could not switch output ("+e.name+"); staying on the system default."; state.audioOut=""; save(); document.getElementById("audioOut").value=""; } }
if(navigator.mediaDevices&&navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange",listOutputs);

// ---------- UI ----------
const ui={}; ["audioOut","audioOutNote","bpm","key","chords","chordErr","bars","recClick","layer","legato","pitchLift","chordInst",
  "midiIn","midiOut","midiNote","midiTransport","liveInst","liveGainIn","licKey","licBtn","tap","tapBtn","takes","takeInfo","grid","gridTitle","pads","miniKeys","liveHint","liveOctLbl"].forEach(id=>ui[id]=document.getElementById(id));
ui.key.innerHTML=NAMES.map((n,i)=>`<option value="${i}">${n}</option>`).join("");
function syncInputs(){ ui.bpm.value=state.bpm; ui.key.value=state.keyRoot; ui.chords.value=state.chords; ui.bars.value=state.bars;
  ui.recClick.checked=state.recClick; ui.layer.checked=state.layer; ui.legato.checked=state.legato; ui.pitchLift.checked=state.pitchLift; ui.chordInst.value=state.chordInst;
  ui.midiTransport.checked=state.midiTransport; ui.liveInst.value=state.liveInst; ui.liveGainIn.value=state.liveGain; }
function onChords(){ const p=parseProg(ui.chords.value); if(!p){ ui.chordErr.textContent="Exactly 4 chords, e.g. Am7 Dm7 G Cmaj7 (m, 7, m7, maj7, dim, sus2, sus4)"; return; }
  ui.chordErr.textContent=""; const t=transpose(); prog=p; state.chords=ui.chords.value.trim(); state.keyRoot=pc(p[0].root+t); ui.key.value=state.keyRoot; save(); render(); }
function cards(id, list, on, label, click){ const el=document.getElementById(id); el.innerHTML="";
  list.forEach(x=>{ const b=document.createElement("button"); b.className="card"+(on(x)?" on":""); b.dataset.id=x.id; b.innerHTML=label(x); b.onclick=()=>click(x); el.appendChild(b); }); }
function paintGrooves(){ cards("grooves",grooves,g=>state.groove===g.id,g=>`<b>${g.name}</b><span>${g.bpm} BPM · ${g.chords}</span>`,
  g=>{ if(mode==="rec") return; state.groove=g.id; state.bpm=g.bpm; state.chords=g.chords; prog=parseProg(g.chords); state.keyRoot=prog[0].root; save(); syncInputs(); render(); }); }
function paintRecipes(){ cards("recipes",recipes,r=>state.recipe===r.id,r=>`<b>${r.name}</b><span>${r.blurb}</span>`,r=>{ state.recipe=r.id; save(); render(); }); }
function paintChairs(){ const el=document.getElementById("chairs"); el.innerHTML="";
  CHAIRS.forEach(c=>{ const d=document.createElement("div"); d.className="chair"+(state.mutes[c.id]?" muted":"");
    const nm = c.id==="chords" ? `Your chords · ${SETS[state.chordInst]}` : c.name;
    d.innerHTML=`<label><input type="checkbox" data-mute="${c.id}" ${state.mutes[c.id]?"checked":""}/> Mute</label><div>${nm}</div><input type="range" min="0" max="1" step="0.01" data-gain="${c.id}" value="${state.gains[c.id]}" aria-label="${c.name} level"/>`; el.appendChild(d); }); }
function editTake(){ return editIdx>=0&&editIdx<takes.length ? takes[editIdx] : (takes.length?null:DEMO); }
function paintGrid(){ const tk=editTake(), el=ui.grid; if(!el) return;
  const st=Object.assign({},state,{recipe:state.recipe==="raw"?"sixteenths":state.recipe}), hs=tk?takeHits(tk,st):[];
  const on=new Map(), hold=new Map(); for(const h of hs){ const p=Math.round(h.pos); on.set(LIFTS[h.lift]+":"+p,1); for(let q=p+1;q<Math.round(h.pos+h.len);q++) hold.set(LIFTS[h.lift]+":"+q,1); }
  ui.gridTitle.textContent = tk ? (tk.demo ? "Demo rhythm (typed, not tapped). Record a take to replace it." : `Editing ${tk.name} · ${tk.hits.length} taps · tap a cell to add or remove a chord hit`) : "Pick a take to edit.";
  let h=""; for(let b=0;b<LOOP_BARS;b++){ h+=`<div class="gbar"><div class="ph"></div><div class="gh"><span>bar ${b+1}</span><b>${chordName(b)}</b></div>`;
    for(const c of ["high","mid","low"]){ h+=`<div class="gr"><i>${c}</i>`; for(let s=0;s<STEPS;s++){ const p=b*STEPS+s, k=c+":"+p; h+=`<button class="cell ${c}${on.has(k)?" on":hold.has(k)?" hold":""}${s%4===0?" beat":""}" data-c="${c}" data-p="${p}" aria-label="${c} chord bar ${b+1} step ${s+1}"${tk&&tk.demo?" disabled":""}></button>`; } h+="</div>"; }
    h+="</div>"; }
  el.innerHTML=h; }
ui.grid.addEventListener("click",e=>{ const c=e.target.closest(".cell"); if(!c) return; const tk=editTake(); if(!tk||tk.demo) return; const lift=LIFTS.indexOf(c.dataset.c), p=+c.dataset.p;
  const i=tk.hits.findIndex(h=>Math.round(h.pos)===p&&(h.lift|0)===lift);
  if(i>=0) tk.hits.splice(i,1); else tk.hits.push({pos:p,len:2,vel:0.8,lift,man:true}); saveTakes(); renderTakes(); paintGrid(); });
function renderTakes(){
  ui.takeInfo.textContent=takes.length?`${takes.length} take${takes.length>1?"s":""} saved (max ${TAKE_CAP}). B and the WAV play takes set to Loop and not muted; MIDI lists every take on its own track.`:"No takes yet. Press ● Record and tap after the count-in: each 4-bar pass becomes a new take.";
  ui.takes.innerHTML=takes.map((t,i)=>`<div class="take${audible(t)?" aud":""}${i===editIdx?" sel":""}" data-i="${i}">
   <input class="tname" value="${t.name.replace(/"/g,"&quot;")}" data-act="name" aria-label="Take name">
   <small>${t.hits.length} chord taps · ${t.src}</small>
   <select data-act="mode" aria-label="Loop or silent"><option value="loop"${t.mode==="loop"?" selected":""}>Loop</option><option value="silent"${t.mode==="silent"?" selected":""}>Silent</option></select>
   <label class="chk"><span><input type="checkbox" data-act="mute"${t.muted?" checked":""}> Mute</span></label>
   <button data-act="edit">Edit</button><button data-act="del">Delete</button></div>`).join(""); }
ui.takes.addEventListener("change",e=>{ const row=e.target.closest(".take"); if(!row) return; const t=takes[+row.dataset.i], a=e.target.dataset.act;
  if(a==="mode") t.mode=e.target.value; if(a==="mute") t.muted=e.target.checked; if(a==="name") t.name=e.target.value.trim()||("Take "+t.n); saveTakes(); renderTakes(); });
ui.takes.addEventListener("click",e=>{ const a=e.target.dataset.act; if(a!=="del"&&a!=="edit") return; const i=+e.target.closest(".take").dataset.i, t=takes[i];
  if(a==="edit"){ editIdx=i; renderTakes(); paintGrid(); return; }
  if(!confirm(`Delete ${t.name}? This can't be undone.`)) return; takes.splice(i,1); if(editIdx>=takes.length) editIdx=takes.length-1; saveTakes(); renderTakes(); paintGrid(); });
function paintDock(){ for(const b of [document.getElementById("recBtn"),document.getElementById("recBtn2")]) if(b){ b.textContent = mode==="rec" ? "■ Stop recording" : "● Record"; b.classList.toggle("recording",mode==="rec"); } }
// tap pads (low / mid / high) + mini keys
const PADKEYS=["j","k","l"];
ui.pads.innerHTML=LIFTS.map((c,i)=>`<button class="pad ${i===1?"tapbig":""}" data-n="${i}" data-pad="${c}">Tap ${c}<i>${PADKEYS[i].toUpperCase()}${i===1?" · Space":""}</i></button>`).join("");
const KEYMAP="awsedftgyhujk"; const kbBase=()=>12*(state.liveOct+1);
function renderKeys(){ const base=kbBase();
  ui.miniKeys.innerHTML=[...Array(13)].map((_,i)=>{ const n=base+i, blk=[1,3,6,8,10].includes(i%12);
    return `<button class="mk ${blk?"blk":"wht"}" data-n="${n}" aria-label="${NAMES[n%12]}${Math.floor(n/12)-1}"><span>${NAMES[n%12]}</span><i>${KEYMAP[i].toUpperCase()}</i></button>`; }).join("");
  ui.liveOctLbl.textContent="C"+state.liveOct; document.querySelector(".kbrow").hidden = state.liveInst==="tap"; updateHint(true); }
function keyVis(n,on,src,lift){ const k = (src==="pad"||src==="key") ? document.querySelector(`.pad[data-n="${n}"]`) : state.liveInst==="tap" ? document.querySelector(`.pad[data-n="${lift==null?1:lift}"]`) : document.querySelector(`.mk[data-n="${n}"]`);
  if(k) k.classList.toggle("down",on); if(!on&&state.liveInst==="tap") document.querySelectorAll(".pad.down").forEach(x=>{ if(![...liveVoices.values()].length) x.classList.remove("down"); }); }
let hintKey="";
function curBar(){ if(!playing||!ctx) return 0; const now=ctx.currentTime; let cur=null; for(const e of stepLog){ if(e.time<=now) cur=e; else break; } return cur?cur.bar:0; }
function updateHint(force){ const b=curBar(), k=state.liveInst+b+state.keyRoot+state.chords; if(k===hintKey&&!force) return; hintKey=k;
  if(state.liveInst==="tap"){ ui.liveHint.innerHTML=`Tap mode: any key plays <b>${chordName(b%4)}</b> (the current bar's chord), voice-led. MIDI keys below middle C = low voicing, C4–B4 = mid, C5 and up = high. Hold = chord length.`; return; }
  const c=chordAtBar(b,state,prog); ui.liveHint.innerHTML=`Key <b>${NAMES[state.keyRoot]} ${prog[0].minor?"minor":"major"}</b> · now <b>${chordName(b%4)}</b>: chord tones <b>${c.tones.map(t=>NAMES[t]).join(" ")}</b>`;
  document.querySelectorAll(".mk").forEach(el=>{ const p=pc(+el.dataset.n); el.classList.toggle("tone",c.tones.includes(p)); el.classList.toggle("root",p===c.tones[0]); }); }
function pointerKeys(box, sel){ const down=new Map();
  box.addEventListener("pointerdown",e=>{ const k=e.target.closest(sel); if(!k) return; e.preventDefault(); const n=+k.dataset.n, src=sel===".pad"?"pad":"tap";
    if(sel===".pad"&&state.liveInst!=="tap"){ state.liveInst="tap"; save(); syncInputs(); renderKeys(); }
    down.set(e.pointerId,n); liveOn(n,0.85,src); });
  const up=e=>{ if(!down.has(e.pointerId)) return; liveOff(down.get(e.pointerId),sel===".pad"?"pad":"tap"); down.delete(e.pointerId); };
  box.addEventListener("pointerup",up); box.addEventListener("pointercancel",up); box.addEventListener("pointerleave",up); box.addEventListener("contextmenu",e=>e.preventDefault()); }
pointerKeys(ui.pads,".pad"); pointerKeys(ui.miniKeys,".mk");
document.addEventListener("keydown",e=>{ if(e.repeat||e.metaKey||e.ctrlKey||e.altKey) return; const tg=e.target.tagName; if(tg==="INPUT"||tg==="SELECT"||tg==="TEXTAREA") return;
  const k=e.key.toLowerCase();
  if(state.liveInst==="tap"){ const pi=k===" "?1:PADKEYS.indexOf(k); if(pi>=0){ e.preventDefault(); liveOn(pi,0.85,"key"); } return; }
  if(k==="z"||k==="x"){ state.liveOct=Math.max(1,Math.min(6,state.liveOct+(k==="z"?-1:1))); save(); renderKeys(); return; }
  const i=KEYMAP.indexOf(k); if(i>=0){ e.preventDefault(); liveOn(kbBase()+i,0.8,"kb"); } });
document.addEventListener("keyup",e=>{ const k=e.key.toLowerCase();
  if(state.liveInst==="tap"){ const pi=k===" "?1:PADKEYS.indexOf(k); if(pi>=0) liveOff(pi,"key"); return; }
  const i=KEYMAP.indexOf(k); if(i>=0) liveOff(kbBase()+i,"kb"); });
window.addEventListener("blur",()=>{ for(const [k] of [...liveVoices]) if(/^(kb|tap|key|pad):/.test(k)) liveOff(+k.split(":")[1],k.split(":")[0]); });

function render(){ updateHint(true); paintGrooves(); paintRecipes(); paintChairs(); paintGrid(); renderTakes(); }
ui.bpm.addEventListener("change",()=>{ const v=Math.round(+ui.bpm.value); if(!(v>=60&&v<=180)||mode==="rec"){ ui.bpm.value=state.bpm; return; } state.bpm=v; save(); render(); });
ui.key.addEventListener("change",()=>{ state.keyRoot=+ui.key.value; save(); render(); });
ui.chords.addEventListener("change",onChords);
ui.bars.addEventListener("change",()=>{ state.bars=+ui.bars.value; save(); });
ui.recClick.addEventListener("change",()=>{ state.recClick=ui.recClick.checked; save(); });
ui.layer.addEventListener("change",()=>{ state.layer=ui.layer.checked; save(); });
ui.legato.addEventListener("change",()=>{ state.legato=ui.legato.checked; save(); render(); });
ui.pitchLift.addEventListener("change",()=>{ state.pitchLift=ui.pitchLift.checked; save(); });
ui.chordInst.addEventListener("change",()=>{ state.chordInst=ui.chordInst.value; save(); render(); });
ui.midiTransport.addEventListener("change",()=>{ state.midiTransport=ui.midiTransport.checked; save(); });
ui.liveInst.addEventListener("change",()=>{ liveAllOff(); state.liveInst=ui.liveInst.value; save(); renderKeys(); });
ui.liveGainIn.addEventListener("input",()=>{ state.liveGain=+ui.liveGainIn.value; if(liveGainNode) liveGainNode.gain.setTargetAtTime(state.liveGain,ctx.currentTime,0.01); save(); });
document.getElementById("liveOctDn").addEventListener("click",()=>{ state.liveOct=Math.max(1,state.liveOct-1); save(); renderKeys(); });
document.getElementById("liveOctUp").addEventListener("click",()=>{ state.liveOct=Math.min(6,state.liveOct+1); save(); renderKeys(); });
ui.midiIn.addEventListener("change",()=>{ state.midiIn=ui.midiIn.value; save(); refreshMidi(); });
ui.midiOut.addEventListener("change",()=>{ state.midiOut=ui.midiOut.value; save(); refreshMidi(); });
document.getElementById("audioOut").addEventListener("change",e=>{ state.audioOut=e.target.value; save(); applySink(); });
document.getElementById("chairs").addEventListener("input",e=>{ const m=e.target.dataset.mute, g=e.target.dataset.gain;
  if(m){ state.mutes[m]=e.target.checked; e.target.closest(".chair").classList.toggle("muted",e.target.checked); }
  if(g){ state.gains[g]=+e.target.value; if(bus) bus.chairs[g].gain.setTargetAtTime(state.gains[g],ctx.currentTime,0.01); }
  save(); });
document.getElementById("clearTakes").addEventListener("click",()=>{ if(!takes.length||!confirm(`Clear all ${takes.length} takes? This can't be undone.`)) return; takes.length=0; editIdx=-1; saveTakes(); renderTakes(); paintGrid(); });
const go = m => async () => { await ensureCtx(); start(m); };
document.getElementById("playA").onclick=go("band");
document.getElementById("playB").onclick=go("full");
document.getElementById("stop").onclick=stop;
const recClick = ()=>{ if(mode==="rec"){ stop(); return; } startRec(); };
document.getElementById("recBtn").onclick=recClick; document.getElementById("recBtn2").onclick=recClick;
document.getElementById("exportWav").onclick=async()=>{ if(gated()){ setStatus("Demo: 4-bar WAV export. Unlock below for 8/16 bars."); return; }
  setStatus("Rendering…"); try{ const r=await exportWavBytes(); download(r.bytes,r.name,"audio/wav"); setStatus("Saved "+r.name); }catch(e){ setStatus("Export failed: "+e.message); } };
document.getElementById("exportMid").onclick=()=>{ const r=exportMidBytes(); download(r.bytes,r.name,"audio/midi"); setStatus("Saved "+r.name); };
document.getElementById("exportStems").addEventListener("click",async()=>{ if(gated()){ setStatus("Demo: 4-bar take stems. Unlock below for 8/16 bars."); return; }
  setStatus("Rendering take stems…"); try{ const r=await exportStemsBytes(); download(r.zip,r.name,"application/zip"); setStatus(`Saved ${r.name} (${r.files.length} take WAVs)`); }catch(e){ setStatus("Stems export failed: "+e.message); } });
ui.tapBtn.onclick=async()=>{ ui.tapBtn.textContent="Starting…"; await ensureCtx(); if(ctx.state==="running") ui.tap.classList.add("hide"); showLoad(); };
ui.licBtn.onclick=async()=>{ const k=ui.licKey.value.trim(); if(!k) return; const st=document.getElementById("licState"); st.textContent="Checking…";
  try{ const r=await activateKey(k); if(r.ok){ Object.assign(lic,{valid:true,key:k,instance:r.instance,checked:Date.now()}); saveLic(); licUI(); } else st.textContent=r.reason; }
  catch(e){ st.textContent="Could not reach Lemon Squeezy. Check your connection and try again."; } };
document.getElementById("licOff").onclick=async()=>{ if(lic.key&&lic.instance&&configured()) await lsCall("deactivate",{license_key:lic.key,instance_id:lic.instance}).catch(()=>{}); for(const k of Object.keys(lic)) delete lic[k]; lic.valid=false; saveLic(); licUI(); };
{ const buy=document.getElementById("buy"); if(LEMON.checkoutUrl){ buy.href=LEMON.checkoutUrl; buy.textContent="Buy TapFour · "+LEMON.price; } else { buy.removeAttribute("href"); buy.setAttribute("aria-disabled","true"); buy.textContent="Checkout opening soon · "+LEMON.price; } }
if(lic.valid&&lic.key) validateKey(lic.key,lic.instance).then(v=>{ lic.valid=v; lic.checked=Date.now(); saveLic(); licUI(); }).catch(()=>{});
if(/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1)) document.querySelectorAll(".ios").forEach(e=>e.hidden=false);
window.__tapfour = { state, stepEvents, takeHits, voicing, addTake, exportWavBytes, exportMidBytes, exportStemsBytes, loadAll, start:m=>start(m), stop, startRec, files, takes, DEMO,
  liveOn, liveOff, setSustain, voices:liveVoices, tpos:()=>ctx&&transportPos(ctx.currentTime), get sustain(){return sustain;}, get playing(){return playing;}, get mode(){return mode;}, get ctx(){return ctx;}, get missing(){return [...missing];}, get lic(){return lic;} };
syncInputs(); renderKeys(); render(); licUI(); showLoad(); paintDock(); listOutputs();
if(navigator.requestMIDIAccess) navigator.requestMIDIAccess().then(a=>{ midiAccess=a; a.onstatechange=refreshMidi; refreshMidi(); }).catch(()=>{ ui.midiNote.textContent="Web MIDI unavailable or blocked in this browser."; });
else ui.midiNote.textContent="Web MIDI not supported in this browser (try Chrome/Edge). The pads, Space / J K L and on-screen keys still play.";
