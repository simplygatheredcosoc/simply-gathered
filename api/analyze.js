export const config = {
  api: { bodyParser: { sizeLimit: '10mb' }, maxDuration: 120 }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  const SERP_KEY = process.env.SERPAPI_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'Missing CLAUDE_API_KEY' });

  let image, mediaType;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    image = body.image;
    mediaType = body.mediaType || 'image/jpeg';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid body' });
  }
  if (!image) return res.status(400).json({ error: 'No image' });
  const cleanImage = image.replace(/^data:image\/\w+;base64,/, '');

  // ALLOWLIST: Only ShopMy + LTK retailers
  const allowed = [
    'anthropologie','serena','pottery barn','potterybarn','williams sonoma','williams-sonoma',
    'west elm','westelm','crate','cb2','restoration hardware','rh.com',
    'mcgee','one kings lane','onekingslane','arhaus','terrain','shopterrain',
    'rejuvenation','schoolhouse','lulu and georgia','luluandgeorgia',
    'burke decor','burkedecor','ballard','perigold','joss','allmodern','birch lane','birchlane','wayfair',
    'nordstrom','bloomingdale','neiman','saks','bergdorf','macy',
    'sur la table','surlatable','food52','juliska','replacements',
    'heath ceramics','east fork','year and day','le creuset','diptyque','voluspa',
    'mackenzie-childs','lenox','kate spade','vietri','wedgwood','waterford','herend',
    'shopbop','net-a-porter','goop','the citizenry','aerin','ralph lauren',
    'design within reach','article','apt2b',
    'etsy','chairish','1stdibs','ruby lane','ebay',
    'target','amazon','world market','h&m home','hm.com','zara home','ikea',
    'lumens','circa lighting','home depot','homedepot','lowes',
    'minted','framebridge','john derian',
    'brooklinen','parachute','boll','matouk','sferra',
    'rugs usa','rugsusa','ruggable','loloi','dash & albert',
    'google'
  ];
  function isOk(source, link) {
    const s = (source || '').toLowerCase();
    const l = (link || '').toLowerCase();
    return allowed.some(a => s.includes(a) || l.includes(a));
  }

  const errors = [];
  let imageUrl = null;
  let uploadMethod = 'none';
  let lensExact = [];
  let lensVisual = [];
  let lensProducts = [];

  try {
    // ═══════════════════════════════════════════
    // STEP 1: Upload image to get a public URL
    // ═══════════════════════════════════════════
    if (SERP_KEY) {
      // imgbb
      try {
        const fd = new URLSearchParams();
        fd.append('image', cleanImage);
        fd.append('expiration', '600');
        const r = await fetch('https://api.imgbb.com/1/upload?key=5e87bda0a1f4270c0813577d712e84e0', {
          method: 'POST', body: fd
        });
        if (r.ok) {
          const d = await r.json();
          if (d.data && d.data.url) { imageUrl = d.data.url; uploadMethod = 'imgbb'; }
          else errors.push('imgbb: no url in response');
        } else {
          const t = await r.text().catch(() => '');
          errors.push('imgbb: status ' + r.status + ' ' + t.substring(0, 100));
        }
      } catch (e) { errors.push('imgbb: ' + e.message); }

      // freeimage.host backup
      if (!imageUrl) {
        try {
          const fd2 = new URLSearchParams();
          fd2.append('source', cleanImage);
          fd2.append('type', 'base64');
          fd2.append('action', 'upload');
          const r2 = await fetch('https://freeimage.host/api/1/upload?key=6d207e02198a847aa98d0a2a901485a5', {
            method: 'POST', body: fd2
          });
          if (r2.ok) {
            const d2 = await r2.json();
            if (d2.image && d2.image.url) { imageUrl = d2.image.url; uploadMethod = 'freeimage'; }
            else errors.push('freeimage: no url');
          } else {
            errors.push('freeimage: status ' + r2.status);
          }
        } catch (e) { errors.push('freeimage: ' + e.message); }
      }

      // ═══════════════════════════════════════════
      // STEP 2: Google Lens - 3 tab searches
      // ═══════════════════════════════════════════
      if (imageUrl) {
        const baseParams = {
          engine: 'google_lens',
          url: imageUrl,
          api_key: SERP_KEY,
          hl: 'en',
          country: 'us'
        };

        // Search A: EXACT MATCHES
        try {
          const p = new URLSearchParams(Object.assign({}, baseParams, { type: 'exact_matches' }));
          const r = await fetch('https://serpapi.com/search.json?' + p.toString());
          if (r.ok) {
            const d = await r.json();
            for (const m of (d.exact_matches || d.visual_matches || []).slice(0, 15)) {
              if (!m.link) continue;
              lensExact.push({
                title: m.title || '', link: m.link, source: m.source || '',
                thumbnail: m.thumbnail || '',
                price: (m.price && m.price.extracted_value) || (m.price && m.price.value) || (m.price ? parseFloat(String(m.price).replace(/[^0-9.]/g, '')) : 0)
              });
            }
            errors.push('lens-exact: found ' + lensExact.length);
          } else { errors.push('lens-exact: status ' + r.status); }
        } catch (e) { errors.push('lens-exact: ' + e.message); }

        // Search B: VISUAL MATCHES
        try {
          const p = new URLSearchParams(Object.assign({}, baseParams, { type: 'visual_matches' }));
          const r = await fetch('https://serpapi.com/search.json?' + p.toString());
          if (r.ok) {
            const d = await r.json();
            const existing = new Set(lensExact.map(function(x) { return x.link; }));
            for (const m of (d.visual_matches || []).slice(0, 15)) {
              if (!m.link || existing.has(m.link)) continue;
              existing.add(m.link);
              lensVisual.push({
                title: m.title || '', link: m.link, source: m.source || '',
                thumbnail: m.thumbnail || '',
                price: (m.price && m.price.extracted_value) || (m.price && m.price.value) || (m.price ? parseFloat(String(m.price).replace(/[^0-9.]/g, '')) : 0)
              });
            }
            errors.push('lens-visual: found ' + lensVisual.length);
          } else { errors.push('lens-visual: status ' + r.status); }
        } catch (e) { errors.push('lens-visual: ' + e.message); }

        // Search C: PRODUCTS
        try {
          const p = new URLSearchParams(Object.assign({}, baseParams, { type: 'products' }));
          const r = await fetch('https://serpapi.com/search.json?' + p.toString());
          if (r.ok) {
            const d = await r.json();
            const existing = new Set(lensExact.concat(lensVisual).map(function(x) { return x.link; }));
            for (const m of (d.visual_matches || d.shopping_results || []).slice(0, 15)) {
              const link = m.link || m.product_link || '';
              if (!link || existing.has(link)) continue;
              existing.add(link);
              lensProducts.push({
                title: m.title || '', link: link, source: m.source || '',
                thumbnail: m.thumbnail || '',
                price: m.extracted_price || (m.price && m.price.extracted_value) || (m.price ? parseFloat(String(m.price).replace(/[^0-9.]/g, '')) : 0)
              });
            }
            errors.push('lens-products: found ' + lensProducts.length);
          } else { errors.push('lens-products: status ' + r.status); }
        } catch (e) { errors.push('lens-products: ' + e.message); }
      } else {
        errors.push('NO IMAGE URL - both uploads failed');
      }
    }

    const allLens = lensExact.concat(lensVisual).concat(lensProducts);

    // ═══════════════════════════════════════════
    // STEP 3: Claude identifies items
    // ═══════════════════════════════════════════
    const lensContext = allLens.length > 0
      ? '\n\nGoogle Lens found these matches:\n' + allLens.map(function(r, i) {
          return i + '. "' + r.title + '" — ' + r.source + (r.price ? ' ($' + r.price + ')' : '') + ' — ' + r.link;
        }).join('\n')
      : '';

    const identifyRes = await fetch('https://api.anthropic.com/v1/messages', {
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
            { type: 'text', text: 'You are a luxury home product expert. Identify every shoppable item in this image.' + lensContext + '\n\nReturn ONLY valid JSON:\n{\n  "items": [\n    {\n      "name": "Specific product description with brand if recognizable",\n      "exact_product": "Most precise search for the EXACT item (include brand if known)",\n      "similar_search": "Broader search at a quality retailer like green dinner plate Anthropologie",\n      "matched_lens_indices": [0, 3],\n      "order": 1,\n      "styling_tip": "brief tip"\n    }\n  ],\n  "colors": [{"name":"Color","brand":"Paint brand","code":"Code","hex":"#hex"}],\n  "style_summary": "brief description"\n}\n\nRULES:\n1. Be SPECIFIC with product names\n2. Name brands you recognize\n3. matched_lens_indices = which Lens results match this item\n4. For similar_search, include a quality retailer name: Anthropologie, Pottery Barn, Williams Sonoma, West Elm, Serena & Lily, McGee & Co, Etsy, CB2, Crate & Barrel, Target, Terrain\n5. Return ONLY JSON' }
          ]
        }]
      })
    });

    if (!identifyRes.ok) return res.status(500).json({ error: 'Claude: ' + identifyRes.status, debug: errors });

    const identifyData = await identifyRes.json();
    const identifyText = identifyData.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const identified = JSON.parse(identifyText);

    // ═══════════════════════════════════════════
    // STEP 4: Build results per item
    // ═══════════════════════════════════════════
    const itemsWithProducts = [];

    for (var ii = 0; ii < identified.items.length; ii++) {
      const item = identified.items[ii];
      const exactProducts = [];
      const similarProducts = [];
      const seenLinks = new Set();

      // A) Lens matches assigned by Claude
      var indices = item.matched_lens_indices || [];
      for (var ai = 0; ai < indices.length; ai++) {
        var idx = indices[ai];
        if (idx >= 0 && idx < allLens.length) {
          var lr = allLens[idx];
          if (!lr.link || seenLinks.has(lr.link)) continue;
          if (!isOk(lr.source, lr.link)) continue;
          seenLinks.add(lr.link);
          exactProducts.push({
            title: lr.title, price: lr.price || 0, source: lr.source,
            link: lr.link, thumbnail: lr.thumbnail, isLensMatch: true
          });
        }
      }

      // B) Keyword overlap with all lens results
      var words = item.name.toLowerCase().split(/[\s,\-]+/).filter(function(w) { return w.length > 3; });
      for (var bi = 0; bi < allLens.length; bi++) {
        var lr2 = allLens[bi];
        if (!lr2.link || seenLinks.has(lr2.link)) continue;
        if (!isOk(lr2.source, lr2.link)) continue;
        var t = (lr2.title || '').toLowerCase();
        var matchCount = words.filter(function(w) { return t.includes(w); }).length;
        if (matchCount >= 2) {
          seenLinks.add(lr2.link);
          exactProducts.push({
            title: lr2.title, price: lr2.price || 0, source: lr2.source,
            link: lr2.link, thumbnail: lr2.thumbnail, isLensMatch: true
          });
        }
      }

      // C) Google Shopping - exact product
      if (SERP_KEY && item.exact_product) {
        try {
          var sp = new URLSearchParams({
            engine: 'google_shopping', q: item.exact_product,
            api_key: SERP_KEY, num: '8', gl: 'us', hl: 'en'
          });
          var sr = await fetch('https://serpapi.com/search.json?' + sp.toString());
          if (sr.ok) {
            var sd = await sr.json();
            var results = sd.shopping_results || [];
            for (var ci = 0; ci < results.length; ci++) {
              var r = results[ci];
              var link = r.product_link || r.link || '';
              if (!link || seenLinks.has(link)) continue;
              if (!isOk(r.source, link)) continue;
              seenLinks.add(link);
              var price = 0;
              if (typeof r.extracted_price === 'number') price = r.extracted_price;
              else if (r.price) { var pm = String(r.price).match(/[\d,.]+/); if (pm) price = parseFloat(pm[0].replace(',', '')); }
              exactProducts.push({
                title: r.title || '', price: price, source: r.source || '',
                link: link, thumbnail: r.thumbnail || '', isLensMatch: false
              });
            }
          }
        } catch (e) {}
        await new Promise(function(resolve) { setTimeout(resolve, 200); });
      }

      // D) Google Shopping - similar items
      if (SERP_KEY && item.similar_search) {
        try {
          var sp2 = new URLSearchParams({
            engine: 'google_shopping', q: item.similar_search,
            api_key: SERP_KEY, num: '6', gl: 'us', hl: 'en'
          });
          var sr2 = await fetch('https://serpapi.com/search.json?' + sp2.toString());
          if (sr2.ok) {
            var sd2 = await sr2.json();
            var results2 = sd2.shopping_results || [];
            for (var di = 0; di < results2.length; di++) {
              var r2 = results2[di];
              var link2 = r2.product_link || r2.link || '';
              if (!link2 || seenLinks.has(link2)) continue;
              if (!isOk(r2.source, link2)) continue;
              seenLinks.add(link2);
              var price2 = 0;
              if (typeof r2.extracted_price === 'number') price2 = r2.extracted_price;
              else if (r2.price) { var pm2 = String(r2.price).match(/[\d,.]+/); if (pm2) price2 = parseFloat(pm2[0].replace(',', '')); }
              similarProducts.push({
                title: r2.title || '', price: price2, source: r2.source || '',
                link: link2, thumbnail: r2.thumbnail || '', isLensMatch: false
              });
            }
          }
        } catch (e) {}
        await new Promise(function(resolve) { setTimeout(resolve, 200); });
      }

      itemsWithProducts.push({
        name: item.name,
        order: item.order || 1,
        styling_tip: item.styling_tip || '',
        search_query: item.exact_product || item.name,
        exactCount: Math.min(exactProducts.length, 6),
        products: exactProducts.slice(0, 6).concat(similarProducts.slice(0, 4))
      });
    }

    return res.status(200).json({
      items: itemsWithProducts,
      colors: identified.colors || [],
      style_summary: identified.style_summary || '',
      lens_used: !!imageUrl,
      lens_matches: allLens.length,
      upload_method: uploadMethod,
      debug: {
        imageUrl: imageUrl ? imageUrl.substring(0, 60) : null,
        exactCount: lensExact.length,
        visualCount: lensVisual.length,
        productCount: lensProducts.length,
        errors: errors
      }
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, debug_errors: errors });
  }
}
