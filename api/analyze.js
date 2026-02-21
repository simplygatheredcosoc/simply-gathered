export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    maxDuration: 120
  }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  const SERP_KEY = process.env.SERPAPI_KEY;

  let image, mediaType;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    image = body.image;
    mediaType = body.mediaType || 'image/jpeg';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  if (!image) return res.status(400).json({ error: 'No image' });

  const cleanImage = image.replace(/^data:image\/\w+;base64,/, '');
  const log = [];

  // ═══════════════════════════════════════════════
  // APPROVED RETAILERS - ShopMy + LTK only
  // ═══════════════════════════════════════════════
  const approved = [
    'anthropologie','serena and lily','serenaandlily','pottery barn','potterybarn',
    'williams-sonoma','williams sonoma','williamssonoma',
    'west elm','westelm','crate and barrel','crateandbarrel','crate & barrel','cb2',
    'restoration hardware','rh.com','rejuvenation','schoolhouse',
    'mcgee','mcgeeandco','one kings lane','onekingslane',
    'arhaus','terrain','shopterrain',
    'lulu and georgia','luluandgeorgia','burke decor','burkedecor',
    'ballard designs','ballarddesigns','perigold','joss and main','jossandmain',
    'allmodern','birch lane','birchlane','wayfair',
    'nordstrom','bloomingdale','neiman marcus','neimanmarcus',
    'saks fifth','saksfifthavenue','bergdorf','macys',"macy's",
    'sur la table','surlatable','food52',
    'juliska','vietri','mackenzie-childs','mackenziechilds','lenox','kate spade',
    'wedgwood','waterford','royal copenhagen','herend','baccarat','christofle',
    'heath ceramics','heathceramics','east fork','eastfork',
    'year and day','le creuset','lecreuset','staub',
    'diptyque','voluspa','nest new york',
    'shopbop','net-a-porter','goop','the citizenry','thecitizenry',
    'aerin','ralph lauren',
    'design within reach','dwr','article','apt2b','joybird',
    'etsy','chairish','1stdibs','ruby lane',
    'target','amazon','world market','cost plus',
    'h&m home','hm.com','zara home','ikea',
    'lumens','circa lighting','visual comfort',
    'home depot','homedepot','lowes',
    'brooklinen','parachute','boll and branch','bollandbranch','matouk','sferra',
    'rugs usa','rugsusa','ruggable','loloi','dash and albert','dashandalbert',
    'minted','framebridge','john derian',
    'mark and graham','markandgraham',
    'annie selke','pine cone hill','annieselke',
    'frontgate','grandin road','garnet hill',
    'cailini coastal','shop terrain','the sill',
    'google'
  ];

  function isApproved(source, link) {
    const s = (source || '').toLowerCase();
    const l = (link || '').toLowerCase();
    return approved.some(a => s.includes(a) || l.includes(a));
  }

  try {
    // ═══════════════════════════════════════════════
    // STEP 1: Upload image to get a public URL
    // ═══════════════════════════════════════════════
    let imageUrl = null;

    // Try imgbb
    try {
      const form = new URLSearchParams();
      form.append('image', cleanImage);
      form.append('expiration', '600');
      const r = await fetch('https://api.imgbb.com/1/upload?key=5e87bda0a1f4270c0813577d712e84e0', {
        method: 'POST', body: form
      });
      if (r.ok) {
        const d = await r.json();
        if (d.data && d.data.url) {
          imageUrl = d.data.url;
          log.push('upload:imgbb');
        }
      } else {
        log.push('imgbb-fail:' + r.status);
      }
    } catch (e) { log.push('imgbb-err:' + e.message); }

    // Backup: freeimage
    if (!imageUrl) {
      try {
        const form2 = new URLSearchParams();
        form2.append('source', cleanImage);
        form2.append('type', 'base64');
        form2.append('action', 'upload');
        const r2 = await fetch('https://freeimage.host/api/1/upload?key=6d207e02198a847aa98d0a2a901485a5', {
          method: 'POST', body: form2
        });
        if (r2.ok) {
          const d2 = await r2.json();
          if (d2.image && d2.image.url) {
            imageUrl = d2.image.url;
            log.push('upload:freeimage');
          }
        } else {
          log.push('freeimage-fail:' + r2.status);
        }
      } catch (e) { log.push('freeimage-err:' + e.message); }
    }

    if (!imageUrl) {
      log.push('ALL-UPLOADS-FAILED');
    }

    // ═══════════════════════════════════════════════
    // STEP 2: Google Lens - find exact & similar
    // ═══════════════════════════════════════════════
    let lensResults = [];

    if (SERP_KEY && imageUrl) {
      // Visual matches
      try {
        const p = new URLSearchParams({
          engine: 'google_lens', url: imageUrl,
          api_key: SERP_KEY, hl: 'en', country: 'us'
        });
        const r = await fetch('https://serpapi.com/search.json?' + p.toString());
        if (r.ok) {
          const d = await r.json();
          log.push('lens-ok:visual=' + (d.visual_matches || []).length + ',shop=' + (d.shopping_results || []).length);
          for (const vm of (d.visual_matches || []).slice(0, 25)) {
            if (!vm.link) continue;
            lensResults.push({
              title: vm.title || '', link: vm.link,
              source: vm.source || '', thumbnail: vm.thumbnail || '',
              price: vm.price ? parseFloat(String(vm.price.value || vm.price).replace(/[^0-9.]/g, '')) : 0,
              type: 'visual'
            });
          }
          for (const sr of (d.shopping_results || []).slice(0, 10)) {
            if (!sr.link) continue;
            lensResults.push({
              title: sr.title || '', link: sr.link || sr.product_link || '',
              source: sr.source || '', thumbnail: sr.thumbnail || '',
              price: sr.extracted_price || 0,
              type: 'shopping'
            });
          }
        } else {
          const errText = await r.text();
          log.push('lens-fail:' + r.status + ':' + errText.substring(0, 100));
        }
      } catch (e) { log.push('lens-err:' + e.message); }
    }

    log.push('total-lens:' + lensResults.length);

    // ═══════════════════════════════════════════════
    // STEP 3: Claude identifies items
    // ═══════════════════════════════════════════════
    const lensContext = lensResults.length > 0
      ? '\n\nGoogle Lens found these matching products:\n' +
        lensResults.slice(0, 30).map((r, i) =>
          i + '. "' + r.title + '" from ' + r.source + (r.price ? ' ($' + r.price + ')' : '')
        ).join('\n')
      : '';

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: cleanImage } },
            { type: 'text', text: 'You are a luxury home product expert. Identify every shoppable item in this image.' + lensContext + '\n\nReturn ONLY valid JSON:\n{\n  "items": [\n    {\n      "name": "Very specific product description including brand if recognizable",\n      "exact_search": "Most precise Google Shopping search for THIS EXACT item",\n      "similar_search": "Search for SIMILAR items at Anthropologie OR Pottery Barn OR Williams Sonoma OR Serena & Lily",\n      "matched_lens_indices": [0, 3],\n      "order": 1,\n      "styling_tip": "brief tip"\n    }\n  ],\n  "colors": [{"name": "Paint Name", "brand": "Benjamin Moore", "code": "HC-172", "hex": "#hex"}],\n  "style_summary": "Brief description"\n}\n\nRULES:\n1. Be EXTREMELY specific. Include brand if you recognize it.\n2. For matched_lens_indices, list which Google Lens result indices match this item\n3. For similar_search, ALWAYS include a retailer name like Anthropologie, Pottery Barn, West Elm, etc.\n4. Return ONLY JSON' }
          ]
        }]
      })
    });

    if (!claudeRes.ok) {
      return res.status(500).json({ error: 'Claude failed: ' + claudeRes.status, log: log.join(' | ') });
    }

    const claudeData = await claudeRes.json();
    const claudeText = claudeData.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const identified = JSON.parse(claudeText);
    log.push('items-found:' + (identified.items || []).length);

    // ═══════════════════════════════════════════════
    // STEP 4: Build results per item
    // ═══════════════════════════════════════════════
    const items = [];

    for (const item of (identified.items || [])) {
      const exactProducts = [];
      const similarProducts = [];
      const seenLinks = new Set();

      // A) Lens matches Claude linked to this item
      for (const idx of (item.matched_lens_indices || [])) {
        if (idx >= 0 && idx < lensResults.length) {
          const lr = lensResults[idx];
          if (!lr.link || seenLinks.has(lr.link)) continue;
          if (!isApproved(lr.source, lr.link)) continue;
          seenLinks.add(lr.link);
          exactProducts.push({
            title: lr.title, price: lr.price || 0, source: lr.source,
            link: lr.link, thumbnail: lr.thumbnail, isLens: true
          });
        }
      }

      // B) Keyword match across all approved lens results
      const words = item.name.toLowerCase().split(/[\s,\-]+/).filter(w => w.length > 3);
      for (const lr of lensResults) {
        if (seenLinks.has(lr.link)) continue;
        if (!isApproved(lr.source, lr.link)) continue;
        const t = (lr.title || '').toLowerCase();
        if (words.filter(w => t.includes(w)).length >= 2) {
          seenLinks.add(lr.link);
          exactProducts.push({
            title: lr.title, price: lr.price || 0, source: lr.source,
            link: lr.link, thumbnail: lr.thumbnail, isLens: true
          });
        }
      }

      // C) Google Shopping - exact search
      if (SERP_KEY && item.exact_search) {
        try {
          const sp = new URLSearchParams({
            engine: 'google_shopping', q: item.exact_search,
            api_key: SERP_KEY, num: 10, gl: 'us', hl: 'en'
          });
          const sr = await fetch('https://serpapi.com/search.json?' + sp.toString());
          if (sr.ok) {
            const sd = await sr.json();
            for (const r of (sd.shopping_results || [])) {
              const link = r.product_link || r.link || '';
              if (!link || seenLinks.has(link)) continue;
              if (!isApproved(r.source, link)) continue;
              seenLinks.add(link);
              let price = 0;
              if (typeof r.extracted_price === 'number') price = r.extracted_price;
              else if (r.price) { const m = String(r.price).match(/[\d,.]+/); if (m) price = parseFloat(m[0].replace(',', '')); }
              exactProducts.push({
                title: r.title || '', price, source: r.source || '',
                link, thumbnail: r.thumbnail || '', isLens: false
              });
            }
          }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 250));
      }

      // D) Google Shopping - similar search
      if (SERP_KEY && item.similar_search) {
        try {
          const sp = new URLSearchParams({
            engine: 'google_shopping', q: item.similar_search,
            api_key: SERP_KEY, num: 8, gl: 'us', hl: 'en'
          });
          const sr = await fetch('https://serpapi.com/search.json?' + sp.toString());
          if (sr.ok) {
            const sd = await sr.json();
            for (const r of (sd.shopping_results || [])) {
              const link = r.product_link || r.link || '';
              if (!link || seenLinks.has(link)) continue;
              if (!isApproved(r.source, link)) continue;
              seenLinks.add(link);
              let price = 0;
              if (typeof r.extracted_price === 'number') price = r.extracted_price;
              else if (r.price) { const m = String(r.price).match(/[\d,.]+/); if (m) price = parseFloat(m[0].replace(',', '')); }
              similarProducts.push({
                title: r.title || '', price, source: r.source || '',
                link, thumbnail: r.thumbnail || '', isLens: false
              });
            }
          }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 250));
      }

      items.push({
        name: item.name,
        order: item.order || 1,
        styling_tip: item.styling_tip || '',
        search_query: item.exact_search || item.name,
        exactCount: Math.min(exactProducts.length, 6),
        products: [
          ...exactProducts.slice(0, 6),
          ...similarProducts.slice(0, 4)
        ]
      });
    }

    return res.status(200).json({
      items,
      colors: identified.colors || [],
      style_summary: identified.style_summary || '',
      lens_used: !!imageUrl,
      lens_total: lensResults.length,
      log: log.join(' | ')
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, log: log.join(' | ') });
  }
}
