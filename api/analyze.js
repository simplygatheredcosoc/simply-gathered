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

  try {
    // ============================================
    // STEP 1: Upload image to temp host for Google Lens
    // We use imgbb.com free API for temporary hosting
    // ============================================
    let imageUrl = null;
    let lensResults = [];

    if (SERP_KEY) {
      try {
        // Upload to imgbb (free, no key needed for basic upload)
        const formData = new URLSearchParams();
        formData.append('image', cleanImage);
        formData.append('expiration', '300'); // 5 min expiry
        
        const uploadRes = await fetch('https://api.imgbb.com/1/upload?key=5e87bda0a1f4270c0813577d712e84e0', {
          method: 'POST',
          body: formData
        });
        
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          if (uploadData.data && uploadData.data.url) {
            imageUrl = uploadData.data.url;
          }
        }
      } catch (e) {
        // If imgbb fails, try a data URL approach
        console.log('Image upload failed, skipping Google Lens');
      }

      // ============================================
      // STEP 2: Google Lens visual search on the full image
      // Do TWO searches: visual_matches (exact) and products (shopping)
      // ============================================
      if (imageUrl) {
        try {
          // First: visual matches (finds exact items)
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
            
            const visualMatches = lensData.visual_matches || [];
            for (const vm of visualMatches.slice(0, 15)) {
              lensResults.push({
                title: vm.title || '',
                link: vm.link || '',
                source: vm.source || '',
                thumbnail: vm.thumbnail || '',
                price: vm.price ? parseFloat(String(vm.price.value || vm.price).replace(/[^0-9.]/g, '')) : 0,
                type: 'visual'
              });
            }

            const shopResults = lensData.shopping_results || [];
            for (const sr of shopResults.slice(0, 10)) {
              lensResults.push({
                title: sr.title || '',
                link: sr.link || '',
                source: sr.source || '',
                thumbnail: sr.thumbnail || '',
                price: sr.extracted_price || (sr.price ? parseFloat(String(sr.price).replace(/[^0-9.]/g, '')) : 0),
                type: 'shopping'
              });
            }
          }
        } catch (e) {
          console.log('Google Lens search failed:', e.message);
        }

        // Second: products tab specifically
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
            const prodResults = prodData.visual_matches || prodData.shopping_results || [];
            const existingLinks = new Set(lensResults.map(r => r.link));
            
            for (const pr of prodResults.slice(0, 10)) {
              const link = pr.link || '';
              if (existingLinks.has(link)) continue;
              existingLinks.add(link);
              lensResults.push({
                title: pr.title || '',
                link: link,
                source: pr.source || '',
                thumbnail: pr.thumbnail || '',
                price: pr.extracted_price || pr.price ? parseFloat(String(pr.extracted_price || pr.price).replace(/[^0-9.]/g, '')) : 0,
                type: 'product'
              });
            }
          }
        } catch (e) {
          console.log('Google Lens products search failed:', e.message);
        }
      }
    }

    // ============================================
    // STEP 3: Claude identifies all items in the image
    // Include Google Lens results so Claude can match them
    // ============================================
    const lensContext = lensResults.length > 0 
      ? `\n\nGoogle Lens found these products in this image (use these as reference for matching items):\n${lensResults.map((r, i) => `${i+1}. "${r.title}" from ${r.source} ${r.price ? '($' + r.price + ')' : ''} - ${r.link}`).join('\n')}`
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
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: cleanImage }
            },
            {
              type: 'text',
              text: `Identify every shoppable item in this image. Be EXTREMELY specific about patterns, motifs, materials, colors, brands.
${lensContext}

Return ONLY valid JSON:
{
  "items": [
    {
      "name": "Very specific product description",
      "google_lens_query": "most specific search query for Google Shopping",
      "backup_queries": ["broader query 1", "category query 2"],
      "matched_lens_indices": [0, 3],
      "order": 1,
      "styling_tip": "brief tip"
    }
  ],
  "colors": [
    {"name": "Paint Name", "brand": "Farrow & Ball or Benjamin Moore or Sherwin-Williams", "code": "Code", "hex": "#hex"}
  ],
  "style_summary": "Brief style"
}

CRITICAL:
- Be as specific as possible: "Bitossi porcelain four leaf clover plate with ladybug gold rim" NOT "green plate"
- If Google Lens results match items in the image, include the matching indices in "matched_lens_indices"
- For items NOT found by Google Lens, provide the most specific search query possible
- Return ONLY JSON`
            }
          ]
        }]
      })
    });

    if (!identifyResponse.ok) {
      const err = await identifyResponse.text();
      return res.status(500).json({ error: 'Identify failed: ' + identifyResponse.status, details: err.substring(0, 300) });
    }

    const identifyData = await identifyResponse.json();
    const identifyText = identifyData.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const identified = JSON.parse(identifyText);

    // ============================================
    // STEP 4: Build products for each item
    // Use Google Lens matches first, then fill with Google Shopping
    // ============================================
    const tierMap = {
      'anthropologie': 10, 'serena': 10, 'one kings lane': 10, 'rejuvenation': 10,
      'mcgee': 10, 'arhaus': 10, 'rh.com': 10, 'restoration': 10, 'good neighbour': 10,
      'williams': 9, 'pottery barn': 9, 'west elm': 9, 'crate': 9, 'cb2': 9,
      'ballard': 9, 'terrain': 9, 'lulu': 9, 'burke': 9, 'nordstrom': 9,
      'bloomingdale': 9, 'saks': 9, 'neiman': 9, 'chairish': 9, '1stdibs': 9,
      'over the moon': 10, 'shopbop': 10, 'mytheresa': 10, 'goop': 10,
      'schoolhouse': 9, 'food52': 9, 'liberty': 9, 'john derian': 9,
      'replacements': 8, 'wayfair': 7, 'etsy': 8, 'ebay': 6,
      'target': 6, 'amazon': 5, 'walmart': 3
    };

    const itemsWithProducts = [];

    for (const item of identified.items) {
      const products = [];
      const seenLinks = new Set();

      // First: add matched Google Lens results (these are the EXACT matches)
      const matchedIndices = item.matched_lens_indices || [];
      for (const idx of matchedIndices) {
        if (idx >= 0 && idx < lensResults.length) {
          const lr = lensResults[idx];
          if (lr.link && !seenLinks.has(lr.link)) {
            seenLinks.add(lr.link);
            const source = lr.source || new URL(lr.link).hostname.replace('www.', '');
            if (source.toLowerCase().includes('temu') || source.toLowerCase().includes('shein') || 
                source.toLowerCase().includes('aliexpress')) continue;
            products.push({
              title: lr.title,
              price: lr.price || 0,
              source: lr.source || source,
              link: lr.link,
              thumbnail: lr.thumbnail || '',
              isLensMatch: true
            });
          }
        }
      }

      // Also check all lens results for any that match this item's name
      for (const lr of lensResults) {
        if (!lr.link || seenLinks.has(lr.link)) continue;
        const title = (lr.title || '').toLowerCase();
        const itemWords = item.name.toLowerCase().split(' ').filter(w => w.length > 3);
        const matchCount = itemWords.filter(w => title.includes(w)).length;
        if (matchCount >= 2) {
          seenLinks.add(lr.link);
          const source = lr.source || '';
          if (source.toLowerCase().includes('temu') || source.toLowerCase().includes('shein')) continue;
          products.push({
            title: lr.title,
            price: lr.price || 0,
            source: source,
            link: lr.link,
            thumbnail: lr.thumbnail || '',
            isLensMatch: true
          });
        }
      }

      // Second: fill remaining slots with Google Shopping text search
      if (products.length < 6 && SERP_KEY) {
        const queries = [item.google_lens_query, ...(item.backup_queries || [])];
        
        for (let qi = 0; qi < Math.min(queries.length, 2) && products.length < 8; qi++) {
          const query = queries[qi];
          if (!query) continue;
          
          try {
            const params = new URLSearchParams({
              engine: 'google_shopping',
              q: query,
              api_key: SERP_KEY,
              num: 8,
              gl: 'us',
              hl: 'en'
            });

            const searchRes = await fetch('https://serpapi.com/search.json?' + params.toString());
            
            if (searchRes.ok) {
              const searchData = await searchRes.json();
              const results = searchData.shopping_results || [];
              
              for (const r of results) {
                const link = r.product_link || r.link || '';
                if (seenLinks.has(link)) continue;
                seenLinks.add(link);
                
                const source = (r.source || '').toLowerCase();
                if (source.includes('temu') || source.includes('shein') || 
                    source.includes('aliexpress') || source.includes('wish.com')) continue;

                let price = 0;
                if (typeof r.extracted_price === 'number') price = r.extracted_price;
                else if (r.price) {
                  const m = String(r.price).match(/[\d,.]+/);
                  if (m) price = parseFloat(m[0].replace(',', ''));
                }

                products.push({
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
          
          if (qi < queries.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
      }

      // Sort: Lens matches first, then by retailer tier
      products.sort((a, b) => {
        // Lens matches always first
        if (a.isLensMatch && !b.isLensMatch) return -1;
        if (!a.isLensMatch && b.isLensMatch) return 1;
        
        const aSource = (a.source || '').toLowerCase();
        const bSource = (b.source || '').toLowerCase();
        let aTier = 5, bTier = 5;
        for (const [key, val] of Object.entries(tierMap)) {
          if (aSource.includes(key)) aTier = val;
          if (bSource.includes(key)) bTier = val;
        }
        return bTier - aTier;
      });

      itemsWithProducts.push({
        name: item.name,
        order: item.order || 1,
        styling_tip: item.styling_tip || '',
        search_query: item.google_lens_query || item.name,
        products: products.slice(0, 8)
      });
    }

    return res.status(200).json({
      items: itemsWithProducts,
      colors: identified.colors || [],
      style_summary: identified.style_summary || '',
      lens_used: !!imageUrl,
      lens_matches: lensResults.length
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed: ' + err.message });
  }
}
