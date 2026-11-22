"""Exercise a CLI-packaged Gallery. Requires Python Playwright and Chromium."""
import argparse,asyncio,json,pathlib,shutil
from playwright.async_api import async_playwright
async def run(url, chrome, output):
 async with async_playwright() as p:
  b=await p.chromium.launch(executable_path=chrome,args=['--no-sandbox']);results=[]
  for screen in ['Standard APIs','Lists','Navigation','Form','DataTable','Animations','Gestures','System','Editor']:
   page=await b.new_page(viewport={'width':1280,'height':900});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   try:
    await page.goto(url);await page.locator('#status').wait_for(state='hidden');await page.get_by_text('Apps',exact=True).click();await page.get_by_text(screen,exact=True).last.click();await page.wait_for_timeout(500)
    if screen=='Standard APIs':
     for name,expected in [('Utilities','SHA-256:'),('Files','Hello from NSH'),('Environment','Module:')]:
      await page.get_by_text('Run '+name,exact=True).click();await page.wait_for_timeout(700);assert expected in await page.locator('body').inner_text(),await page.locator('body').inner_text()
    elif screen=='Lists':
     await page.get_by_text('Jump to 60',exact=True).click();await page.wait_for_timeout(800);assert await page.get_by_text('60',exact=True).is_visible()
    elif screen=='Navigation':
     await page.get_by_text('Full screen',exact=True).click();await page.wait_for_timeout(600);await page.keyboard.press('Escape');await page.wait_for_timeout(600)
    elif screen=='Form':
     inputs=page.locator('input');await inputs.first.fill('123');assert await inputs.first.input_value()=='123';await page.get_by_text('Submit',exact=True).click()
    elif screen=='DataTable':
     await page.get_by_text('Row 500,000',exact=True).click();await page.wait_for_timeout(800);assert 'rows 500000' in await page.locator('body').inner_text()
    elif screen=='Animations':await page.get_by_text('Replay',exact=True).click();await page.wait_for_timeout(1000)
    elif screen=='Gestures':
     target=page.get_by_text('Click, hold, or slide off',exact=True);await target.click();await page.wait_for_timeout(300)
    elif screen=='System':
     await page.get_by_text('Confirm',exact=True).click();await page.wait_for_timeout(300);await page.keyboard.press('Escape')
    elif screen=='Editor':
     await page.locator('textarea').first.focus();await page.keyboard.type('// browser test');await page.wait_for_timeout(300);assert '// browser test' in await page.locator('body').inner_text()
    assert not errors,errors
    result={'screen':screen,'passed':True,'text':(await page.locator('body').inner_text())[:1800]}
   except Exception as e:result={'screen':screen,'passed':False,'error':str(e)[:2500],'errors':errors}
   results.append(result);print(json.dumps(result),flush=True);await page.close()
  pathlib.Path(output).write_text(json.dumps(results,indent=2));await b.close()
  assert all(result['passed'] for result in results), 'Packaged Gallery checks failed; see report'
if __name__ == '__main__':
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('url')
 parser.add_argument('--chrome',default=shutil.which('chromium') or shutil.which('google-chrome'))
 parser.add_argument('--output',default='gallery-check.json')
 args=parser.parse_args();asyncio.run(run(args.url,args.chrome,args.output))
