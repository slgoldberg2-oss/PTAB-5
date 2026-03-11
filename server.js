const express    = require('express');
const path       = require('path');
const https      = require('https');
const puppeteer  = require('puppeteer');
const { PDFDocument } = require('pdf-lib');

const app  = express();
const PORT = process.env.PORT || 3000;
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || '';
const SODA_HOST = 'datacatalog.cookcountyil.gov';

function pad14(s) {
  s = String(s).replace(/\D/g, '');
  while (s.length < 14) s = '0' + s;
  return s.slice(0, 14);
}

function dashPIN(p) {
  p = pad14(p);
  return p.substr(0,2)+'-'+p.substr(2,2)+'-'+p.substr(4,3)+'-'+p.substr(7,3)+'-'+p.substr(10,4);
}

function sodaGet(pathname, params) {
  const qs = Object.entries(params)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
  const headers = { 'Accept': 'application/json' };
  if (APP_TOKEN) headers['X-App-Token'] = APP_TOKEN;
  return new Promise((resolve, reject) => {
    const req = https.get({ host: SODA_HOST, path: pathname + '?' + qs, headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200)
          return reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 400)));
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// ── PDF generation endpoint ───────────────────────────────────────────────────
// POST /api/pdf  body: { pins: ["05171070150000", ...] }
// Returns a merged PDF of first 2 pages per PIN
app.use(express.json());

app.post('/api/pdf', async (req, res) => {
  const pins = (req.body && Array.isArray(req.body.pins)) ? req.body.pins : [];
  if (!pins.length) return res.status(400).json({ error: 'No PINs provided' });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const merged = await PDFDocument.create();

    for (const rawPin of pins) {
      const pin14 = pad14(rawPin);
      const url   = `https://www.cookcountyassessoril.gov/pin/${pin14}/print?printImg=FALSE`;

      let pinPdfBytes;
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 900 });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Small pause to let any deferred content render
        await new Promise(r => setTimeout(r, 1500));

        pinPdfBytes = await page.pdf({
          format: 'Letter',
          printBackground: true,
          margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
        });
        await page.close();
      } catch (pageErr) {
        console.error(`PDF failed for PIN ${pin14}:`, pageErr.message);
        continue; // skip this PIN, don't abort the whole batch
      }

      // Copy only first 2 pages into merged doc
      try {
        const src   = await PDFDocument.load(pinPdfBytes);
        const total = src.getPageCount();
        const pages = Math.min(2, total);
        const indices = Array.from({ length: pages }, (_, i) => i);
        const copied = await merged.copyPages(src, indices);
        copied.forEach(p => merged.addPage(p));
      } catch (mergeErr) {
        console.error(`Merge failed for PIN ${pin14}:`, mergeErr.message);
      }
    }

    await browser.close();

    if (merged.getPageCount() === 0)
      return res.status(500).json({ error: 'No pages could be generated for the provided PINs' });

    const pdfBytes = await merged.save();
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': 'attachment; filename="PTAB_Property_Data.pdf"',
      'Content-Length':      pdfBytes.length
    });
    res.end(Buffer.from(pdfBytes));

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('PDF generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Cook County SODA proxy ────────────────────────────────────────────────────
app.get('/api/pin/:pin', async (req, res) => {
  const yr = (req.query.year || '').trim();
  if (!yr || !/^\d{4}$/.test(yr))
    return res.status(400).json({ error: 'Missing ?year=YYYY' });

  const pin14  = pad14(req.params.pin);
  const pStrip = pin14.replace(/^0+/, '') || pin14;
  const pinClause = pStrip === pin14
    ? `pin = '${pin14}'`
    : `(pin = '${pin14}' OR pin = '${pStrip}')`;
  const where = `${pinClause} AND year = '${yr}'`;

  try {
    const [asrR, charsR, addrR] = await Promise.all([
      sodaGet('/resource/uzyt-m557.json', {
        '$where':  where,
        '$select': 'pin,year,class,nbhd,certified_bldg,certified_land,certified_tot',
        '$limit':  '1'
      }).catch(e => ({ _err: e.message })),

      sodaGet('/resource/x54s-btds.json', {
        '$where':  where,
        '$select': 'pin,year,char_yrblt,char_bldg_sf,char_land_sf,char_fbath,char_hbath,char_frpl,char_type_resd,char_ext_wall,char_apts,char_gar1_size,char_bsmt,char_air',
        '$limit':  '1'
      }).catch(e => ({ _err: e.message })),

      sodaGet('/resource/3723-97qp.json', {
        '$where':  where,
        '$select': 'pin,year,prop_address_full,prop_address_city_name',
        '$limit':  '1'
      }).catch(e => ({ _err: e.message }))
    ]);

    const asrRow   = Array.isArray(asrR)   ? asrR[0]   : null;
    const charsRow = Array.isArray(charsR) ? charsR[0] : null;
    const addrRow  = Array.isArray(addrR)  ? addrR[0]  : null;

    const asr = asrRow ? {
      pin: asrRow.pin, tax_year: asrRow.year, class: asrRow.class,
      neighborhood_code: asrRow.nbhd,
      certified_bldg: asrRow.certified_bldg,
      certified_land: asrRow.certified_land,
      certified_tot:  asrRow.certified_tot
    } : null;

    const chars = charsRow ? {
      pin: charsRow.pin, tax_year: charsRow.year,
      year_built: charsRow.char_yrblt, building_sqft: charsRow.char_bldg_sf,
      land_sqft: charsRow.char_land_sf, num_full_baths: charsRow.char_fbath,
      num_half_baths: charsRow.char_hbath, num_fireplaces: charsRow.char_frpl,
      type_of_residence: charsRow.char_type_resd, ext_wall_material: charsRow.char_ext_wall,
      num_apartments: charsRow.char_apts, garage_size: charsRow.char_gar1_size,
      basement_type: charsRow.char_bsmt, central_air: charsRow.char_air
    } : null;

    const addr = addrRow ? {
      pin: addrRow.pin, tax_year: addrRow.year,
      property_address: addrRow.prop_address_full,
      property_city: addrRow.prop_address_city_name
    } : null;

    res.json({
      pin: pin14, year: yr, asr, chars, addr,
      errors: {
        asr:   (asrR   && asrR._err) || null,
        chars: (charsR && charsR._err) || null,
        addr:  (addrR  && addrR._err) || null
      }
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log('PTAB server on port ' + PORT));
