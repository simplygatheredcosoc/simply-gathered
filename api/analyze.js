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

  const OPENAI_KEY = process.env.OPENAI_API_KEY; // switched to ChatGPT/OpenAI
  const SERP_KEY = process.env.SERPAPI_KEY;

  if (!OPENAI_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  }

  let image, mediaType, ltkProducts, shopmyProducts;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    image = body.image;
    mediaType = body.mediaType || 'image/jpeg';
    ltkProducts = Array.isArray(body.ltkProducts) ? body.ltkProducts : [];
    shopmyProducts = Array.isArray(body.shopmyProducts) ? body.shopmyProducts : [];
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  if (!image) return res.status(400).json({ error: 'No image' });

  const cleanImage = image.replace(/^data:image\/\w+;base64,/, '');
  const log = [];

  // ---------- small helpers ----------
  function safeNum(v) {
    const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function normalizeExternalProduct(p, sourceLabel) {
    if (!p) return null;
    const title = (p.title || p.product_name || p.name || '').trim();
    const link = (p.link || p.url || p.product_link || p.affiliate_link || '').trim();
    if (!title || !link) return null;

    return {
      id: p.id || null,
      title,
      source: sourceLabel,
      retailer: (p.retailer || p.store || p.brand || '').trim(),
      link,
      thumbnail: (p.image || p.thumbnail || p.image_url || '').trim(),
      price: safeNum(p.price || p.estimated_price || p.sale_price),
      brand: (p.brand || '').trim(),
      item_type: (p.item_type || '').trim(),
      material: (p.material || '').trim(),
      color: (p.color || '').trim(),
      shape: (p.shape || '').trim(),
      style_tags: Array.isArray(p.style_tags) ? p.style_tags.slice(0, 8) : []
    };
  }

  function cleanupJsonText(text) {
    if (!text) return '';
    return String(text)
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
  }

  function tryParseJson(text) {
    const cleaned = cleanupJsonText(text);
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      let fixed = cleaned.replace(/,\s*$/, '');

      const openBraces = (fixed.match(/{/g) || []).length;
      const closeBraces = (fixed.match(/}/g) || []).length;
      const openBrackets = (fixed.match(/\[/g) || []).length;
      const closeBrackets = (fixed.match(/\]/g) || []).length;

      for (let i = 0; i < openBrackets - closeBrackets; i++) fixed += ']';
      for (let i = 0; i < openBraces - closeBraces; i++) fixed += '}';

      return JSON.parse(fixed);
    }
  }

  try {
    // ═══════════════════════════════════════════════
    // STEP 1: Upload image for Google Lens
    // ═══════════════════════════════════════════════
    let imageUrl = null;

    // freeimage.host first
    try {
      const form = new URLSearchParams();
      form.append('source', cleanImage);
      form.append('type', 'base64');
      form.append('action', 'upload');

      const r = await fetch('https://freeimage.host/api/1/upload?key=6d207e02198a847aa98d0a2a901485a5', {
        method: 'POST',
        body: form
      });

      if (r.ok) {
        const d = await r.json();
        if (d?.image?.url) {
          imageUrl = d.image.url;
          log.push('upload:freeimage');
        }
      } else {
        log.push('freeimage-fail:' + r.status);
      }
    } catch (e) {
      log.push('freeimage-err');
    }

    // Backup: imgbb
    if (!imageUrl) {
      try {
        const form = new URLSearchParams();
        form.append('image', cleanImage);
        form.append('expiration', '600');

        const r = await fetch('https://api.imgbb.com/1/upload?key=5e87bda0a1f4270c0813577d712e84e0', {
          method: 'POST',
          body: form
        });

        if (r.ok) {
          const d = await r.json();
          if (d?.data?.url) {
            imageUrl = d.data.url;
            log.push('upload:imgbb');
          }
        } else {
          log.push('imgbb-fail:' + r.status);
        }
      } catch (e) {
        log.push('imgbb-err');
      }
    }

    // ═══════════════════════════════════════════════
    // STEP 2: Google Lens exact-match candidates
    // ═══════════════════════════════════════════════
    let lensResults = [];

    if (SERP_KEY && imageUrl) {
      try {
        const p = new URLSearchParams({
          engine: 'google_lens',
          url: imageUrl,
          api_key: SERP_KEY,
          hl: 'en',
          country: 'us'
        });

        const r = await fetch('https://serpapi.com/search.json?' + p.toString());
        if (r.ok) {
          const d = await r.json();

          for (const vm of (d.visual_matches || []).slice(0, 40)) {
            if (!vm.link) continue;
            lensResults.push({
              title: vm.title || '',
              link: vm.link,
              source: vm.source || '',
              thumbnail: vm.thumbnail || '',
              price: vm.price ? safeNum(vm.price.value || vm.price) : 0
            });
          }

          for (const sr of (d.shopping_results || []).slice(0, 20)) {
            const link = sr.link || sr.product_link || '';
            if (!link) continue;
            lensResults.push({
              title: sr.title || '',
              link,
              source: sr.source || '',
              thumbnail: sr.thumbnail || '',
              price: safeNum(sr.extracted_price || sr.price)
            });
          }

          // dedupe by link
          const seen = new Set();
          lensResults = lensResults.filter((x) => {
            if (!x.link || seen.has(x.link)) return false;
            seen.add(x.link);
            return true;
          });

          log.push('lens:' + lensResults.length + ' matches');
        } else {
          log.push('lens-fail:' + r.status);
        }
      } catch (e) {
        log.push('lens-err');
      }
    }

    // ═══════════════════════════════════════════════
    // STEP 3: Normalize LTK + ShopMy candidate pools
    // ═══════════════════════════════════════════════
    const externalProducts = [];
    for (const p of ltkProducts) {
      const n = normalizeExternalProduct(p, 'LTK');
      if (n) externalProducts.push(n);
    }
    for (const p of shopmyProducts) {
      const n = normalizeExternalProduct(p, 'ShopMy');
      if (n) externalProducts.push(n);
    }

    // Deduplicate external pool by link
    const seenExternal = new Set();
    const dedupedExternalProducts = externalProducts.filter((p) => {
      const k = (p.link || '').toLowerCase();
      if (!k || seenExternal.has(k)) return false;
      seenExternal.add(k);
      return true;
    });

    log.push('external:' + dedupedExternalProducts.length);

    // Keep prompt size manageable
    const lensPromptList = lensResults.slice(0, 35).map((r, i) => ({
      lens_index: i,
      title: r.title,
      source: r.source,
      link: r.link,
      thumbnail: r.thumbnail,
      price: r.price || 0
    }));

    const externalPromptList = dedupedExternalProducts.slice(0, 120).map((p, i) => ({
      candidate_index: i,
      source_pool: p.source, // LTK / ShopMy
      title: p.title,
      retailer: p.retailer || '',
      brand: p.brand || '',
      link: p.link,
      thumbnail: p.thumbnail || '',
      price: p.price || 0,
      item_type: p.item_type || '',
      material: p.material || '',
      color: p.color || '',
      shape: p.shape || '',
      style_tags: p.style_tags || []
    }));

    // ═══════════════════════════════════════════════
    // STEP 4: OpenAI (ChatGPT) identifies items + picks exact + similar
    //         IMPORTANT: Similar items are chosen ONLY from provided pool
    // ═══════════════════════════════════════════════
    const promptText = `
You are an expert visual merchandiser and home/tablescape product matcher.

TASK
1) Identify every SHOPS-RELEVANT item in the image (plates, chargers, napkins, glasses, flatware, linens, candlesticks, vases, lamps, pillows, decor, furniture, wallpaper, etc.)
2) For each identified item, choose the BEST exact match from the Google Lens candidates (if truly exact/near-exact)
3) For each identified item, choose 2-4 CLOSE similar products ONLY from the PROVIDED external candidate pool (LTK + ShopMy)
4) Be strict. Recommendations must match object type first, then shape, color, material, and style.

VERY IMPORTANT MATCHING RULES
- NEVER match across object types (plate ≠ napkin, glass ≠ candle holder, wallpaper ≠ fabric, etc.)
- Exact match should be null if no true exact/near-exact exists
- Each Google Lens candidate may be used only ONCE as an exact match across all items
- Similar recommendations must come ONLY from external_candidates (LTK/ShopMy). Do NOT invent products.
- Prefer similarity in this order:
  1. object_type
  2. shape/silhouette (scalloped, fluted, coupe, round, pleated, etc.)
  3. color and finish (emerald velvet, gold rim, matte glaze, clear cut crystal)
  4. material (ceramic, linen, brass, glass, velvet)
  5. style vibe (vintage, botanical, French cottage, coastal, traditional, etc.)
- If external candidates are weak for an item, return fewer recommendations (even zero) rather than bad ones.

OUTPUT FORMAT
Return ONLY valid JSON in this exact shape:
{
  "items": [
    {
      "name": "Specific item name",
      "order": 1,
      "item_type": "plate|charger|napkin|glassware|flatware|tablecloth|vase|candleholder|wallpaper|lamp|pillow|rug|art|chair|table|other",
      "attributes": {
        "color": "main color",
        "material": "material",
        "shape": "shape/silhouette",
        "finish": "finish/detail"
      },
      "styling_tip": "brief styling tip",
      "exact_match": {
        "lens_index": 0,
        "confidence": 93,
        "title": "Title copied from lens candidate",
        "source": "Source copied from lens candidate",
        "link": "URL copied from lens candidate",
        "thumbnail": "Thumbnail copied from lens candidate",
        "price": 0,
        "evidence": ["why it matches", "why it matches"]
      },
      "similar_items": [
        {
          "candidate_index": 0,
          "source_pool": "LTK",
          "title": "Title copied from external candidate",
          "retailer": "Retailer copied from external candidate",
          "link": "URL copied from external candidate",
          "thumbnail": "Thumbnail copied from external candidate",
          "price": 0,
          "why": "Specific reason this is similar"
        }
      ]
    }
  ],
  "colors": [
    {"name":"Color name","brand":"Benjamin Moore","code":"HC-172","hex":"#HEX"}
  ],
  "style_summary": "Brief style summary"
}

If no exact match exists for an item, set "exact_match": null.

GOOGLE_LENS_CANDIDATES:
${JSON.stringify(lensPromptList)}

EXTERNAL_CANDIDATES (LTK + ShopMy only):
${JSON.stringify(externalPromptList)}
`.trim();

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_KEY
      },
      body: JSON.stringify({
        model: 'gpt-5',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are a strict product-matching assistant. Return only JSON.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: promptText
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mediaType};base64,${cleanImage}`
                }
              }
            ]
          }
        ]
      })
    });

    if (!openaiRes.ok) {
      const errTxt = await openaiRes.text().catch(() => '');
      return res.status(500).json({
        error: 'OpenAI failed: ' + openaiRes.status,
        details: errTxt.slice(0, 500),
        log: log.join(' | ')
      });
    }

    const openaiData = await openaiRes.json();
    const modelText =
      openaiData?.choices?.[0]?.message?.content ||
      openaiData?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments ||
      '';

    let identified;
    try {
      identified = tryParseJson(modelText);
    } catch (e) {
      return res.status(500).json({
        error: 'Could not parse AI JSON response',
        ai_preview: String(modelText).slice(0, 1000),
        log: log.join(' | ')
      });
    }

    log.push('items:' + ((identified.items || []).length));

    // ═══════════════════════════════════════════════
    // STEP 5: Build final UI results (same-ish format as your current UI)
    //         - exact comes from Google Lens
    //         - similars come from LTK/ShopMy candidate pools
    // ═══════════════════════════════════════════════
    const items = (identified.items || []).map((item, idx) => {
      const products = [];
      let exactCount = 0;

      // Exact match from lens candidates
      if (item.exact_match && typeof item.exact_match.lens_index === 'number') {
        const i = item.exact_match.lens_index;
        if (i >= 0 && i < lensPromptList.length) {
          const lr = lensPromptList[i];
          products.push({
            title: lr.title || item.exact_match.title || '',
            price: lr.price || item.exact_match.price || 0,
            source: lr.source || item.exact_match.source || '',
            link: lr.link || item.exact_match.link || '',
            thumbnail: lr.thumbnail || item.exact_match.thumbnail || '',
            isExact: true,
            confidence: item.exact_match.confidence || 0,
            evidence: Array.isArray(item.exact_match.evidence) ? item.exact_match.evidence : []
          });
          exactCount = 1;
        }
      }

      // Similars ONLY from external candidates
      const usedLinks = new Set(products.map(p => (p.link || '').toLowerCase()));
      for (const sim of (item.similar_items || []).slice(0, 6)) {
        let chosen = null;

        if (typeof sim.candidate_index === 'number' && sim.candidate_index >= 0 && sim.candidate_index < externalPromptList.length) {
          chosen = externalPromptList[sim.candidate_index];
        } else if (sim.link) {
          // fallback link lookup
          chosen = externalPromptList.find((p) => p.link === sim.link) || null;
        }

        if (!chosen) continue;
        const linkKey = (chosen.link || '').toLowerCase();
        if (!linkKey || usedLinks.has(linkKey)) continue;
        usedLinks.add(linkKey);

        products.push({
          title: chosen.title || sim.title || '',
          price: chosen.price || sim.price || 0,
          source: chosen.source_pool || sim.source_pool || 'External',
          retailer: chosen.retailer || sim.retailer || '',
          link: chosen.link || sim.link || '',
          thumbnail: chosen.thumbnail || sim.thumbnail || '',
          isExact: false,
          why: sim.why || ''
        });
      }

      return {
        name: item.name || `Item ${idx + 1}`,
        order: item.order || idx + 1,
        item_type: item.item_type || 'other',
        attributes: item.attributes || {},
        styling_tip: item.styling_tip || '',
        search_query: item.name || '',
        exactCount,
        products
      };
    });

    return res.status(200).json({
      items,
      colors: Array.isArray(identified.colors) ? identified.colors : [],
      style_summary: identified.style_summary || '',
      lens_used: !!imageUrl,
      lens_total: lensResults.length,
      external_pool_total: dedupedExternalProducts.length,
      log: log.join(' | ')
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, log: log.join(' | ') });
  }
}
