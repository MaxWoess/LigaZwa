const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  fs.mkdirSync('p/bodies', { recursive: true });
  const b = await chromium.launch();
  const ctx = await b.newContext({ locale: 'de-AT', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' });
  const p = await ctx.newPage();
  const log = [];
  let n = 0;
  p.on('websocket', (ws) => { log.push({ ws: ws.url() }); ws.on('framereceived', (f) => { if (n++ < 30) log.push({ wsframe: String(f.payload).slice(0, 2000) }); }); });
  p.on('response', async (r) => {
    const t = r.request().resourceType();
    if (!['xhr', 'fetch', 'document', 'eventsource', 'other'].includes(t)) return;
    const h = r.headers();
    const e = { t, status: r.status(), url: r.url(), ct: h['content-type'], acao: h['access-control-allow-origin'] || null };
    try {
      const body = await r.text();
      e.size = body.length;
      const f = 'p/bodies/' + String(log.length).padStart(3, '0') + '.txt';
      fs.writeFileSync(f, body.slice(0, 400000)); e.file = f;
    } catch {}
    log.push(e);
  });
  for (const u of ['https://matchcenter.laola1.at/Fussball/Oesterreich/2Liga/match/72440722', 'https://matchcenter.laola1.at/Fussball/Oesterreich/2Liga/spielplan', 'https://matchcenter.laola1.at/Fussball/Oesterreich/2Liga/liveticker']) {
    await p.goto(u, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => log.push({ err: e.message }));
    await p.waitForTimeout(8000);
    fs.writeFileSync('p/page-' + u.split('/').pop() + '.html', await p.content());
    await p.screenshot({ path: 'p/page.png', fullPage: true });
    // Links zu einzelnen Spielen
    const links = await p.$$eval('a', (as) => as.map((a) => a.href).filter((h) => /matchcenter\.laola1\.at/.test(h)));
    fs.appendFileSync('p/links.txt', [...new Set(links)].join('\n') + '\n');
    const ev = u.includes('spielplan') ? [...new Set(links)].filter((l) => /\/match\/\d+/.test(l))[0] : null;
    if (ev) {
      log.push({ visiting: ev });
      await p.goto(ev, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => log.push({ err: e.message }));
      await p.waitForTimeout(8000);
      fs.writeFileSync('p/event.html', await p.content());
      await p.screenshot({ path: 'p/event.png', fullPage: true });
    }
  }
  fs.writeFileSync('p/log.json', JSON.stringify(log, null, 1));
  await b.close();
})();
