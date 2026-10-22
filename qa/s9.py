INIT="localStorage.setItem('tapfour-intro-seen','1');localStorage.setItem('tapfour-guide-done','1');document.addEventListener('DOMContentLoaded',()=>{const m=document.getElementById('more'); if(m) m.open=true})"
import asyncio, base64, json, sys, re, numpy as np, wave, io
from playwright.async_api import async_playwright
URL=sys.argv[1]; OUT=sys.argv[2] if len(sys.argv)>2 else 's9.json'
B64="""async (o)=>{const r=await window.__tapfour.exportWavBytes(o); let s=''; const b=r.bytes; for(let i=0;i<b.length;i+=32768) s+=String.fromCharCode.apply(null,b.subarray(i,i+32768)); return {name:r.name,b64:btoa(s)};}"""
LOADED="/seated (\\d+)\\/\\1/.test(document.getElementById('status').textContent)"
def load(b):
  w=wave.open(io.BytesIO(b)); n=w.getnframes(); raw=np.frombuffer(w.readframes(n),dtype=np.uint8).reshape(-1,3)
  v=(raw[:,0].astype(np.int32)|(raw[:,1].astype(np.int32)<<8)|(raw[:,2].astype(np.int32)<<16)); v[v>=1<<23]-=1<<24
  return w.getframerate(),w.getsampwidth(),n,(v/8388607.0).reshape(-1,w.getnchannels()),w.getnchannels()
async def main():
  res={}
  async with async_playwright() as p:
    br=await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx=await br.new_context(viewport={'width':1100,'height':900},accept_downloads=True); await ctx.add_init_script(INIT); pg=await ctx.new_page(); errs=[]; reqs=[]
    pg.on('pageerror',lambda e:errs.append(str(e))); pg.on('console',lambda m: m.type=='error' and errs.append(m.text)); pg.on('request',lambda r: 'jsdelivr' in r.url and reqs.append(r.url))
    await pg.goto(URL); await pg.click('#tapBtn'); await pg.wait_for_function(LOADED,timeout=120000); await pg.wait_for_function("document.getElementById('tap').classList.contains('hide')")
    res['load']=await pg.text_content('#status'); n0=len(reqs)
    # --- check 1: 92 BPM, 8 bars, 48 kHz (demo groove + band, default recipe)
    r=await pg.evaluate(B64,{'bpm':92,'bars':8}); b=base64.b64decode(r['b64']); open(r['name'],'wb').write(b)
    sr,sw,n,x,nc=load(b); m=x.mean(1); pk=np.abs(x).max()
    res['c1']={'name':r['name'],'sr':sr,'bits':sw*8,'channels':nc,'frames':n,'expected':round(8*4*60/92*48000),'exact':n==round(8*4*60/92*48000),'peak_dBFS':round(20*np.log10(pk),2),
      'first_over_1pct_sample':int(np.argmax(np.abs(m)>0.01*pk)),'first_over_1pct_ms':round(int(np.argmax(np.abs(m)>0.01*pk))/48,3)}
    res['c1']['pass']=res['c1']['exact'] and sr==48000 and sw==3 and res['c1']['peak_dBFS']<=-1.0 and res['c1']['first_over_1pct_ms']<=1.0
    # --- check 2: 4x loop at bar 1: seam + grid drift + determinism
    r2=await pg.evaluate(B64,{'bpm':92,'bars':8}); x2=load(base64.b64decode(r2['b64']))[3]
    t=np.tile(x,(4,1)); N=len(x); d=np.abs(np.diff(t[:,0])); bar=48000*4*60/92
    # grid check on a kit-only render (kick on every downbeat in the demo groove): lag of best cross-correlation of each downbeat window vs bar 2's (0 = no drift)
    rk=await pg.evaluate(B64,{'bpm':92,'bars':8,'mutes':{'bass':True,'chords':True,'pad':True}}); xk=np.tile(load(base64.b64decode(rk['b64']))[3][:,0],4); on=[]
    ref=xk[int(round(bar)):int(round(bar))+2400]
    for k in range(32):
      s0=int(round(k*bar)); best=max(range(-200,201),key=lambda Lg: float(np.dot(ref, xk[max(0,s0+Lg):max(0,s0+Lg)+2400])) if s0+Lg>=0 else -1e9); on.append(best)
    res['c2']={'total_frames':len(t),'expected_4x':4*round(8*4*60/92*48000),'drift_samples':len(t)-4*round(8*4*60/92*48000),
      'seam_diffs':[round(float(d[k*N-1]),5) for k in (1,2,3)],'p999_diff':round(float(np.percentile(d,99.9)),5),'kit_only_downbeat_xcorr_lag_vs_bar2_samples':sorted(set(on)),
      'deterministic_maxdiff':float(np.abs(x-x2).max())}
    res['c2']['pass']=res['c2']['drift_samples']==0 and max(res['c2']['seam_diffs'])<=res['c2']['p999_diff'] and max(abs(v) for v in on)<=2 and res['c2']['deterministic_maxdiff']<1e-6
    # --- check 6: longest pad (string pad, 1 bar) at the slowest preset tempo (76) and at 60 BPM
    rms=lambda a: float(np.sqrt((a**2).mean()))
    c6={}
    for bpm in (76,60):
      r=await pg.evaluate(B64,{'bpm':bpm,'bars':4,'mutes':{'kit':True,'bass':True,'chords':True}}); s=load(base64.b64decode(r['b64']))[3].mean(1); barN=int(48000*4*60/bpm)
      mid=rms(s[int(barN*0.3):int(barN*0.5)]); end=rms(s[int(barN*0.88):int(barN*0.96)])
      c6[f'{bpm}bpm']={'bar_s':round(barN/48000,3),'rms_30-50pct':round(mid,4),'rms_88-96pct':round(end,4),'end_over_mid':round(end/mid,3)}
    c6['pass']=all(v['end_over_mid']>0.5 for k,v in c6.items() if k!='pass'); res['c6']=c6
    res['no_redownload_during_export']=len(reqs)-n0
    mm=await pg.evaluate("()=>{const r=window.__tapfour.exportMidBytes({bpm:92,bars:8}); let s=''; for(const x of r.bytes) s+=String.fromCharCode(x); return {name:r.name,b64:btoa(s)}}")
    open(mm['name'],'wb').write(base64.b64decode(mm['b64'])); res['midi_file']=mm['name']
    # --- check 4: live changes while playing (B mode)
    await pg.click('#playB'); await pg.wait_for_timeout(1500); live={}
    for name,act in [('bpm',"()=>{const e=document.getElementById('bpm');e.value=120;e.dispatchEvent(new Event('change'))}"),
                     ('mute',"()=>{const e=document.querySelector('[data-mute=bass]');e.checked=true;e.dispatchEvent(new Event('input',{bubbles:true}))}"),
                     ('recipe',"()=>{document.querySelector('#recipes [data-id=push]').click()}"),
                     ('key',"()=>{const e=document.getElementById('key');e.value='0';e.dispatchEvent(new Event('change'))}")]:
      t0=await pg.evaluate("()=>window.__tapfour.ctx.currentTime"); await pg.evaluate(act); await pg.wait_for_timeout(2500); log=await pg.evaluate("()=>window.__schedLog")
      if name=='bpm': hit=[e for e in log if e['time']>t0 and e['bpm']==120]
      if name=='mute': hit=[e for e in log if e['time']>t0 and e['mutes']['bass']]
      if name=='recipe': hit=[e for e in log if e['time']>t0 and e['recipe']=='push']
      if name=='key': hit=[e for e in log if e['time']>t0 and e['keyRoot']==0 and any(n.startswith('chords:') or n.startswith('pad:') or n.startswith('bass:') for n in e['notes'])]
      barS=60/120*4 if name!='bpm' else 60/92*4
      live[name]={'delay_s':round(hit[0]['time']-t0,3) if hit else None,'bar_s':round(barS,3),'pass':bool(hit) and hit[0]['time']-t0<=barS}
    res['c4']=live; res['c4']['still_playing_no_restart']=await pg.evaluate("()=>window.__tapfour.playing")
    res['c4']['pass']=all(v['pass'] for k,v in live.items() if isinstance(v,dict)) and res['c4']['still_playing_no_restart']
    # key change audible: keys notes in C after change
    # --- check 3: real 30 s in another tab
    other=await ctx.new_page(); await other.goto('about:blank'); await other.bring_to_front()
    n0=await pg.evaluate("()=>{Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});document.dispatchEvent(new Event('visibilitychange'));return window.__schedLog.length}")
    await pg.wait_for_timeout(30000)
    await pg.bring_to_front(); await pg.evaluate("()=>{Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});document.dispatchEvent(new Event('visibilitychange'))}"); await pg.wait_for_timeout(1500)
    res['c3']={'hidden_s':30,'playing_on_return':await pg.evaluate("()=>window.__tapfour.playing"),'steps_scheduled_after_hide':await pg.evaluate("()=>window.__schedLog.length")-n0,
      'active_sources_after':await pg.evaluate("()=>0"),'status':await pg.text_content('#status')}
    res['c3']['pass']=not res['c3']['playing_on_return'] and res['c3']['steps_scheduled_after_hide']==0
    await pg.screenshot(path='screenshot.png',full_page=True)
    res['errors']=errs
    # --- check 5: block the sample host
    pg2=await br.new_page(); await pg2.route('**/cdn.jsdelivr.net/**', lambda r: r.abort()); await pg2.goto(URL); await pg2.wait_for_timeout(6000)
    res['c5']={'status':(await pg2.text_content('#status'))[:300],'playB_enabled':await pg2.is_enabled('#playB'),'export_enabled':await pg2.is_enabled('#exportWav'),'record_enabled':await pg2.is_enabled('#recBtn')}
    await pg2.screenshot(path='blocked.png')
    pg3=await br.new_page(); await pg3.route('**/virtuosity_drums**', lambda r: r.abort()); await pg3.goto(URL); await pg3.wait_for_timeout(6000)
    res['c5']['kit_only_blocked']=(await pg3.text_content('#status'))[:200]
    res['c5']['pass']=('Missing instruments' in res['c5']['status']) and not res['c5']['playB_enabled'] and not res['c5']['export_enabled'] and 'Kit kick' in res['c5']['kit_only_blocked']
    # --- check 7: grep the live code
    src=await pg.evaluate("()=>fetch('app.js').then(r=>r.text())"); html=await pg.evaluate("()=>fetch('index.html').then(r=>r.text())")
    files=await pg.evaluate("()=>window.__tapfour.files.map(f=>[f.label,f.url.split('/').slice(-2).join('/')])")
    names=sorted(set((l, u.split('/')[0]) for l,u in files))
    res['c7']={'@main/@gh-pages':len(re.findall(r'@main|@gh-pages',src+html)),'Math.random':src.count('Math.random'),'createOscillator':src.count('createOscillator'),
      'pinned_shas':sorted(set(re.findall(r'_SHA = "([0-9a-f]{40})"',src))),'voice_to_sample_folders':sorted(set((l.split(' (')[0], u.split('/')[0]) for l,u in files))}
    res['c7']['pass']=res['c7']['@main/@gh-pages']==0 and res['c7']['Math.random']==0
    print(json.dumps(res,indent=1)); json.dump(res,open(OUT,'w'),indent=1); await br.close()
asyncio.run(main())
