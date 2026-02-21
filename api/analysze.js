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
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'CLAUDE_API_KEY not set' });

  let image, mediaType;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    image = body.image;
    mediaType = body.mediaType || 'image/jpeg';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (!image) return res.status(400).json({ error: 'No image' });
  const cleanImage = image.replace(/^data:image\/\w+;base64,/, '');

  // Junk retailers to always skip
  const junkRetailers = [
    // Chinese fast fashion / junk
    'temu', 'shein', 'aliexpress', 'wish.com', 'dhgate', 'banggood', 'geekbuying', 
    'lightinthebox', 'sammydress', 'tidebuy', 'rosegal', 'zaful', 'romwe', 'yesstyle',
    'miniinthebox', 'tomtop', 'dresslily', 'newchic', 'floryday', 'noracora',
    // Party supply / cheap bulk
    'efavormart', 'posh setting', 'over the top', 'glam party', 'orientaltrading',
    'shindigz', 'stumps', 'fun express', 'darice', 'dollartree', 'partycity',
    'party city', 'wholesale', 'bulkparty', 'napkins.com', 'tableclothsfactory',
    'cvlinens', 'your chair covers', 'razatrade', 'balsacircle', 'balsa circle',
    'eventdecordirect', 'leilani wholesale', 'koyal wholesale',
    // Craft / low-end
    'michaels', 'joann', 'hobbylobby', 'hobby lobby', 'five below', '5below',
    // Big box low-end
    'kohls', "kohl's", 'dollar general', 'dollar tree', 'family dollar', 'big lots',
    'biglots', 'burlington', 'ross', 'tjmaxx', 'marshalls', 'dd discount',
    // Random junk sites
    'fruugo', 'ubuy', 'joom', 'vova', 'patpat', 'cider', 'halara',
    'shopcider', 'chicme', 'chic me', 'fairyseason', 'boutiquefeel',
    'yescomusa', 'yescom', 'vevor', 'costway', 'gymax', 'topbuy',
    // Rental / not shoppable
    'rental', 'rent', 'eventrent'
  ];
  
  function isJunk(source) {
    const s = (source || '').toLowerCase();
    return junkRetailers.some(j => s.includes(j));
  }

  try {
    // ============================================
    // STEP 1: Upload image for Google Lens
    // Try multiple hosts for reliability
    // ============================================
    let imageUrl = null;
    let lensProducts = []; // Products found by Google Lens
    let lensVisual = [];   // Visual matches from Lens
    let uploadMethod = 'none';

    if (SERP_KEY) {
      // Method 1: imgbb
      try {
        const formData = new URLSearchParams();
        formData.append('image', cleanImage);
        formData.append('expiration', '300');
        
        const uploadRes = await fetch('https://api.imgbb.com/1/upload?key=5e87bda0a1f4270c0813577d712e84e0', {
          method: 'POST',
          body: formData
        });
        
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          if (uploadData.data && uploadData.data.url) {
            imageUrl = uploadData.data.url;
            uploadMethod = 'imgbb';
          }
        }
      } catch (e) {}

      // Method 2: freeimage.host (backup)
      if (!imageUrl) {
        try {
          const formData2 = new URLSearchParams();
          formData2.append('source', cleanImage);
          formData2.append('type', 'base64');
          formData2.append('action', 'upload');
          
          const uploadRes2 = await fetch('https://freeimage.host/api/1/upload?key=6d207e02198a847aa98d0a2a901485a5', {
            method: 'POST',
            body: formData2
          });
          
          if (uploadRes2.ok) {
            const uploadData2 = await uploadRes2.json();
            if (uploadData2.image && uploadData2.image.url) {
              imageUrl = uploadData2.image.url;
              uploadMethod = 'freeimage';
            }
          }
        } catch (e) {}
      }

      // ============================================
      // STEP 2: Google Lens - visual matches + products
      // ============================================
      if (imageUrl) {
        // Search 1: Default (visual matches)
        try {
          const lensParams = new URLSearchParams({
            engine: 'google_lens',
            url: imageUrl,
            api_key: SERP_KEY,
            hl: 'en',
            country: 'us'
          });

          const lensRes = await fetch('https://serpapi.com/search.json?' + lensParams.toString());
          
          if (lensRes.ok) {
            const lensData = await lensRes.json();
            
            // Visual matches
            for (const vm of (lensData.visual_matches || []).slice(0, 20)) {
              if (!vm.link || isJunk(vm.source)) continue;
              lensVisual.push({
                title: vm.title || '',
                link: vm.link || '',
                source: vm.source || '',
                thumbnail: vm.thumbnail || '',
                price: vm.price ? parseFloat(String(vm.price.value || vm.price).replace(/[^0-9.]/g, '')) : 0
              });
            }

            // Shopping results if present
            for (const sr of (lensData.shopping_results || []).slice(0, 10)) {
              if (!sr.link || isJunk(sr.source)) continue;
              lensProducts.push({
                title: sr.title || '',
                link: sr.link || sr.product_link || '',
                source: sr.source || '',
                thumbnail: sr.thumbnail || '',
                price: sr.extracted_price || (sr.price ? parseFloat(String(sr.price).replace(/[^0-9.]/g, '')) : 0)
              });
            }
          }
        } catch (e) {}

        // Search 2: Products tab specifically
        try {
          const prodParams = new URLSearchParams({
            engine: 'google_lens',
            url: imageUrl,
            api_key: SERP_KEY,
            hl: 'en',
            country: 'us',
            type: 'products'
          });

          const prodRes = await fetch('https://serpapi.com/search.json?' + prodParams.toString());
          
          if (prodRes.ok) {
            const prodData = await prodRes.json();
            const existingLinks = new Set([...lensProducts, ...lensVisual].map(r => r.link));
            
            for (const pr of (prodData.visual_matches || prodData.shopping_results || []).slice(0, 15)) {
              const link = pr.link || pr.product_link || '';
              if (!link || existingLinks.has(link) || isJunk(pr.source)) continue;
              existingLinks.add(link);
              lensProducts.push({
                title: pr.title || '',
                link: link,
                source: pr.source || '',
                thumbnail: pr.thumbnail || '',
                price: pr.extracted_price || (pr.price ? parseFloat(String(pr.extracted_price || pr.price).replace(/[^0-9.]/g, '')) : 0)
              });
            }
          }
        } catch (e) {}
      }
    }

    const allLens = [...lensProducts, ...lensVisual];

    // ============================================
    // STEP 3: Claude identifies items + matches to Lens results
    // ============================================
    const lensContext = allLens.length > 0 
      ? `\n\nGoogle Lens found these products/matches for this image:\n${allLens.map((r, i) => `${i}. "${r.title}" — ${r.source} ${r.price ? '($' + r.price + ')' : ''}`).join('\n')}`
      : '';

    const identifyResponse = await fetch('https://api.anthropic.com/v1/messages', {
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
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: cleanImage }
            },
            {
              type: 'text',
              text: `You are a luxury home product expert. Identify every shoppable item in this image.
${lensContext}

Return ONLY valid JSON:
{
  "items": [
    {
      "name": "VERY specific product description — include brand if recognizable, exact pattern/motif, material, color",
      "exact_product": "The most precise product name for finding the EXACT item (e.g. 'Bitossi Four Leaf Clover plate ladybug gold rim' not 'green plate')",
      "similar_search": "A broader search to find SIMILAR items (e.g. 'green clover dinner plate gold rim')",
      "matched_lens_indices": [0, 3],
      "order": 1,
      "styling_tip": "brief tip"
    }
  ],
  "colors": [
    {"name": "Paint Name", "brand": "Farrow & Ball or Benjamin Moore or Sherwin-Williams", "code": "Code", "hex": "#hex"}
  ],
  "style_summary": "Brief style description"
}

CRITICAL RULES:
1. Be EXTREMELY specific. "Juliska Berry & Thread dinner plate Whitewash" not "white plate"
2. If you recognize a brand, NAME IT: Anthropologie, Juliska, MacKenzie-Childs, Vietri, etc.
3. For each Google Lens result that matches an item you see, include its index in matched_lens_indices
4. exact_product = find THIS specific product. similar_search = find products LIKE this one
5. Return ONLY JSON`
            }
          ]
        }]
      })
    });

    if (!identifyResponse.ok) {
      const err = await identifyResponse.text();
      return res.status(500).json({ error: 'Identify failed: ' + identifyResponse.status });
    }

    const identifyData = await identifyResponse.json();
    const identifyText = identifyData.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const identified = JSON.parse(identifyText);

    // ============================================
    // STEP 4: Build results — exact matches first, then similar
    // ============================================
    const itemsWithProducts = [];

    for (const item of identified.items) {
      const exactProducts = [];
      const similarProducts = [];
      const seenLinks = new Set();

      // A) Add Google Lens matches (these ARE exact matches)
      const matchedIndices = item.matched_lens_indices || [];
      for (const idx of matchedIndices) {
        if (idx >= 0 && idx < allLens.length) {
          const lr = allLens[idx];
          if (!lr.link || seenLinks.has(lr.link) || isJunk(lr.source)) continue;
          seenLinks.add(lr.link);
          exactProducts.push({
            title: lr.title,
            price: lr.price || 0,
            source: lr.source,
            link: lr.link,
            thumbnail: lr.thumbnail || '',
            isLensMatch: true
          });
        }
      }

      // B) Also check ALL lens results for keyword overlap with this item
      const itemWords = item.name.toLowerCase().split(/[\s,\-]+/).filter(w => w.length > 3);
      for (const lr of allLens) {
        if (!lr.link || seenLinks.has(lr.link) || isJunk(lr.source)) continue;
        const title = (lr.title || '').toLowerCase();
        const matchCount = itemWords.filter(w => title.includes(w)).length;
        if (matchCount >= 2) {
          seenLinks.add(lr.link);
          exactProducts.push({
            title: lr.title,
            price: lr.price || 0,
            source: lr.source,
            link: lr.link,
            thumbnail: lr.thumbnail || '',
            isLensMatch: true
          });
        }
      }

      // C) Google Shopping for EXACT product search
      if (SERP_KEY && item.exact_product) {
        try {
          const params = new URLSearchParams({
            engine: 'google_shopping',
            q: item.exact_product,
            api_key: SERP_KEY,
            num: 8,
            gl: 'us',
            hl: 'en'
          });
          const sr = await fetch('https://serpapi.com/search.json?' + params.toString());
          if (sr.ok) {
            const sd = await sr.json();
            for (const r of (sd.shopping_results || [])) {
              const link = r.product_link || r.link || '';
              if (!link || seenLinks.has(link) || isJunk(r.source)) continue;
              seenLinks.add(link);
              let price = 0;
              if (typeof r.extracted_price === 'number') price = r.extracted_price;
              else if (r.price) { const m = String(r.price).match(/[\d,.]+/); if (m) price = parseFloat(m[0].replace(',', '')); }
              
              exactProducts.push({
                title: r.title || '',
                price: price,
                source: r.source || '',
                link: link,
                thumbnail: r.thumbnail || '',
                isLensMatch: false
              });
            }
          }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 200));
      }

      // D) Google Shopping for SIMILAR items
      if (SERP_KEY && item.similar_search) {
        try {
          const params = new URLSearchParams({
            engine: 'google_shopping',
            q: item.similar_search,
            api_key: SERP_KEY,
            num: 6,
            gl: 'us',
            hl: 'en'
          });
          const sr = await fetch('https://serpapi.com/search.json?' + params.toString());
          if (sr.ok) {
            const sd = await sr.json();
            for (const r of (sd.shopping_results || [])) {
              const link = r.product_link || r.link || '';
              if (!link || seenLinks.has(link) || isJunk(r.source)) continue;
              seenLinks.add(link);
              let price = 0;
              if (typeof r.extracted_price === 'number') price = r.extracted_price;
              else if (r.price) { const m = String(r.price).match(/[\d,.]+/); if (m) price = parseFloat(m[0].replace(',', '')); }
              
              similarProducts.push({
                title: r.title || '',
                price: price,
                source: r.source || '',
                link: link,
                thumbnail: r.thumbnail || '',
                isLensMatch: false
              });
            }
          }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 200));
      }

      // Combine: exact first (lens matches at top), then similar
      const allProducts = [
        ...exactProducts.slice(0, 6),
        ...similarProducts.slice(0, 4)
      ];

      itemsWithProducts.push({
        name: item.name,
        order: item.order || 1,
        styling_tip: item.styling_tip || '',
        search_query: item.exact_product || item.name,
        exactCount: Math.min(exactProducts.length, 6),
        products: allProducts
      });
    }

    return res.status(200).json({
      items: itemsWithProducts,
      colors: identified.colors || [],
      style_summary: identified.style_summary || '',
      lens_used: !!imageUrl,
      lens_matches: allLens.length,
      upload_method: uploadMethod
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed: ' + err.message });
  }
}
