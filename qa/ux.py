# First-run + main-flow test (desktop, iPhone 13, Pixel 7). Usage: python3 ux.py URL out.json [shotdir]
import asyncio, json, sys, os
from playwright.async_api import async_playwright
URL=sys.argv[1]; OUT=sys.argv[2] if len(sys.argv)>2 else 'ux.json'; SHOTS=sys.argv[3] if len(sys.argv)>3 else 'out'; os.makedirs(SHOTS,exist_ok=True)
LOADED="/seated (\\d+)\\/\\1/.test(document.getElementById('status').textContent)"
async def run(p, br, name, opts):
  c=await br.new_context(**opts,accept_downloads=True); pg=await c.new_page(); errs=[]; r={}
  pg.on('pageerror',lambda e:errs.append(str(e)))
  mobile=opts.get('has_touch',False); hit=(lambda s: pg.tap(s)) if mobile else (lambda s: pg.click(s))
  await pg.goto(URL); await pg.wait_for_timeout(500)
  r['gate_headline']=await pg.text_content('.gatehead')
  await pg.screenshot(path=f'{SHOTS}/{name}-0-gate.png')
  t0=await pg.evaluate("performance.now()"); await hit('#tapBtn')
  await pg.wait_for_selector('#intro:not([hidden])',timeout=3000); r['intro_headline']=await pg.text_content('#intro h2')
  await pg.wait_for_function("document.getElementById('phBefore').className==='now'",timeout=60000)
  r['before_phase_ms_after_tap']=round(await pg.evaluate("performance.now()")-t0)
  await pg.wait_for_timeout(900); await pg.screenshot(path=f'{SHOTS}/{name}-1-before.png'); r['before_label']=await pg.text_content('#demoSmall')
  await pg.wait_for_function("document.getElementById('phAfter').className==='now'",timeout=20000)
  await pg.wait_for_timeout(1500); await pg.screenshot(path=f'{SHOTS}/{name}-2-after.png'); r['after_label']=await pg.text_content('#demoSmall'); r['after_chord_shown']=await pg.text_content('#demoBig')
  await pg.wait_for_selector('#intro',state='hidden',timeout=20000); r['demo_total_ms']=round(await pg.evaluate("performance.now()")-t0)
  await pg.wait_for_selector('#coach:not([hidden])'); steps=[]
  for i in range(3):
    steps.append(await pg.text_content('#coach li.on b'))
    if i==0: await pg.screenshot(path=f'{SHOTS}/{name}-3-guide.png')
    await hit('#coachNext')
  r['guide_steps']=steps; r['guide_closed']=await pg.is_hidden('#coach')
  r['ls']=await pg.evaluate("[localStorage.getItem('tapfour-intro-seen'),localStorage.getItem('tapfour-guide-done')]")
  vw=await pg.evaluate("[innerWidth,innerHeight]"); bb=await pg.locator('.pad.tapbig').bounding_box()
  r['tap_pad']={'w':round(bb['width']),'h':round(bb['height']),'area_pct_of_viewport':round(100*bb['width']*bb['height']/(vw[0]*vw[1]),1),'fully_above_fold':bb['y']+bb['height']<=vw[1]}
  r['overflow_x_px']=await pg.evaluate("document.documentElement.scrollWidth-innerWidth")
  r['more_closed_by_default']=not await pg.evaluate("document.getElementById('more').open")
  await pg.wait_for_function(LOADED,timeout=120000)
  # pick a vibe: names follow the chosen key (A)
  await hit('#grooves [data-id=anthem]'); r['vibe_strip']=await pg.eval_on_selector_all('.sbar b','e=>e.map(x=>x.textContent)'); r['bpm_after_vibe']=await pg.input_value('#bpm')
  await pg.click('#editChords summary'); r['edit_chords_value']=await pg.input_value('#chords'); await pg.click('#editChords summary')
  # play beat: pad shows now/next, strip lights the current bar
  await hit('#playB'); seen=set(); nexts=set()
  for _ in range(14):
    await pg.wait_for_timeout(500); seen.add(await pg.text_content('#nowChord')+'@'+str(await pg.evaluate("[...document.querySelectorAll('.sbar')].findIndex(e=>e.classList.contains('on'))"))); nexts.add(await pg.text_content('#nextChord'))
  r['now_chord@lit_bar']=sorted(seen); r['next_labels']=sorted(nexts)
  await pg.screenshot(path=f'{SHOTS}/{name}-4-playing.png')
  await hit('#stop')
  # record: count-in, then tap the big pad on beats for one pass
  await hit('#recBtn'); await pg.wait_for_function("()=>{const p=window.__tapfour.tpos(); return p&&p.pass===1}",timeout=10000)
  r['count_in_label']='(passed)'
  for b in range(4):
    for s in (0,6,10):
      pos=b*16+s; await pg.wait_for_function(f"()=>{{const p=window.__tapfour.tpos(); return p&&p.pass===1&&p.pos>={pos}}}",timeout=20000)
      bx=await pg.locator('.pad.tapbig').bounding_box(); x=bx['x']+bx['width']/2; y=bx['y']+bx['height']/2
      if mobile: await pg.touchscreen.tap(x,y)
      else: await pg.mouse.move(x,y); await pg.mouse.down(); await pg.wait_for_timeout(250); await pg.mouse.up()
      if b==1 and s==6: await pg.screenshot(path=f'{SHOTS}/{name}-5-recording.png')
  await pg.wait_for_function("()=>{const p=window.__tapfour.tpos(); return p&&p.pass===2&&p.pos>=1}",timeout=20000); await hit('#recBtn')
  await pg.wait_for_timeout(400); r['takes']=await pg.evaluate("window.__tapfour.takes.map(t=>t.hits.length)")
  # export from More
  await pg.click('#more summary'); await pg.locator('#exportWav').scroll_into_view_if_needed()
  await pg.screenshot(path=f'{SHOTS}/{name}-6-more.png')
  async with pg.expect_download(timeout=90000) as dl: await hit('#exportMid')
  r['midi_download']=(await dl.value).suggested_filename
  await pg.evaluate("window.__tapfour.state.bars=4")
  async with pg.expect_download(timeout=90000) as dl: await hit('#exportWav')
  r['wav_download']=(await dl.value).suggested_filename
  r['buy_label']=await pg.text_content('#buy')
  # reload: first-run is remembered
  await pg.reload(); await hit('#tapBtn'); await pg.wait_for_timeout(1500)
  r['after_reload']={'intro_hidden':await pg.is_hidden('#intro'),'guide_hidden':await pg.is_hidden('#coach'),'intro_runs':await pg.evaluate("window.__introCount||0")}
  r['errors']=errs
  r['pass']=bool(r['intro_headline']=='Tap a rhythm. Get chords.' and r['before_phase_ms_after_tap']<5000 and len(r['guide_steps'])==3 and r['guide_closed'] and r['ls']==['1','1']
    and r['tap_pad']['fully_above_fold'] and r['overflow_x_px']<=0 and len(r['now_chord@lit_bar'])>=3 and r['takes'] and r['takes'][-1]>=8
    and r['wav_download'].startswith('tapfour-') and r['midi_download'].endswith('.mid') and r['after_reload']['intro_hidden'] and r['after_reload']['guide_hidden'] and r['after_reload']['intro_runs']==0 and not errs)
  await c.close(); return r
async def main():
  res={}
  async with async_playwright() as p:
    br=await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    res['desktop']=await run(p,br,'desktop',{'viewport':{'width':1280,'height':800}})
    for dev in ['iPhone 13','Pixel 7']:
      d={k:v for k,v in p.devices[dev].items() if k!='default_browser_type'}; res[dev]=await run(p,br,dev.replace(' ','').lower(),d)
    await br.close()
  print(json.dumps(res,indent=1)); json.dump(res,open(OUT,'w'),indent=1)
asyncio.run(main())
