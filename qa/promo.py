# Captures real 1280x720 frames of the new first-run flow + a real tapped take on the given URL.
import asyncio, base64, json, sys, os
from playwright.async_api import async_playwright
URL=sys.argv[1]; D=sys.argv[2]; os.makedirs(D,exist_ok=True)
LOADED="/seated (\\d+)\\/\\1/.test(document.getElementById('status').textContent)"
B64="""async (o)=>{const r=await window.__tapfour.exportWavBytes(o); let s=''; const b=r.bytes; for(let i=0;i<b.length;i+=32768) s+=String.fromCharCode.apply(null,b.subarray(i,i+32768)); return {name:r.name,b64:btoa(s)};}"""
async def main():
  async with async_playwright() as p:
    br=await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    c=await br.new_context(viewport={'width':1280,'height':720}); pg=await c.new_page()
    await pg.goto(URL); await pg.wait_for_timeout(600); await pg.screenshot(path=f'{D}/p0_gate.png')
    await pg.click('#tapBtn')
    await pg.wait_for_function("document.getElementById('phBefore').className==='now'",timeout=60000); await pg.wait_for_timeout(1100); await pg.screenshot(path=f'{D}/p1_before.png')
    await pg.wait_for_function("document.getElementById('phAfter').className==='now'",timeout=20000); await pg.wait_for_timeout(1300); await pg.screenshot(path=f'{D}/p2_after.png')
    await pg.wait_for_selector('#coach:not([hidden])',timeout=20000); await pg.wait_for_timeout(500); await pg.screenshot(path=f'{D}/p3_guide.png')
    await pg.click('#coachX'); await pg.wait_for_function(LOADED,timeout=120000)
    await pg.click('#grooves [data-id=dusty]'); await pg.evaluate("window.scrollTo(0,0)"); await pg.wait_for_timeout(300); await pg.screenshot(path=f'{D}/p4_vibe.png')
    await pg.click('body',position={'x':5,'y':5}); await pg.click('#recBtn'); await pg.wait_for_function("()=>window.__tapfour.mode==='rec'")
    await pg.wait_for_timeout(400); await pg.evaluate("document.querySelector('.stage').scrollIntoView({block:'center'})"); await pg.screenshot(path=f'{D}/p5_countin.png')
    plan=[]
    for b in range(4): plan += [(b*16+0,' ',3),(b*16+3,' ',3),(b*16+6,'j',2),(b*16+10,'l' if b%2 else ' ',5)]
    await pg.evaluate("document.activeElement&&document.activeElement.blur()")
    for i,(pos,key,hold) in enumerate(plan):
      await pg.wait_for_function(f"()=>{{const p=window.__tapfour.tpos(); return p&&p.pass===1&&p.pos>={pos}}}",timeout=30000)
      await pg.keyboard.down(key)
      if i in (5,9): await pg.screenshot(path=f'{D}/p6_tap{i}.png')
      await pg.wait_for_timeout(int(hold*60/92/4*1000)-25); await pg.keyboard.up(key)
    await pg.wait_for_function("()=>{const p=window.__tapfour.tpos(); return p&&p.pass===2&&p.pos>=1}",timeout=30000); await pg.click('#stop'); await pg.wait_for_timeout(300)
    await pg.click('#playB'); await pg.wait_for_timeout(3300); await pg.screenshot(path=f'{D}/p7_play.png'); await pg.click('#stop')
    await pg.click('#more summary'); await pg.evaluate("document.getElementById('saveHead').scrollIntoView({block:'start'})"); await pg.wait_for_timeout(300); await pg.screenshot(path=f'{D}/p8_save.png')
    r=await pg.evaluate(B64,{'bpm':92,'bars':8}); open(f'{D}/'+r['name'].replace('.wav','-take1.wav'),'wb').write(base64.b64decode(r['b64']))
    tk=await pg.evaluate("window.__tapfour.takes.map(t=>t.hits.length)"); print(json.dumps({'takes':tk,'wav':r['name']})); await br.close()
asyncio.run(main())
