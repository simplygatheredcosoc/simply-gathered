
export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    maxDuration: 120
  }
};

function safeNumber(v, fallback = 0) {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function stripCodeFences(text) {
  return String(text || '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

function tryParseJson(text) {
  const cleaned = stripCodeFences(text);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // light repair for truncated JSON
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

function buildRetailerSearchUrl(source, query) {
  const q = encodeURIComponent(query || '');
  const s = (source || '').toLowerCase();

  if (s.includes('anthropologie')) return `https://www.anthropologie.com/search?q=${q}`;
  if (s.includes('pottery')) return `https://www.potterybarn.com/search/results.html?words=${q}`;
  if (s.includes('williams')) return `https://www.williams-sonoma.com/search/results.html?words=${q}`;
  if (s.includes('west elm')) return `https://www.westelm.com/search/results.html?words=${q}`;
  if (s.includes('crate')) return `https://www.crateandbarrel.com/search?query=${q}`;
  if (s.includes('cb2')) return `https://www.cb2.com/search?query=${q}`;
  if (s.includes('serena')) return `https://www.serenaandlily.com/search?q=${q}`;
  if (s.includes('terrain')) return `https://www.terrain.com/search?q=${q}`;
  if (s.includes('target')) return `https://www.target.com/s?searchTerm=${q}`;
  if (s.includes('etsy')) return `https://www.etsy.com/search?q=${q}`;
  if (s.includes('amazon')) return `https://www.amazon.com/s?k=${q}`;
  if (s.includes('wayfair')) return `https://www.wayfair.com/keyword.php?keyword=${q}`;
  if (s.includes('juliska')) return `https://www.juliska.com/search?type=product&q=${q}`;
  if (s.includes('sur la table') || s.includes('surlatable')) return `https://www.surlatable.com/search/?q=${q}`;

  // fallback generic Google Shopping search
  return `https://www.google.com/search?tbm=shop&q=${q}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const SERP_KEY = process.env.SERPAPI_KEY;

  if (!OPENAI_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  }

  let image, mediaType;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    image = body.image;
    mediaType = body.mediaType || 'image/jpeg';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (!image) return res.status(400).json({ error: 'No image provided' });

  const cleanImage = String(image).replace(/^data:image\/\w+;base64,/, '');
  const log = [];
  let lensResults = [];
  let imageUrl = null;

  try {
    // ──────────────────────────────────────────────
    // STEP 1: Upload image so Google Lens (SerpAPI) can inspect it
    // ──────────────────────────────────────────────
    // Try freeimage.host first
    try {
      const form = new URLSearchParams();
      form.append('source', cleanImage);
      form.append('type', 'base64');
      form.append('action', 'upload');

      const r = await fetch(
        'https://freeimage.host/api/1/upload?key=6d207e02198a847aa98d0a2a901485a5',
        { method: 'POST', body: form }
      );

      if (r.ok) {
        const d = await r.json();
        if (d?.image?.url) {
          imageUrl = d.image.url;
          log.push('upload:freeimage');
        } else {
          log.push('freeimage:no-url');
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

        const r = await fetch(
          'https://api.imgbb.com/1/upload?key=5e87bda0a1f4270c0813577d712e84e0',
          { method: 'POST', body: form }
        );

        if (r.ok) {
          const d = await r.json();
          if (d?.data?.url) {
            imageUrl = d.data.url;
            log.push('upload:imgbb');
          } else {
            log.push('imgbb:no-url');
          }
        } else {
          log.push('imgbb-fail:' + r.status);
        }
      } catch (e) {
        log.push('imgbb-err');
      }
    }

    // ──────────────────────────────────────────────
    // STEP 2: Google Lens / SerpAPI results
    // ──────────────────────────────────────────────
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
            if (!vm?.link) continue;
            lensResults.push({
              title: vm.title || '',
              link: vm.link || '',
              source: vm.source || '',
              thumbnail: vm.thumbnail || '',
              price: vm.price ? safeNumber(vm.price.value || vm.price, 0) : 0,
              origin: 'visual_match'
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
              price: safeNumber(sr.extracted_price || sr.price, 0),
              origin: 'shopping_result'
            });
          }

          // Deduplicate by link
          const seen = new Set();
          lensResults = lensResults.filter((x) => {
            const k = (x.link || '').trim();
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
          });

          log.push(`lens:${lensResults.length}`);
        } else {
          log.push('lens-fail:' + r.status);
        }
      } catch (e) {
        log.push('lens-err');
      }
    } else {
      if (!SERP_KEY) log.push('no-serp-key');
      if (!imageUrl) log.push('no-upload-url');
    }

    // ──────────────────────────────────────────────
    // STEP 3: ChatGPT vision + strict exact-match logic
    // ──────────────────────────────────────────────
    const lensText = lensResults.length
      ? lensResults
          .map(
            (r, i) =>
              `${i}. ${r.title || 'Untitled'} | source: ${r.source || 'unknown'} | price: ${
                r.price || ''
              } | link: ${r.link}`
          )
          .join('\n')
      : 'No Google Lens candidates available.';

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + OPENAI_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4.1',
        temperature: 0.15,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a luxury home and tablescape product matcher. Prioritize exactness over completeness. Never confuse object types (plate vs napkin vs glassware). If unsure, return no exact match.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Analyze this inspiration image and identify distinct shoppable items.

GOALS
1) Identify each item (plate, charger, napkin, glassware, flatware, candles, linen, etc.)
2) Choose the BEST exact match from Google Lens candidates ONLY if truly exact
3) Recommend 2-3 VERY CLOSE alternatives (shape/material/color/trim should be close)

STRICT RULES
- Match object type first
- Do not reuse the same Google Lens result for multiple items
- If not truly exact, set exact_match = null
- "Similar" items must be visually close, not just same theme
- Confidence is 0-100 and should be honest

APPROVED RETAILERS FOR SIMILARS
Anthropologie, Pottery Barn, Williams Sonoma, West Elm, Crate & Barrel, CB2,
Serena & Lily, McGee & Co, Rejuvenation, Schoolhouse, One Kings Lane, Arhaus,
Terrain, Lulu and Georgia, Burke Decor, Ballard Designs, Etsy, Chairish,
Target, Nordstrom, Bloomingdale's, Juliska, Vietri, MacKenzie-Childs,
Sur La Table, Food52, Wayfair, Amazon, World Market, Replacements Ltd,
East Fork, Heath Ceramics, Minted, Ruggable, Loloi

GOOGLE LENS CANDIDATES
${lensText}

Return ONLY valid JSON:
{
  "item_matches": [
    {
      "item_id": "item_01",
      "item_name": "scalloped ceramic dinner plate with clover motif and gold rim",
      "item_type": "plate",
      "match_type": "exact",
      "confidence": 93,
      "exact_match": {
        "lens_index": 4,
        "title": "Scalloped Stoneware Dinner Plate",
        "source": "Anthropologie",
        "link": "https://example.com",
        "thumbnail": "",
        "price": 38
      },
      "evidence": ["Object type matches plate", "Scalloped rim matches", "Gold trim and motif align"],
      "rejected_candidates": [
        { "lens_index": 2, "reason": "Glassware, wrong object type" }
      ],
      "styling_tip": "Pair with a solid charger so the motif stays the focal point.",
      "similar_items": [
        {
          "title": "Botanical Scalloped Dinner Plate",
          "source": "Anthropologie",
          "search_url": "https://www.anthropologie.com/search?q=botanical%20scalloped%20dinner%20plate",
          "estimated_price": 22,
          "why": "Similar scalloped silhouette and hand-painted botanical feel"
        }
      ]
    }
  ],
  "colors": [
    { "name": "Emerald Green", "brand": "Generic", "code": "", "hex": "#0F5A43" }
  ],
  "style_summary": "Short style summary"
}`
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
      const errTxt = await openaiRes.text();
      return res.status(500).json({
        error: 'OpenAI failed: ' + openaiRes.status,
        details: errTxt,
        log: log.join(' | ')
      });
    }

    const openaiData = await openaiRes.json();
    const aiText = openaiData?.choices?.[0]?.message?.content || '';
    const identified = tryParseJson(aiText);

    // Normalize AI shape
    const itemMatches = Array.isArray(identified.item_matches)
      ? identified.item_matches
      : Array.isArray(identified.items)
      ? identified.items
      : [];

    log.push('ai_items:' + itemMatches.length);

    // ──────────────────────────────────────────────
    // STEP 4: Build UI-friendly results
    // ──────────────────────────────────────────────
    const usedLensIndexes = new Set();
    const items = itemMatches.map((m, idx) => {
      const products = [];

      // exact match
      let exactMatch = m.exact_match;
      if (
        exactMatch &&
        typeof exactMatch === 'object' &&
        typeof exactMatch.lens_index === 'number' &&
        exactMatch.lens_index >= 0 &&
        exactMatch.lens_index < lensResults.length &&
        !usedLensIndexes.has(exactMatch.lens_index)
      ) {
        const lr = lensResults[exactMatch.lens_index];
        usedLensIndexes.add(exactMatch.lens_index);

        products.push({
          title: lr.title || exactMatch.title || '',
          price: lr.price || safeNumber(exactMatch.price, 0),
          source: lr.source || exactMatch.source || '',
          link: lr.link || exactMatch.link || '',
          thumbnail: lr.thumbnail || exactMatch.thumbnail || '',
          isExact: true
        });
      } else if (
        exactMatch &&
        exactMatch.link &&
        typeof exactMatch.lens_index !== 'number'
      ) {
        // fallback if model returned a link but no valid index
        products.push({
          title: exactMatch.title || '',
          price: safeNumber(exactMatch.price, 0),
          source: exactMatch.source || '',
          link: exactMatch.link || '',
          thumbnail: exactMatch.thumbnail || '',
          isExact: true
        });
      }

      // similar items
      for (const sim of (m.similar_items || []).slice(0, 5)) {
        const title = sim?.title || '';
        const source = sim?.source || '';
        const query = title || m.item_name || '';
        products.push({
          title,
          price: safeNumber(sim?.estimated_price, 0),
          source,
          link: sim?.search_url || buildRetailerSearchUrl(source, query),
          thumbnail: '',
          isExact: false,
          why: sim?.why || ''
        });
      }

      return {
        name: m.item_name || `Item ${idx + 1}`,
        item_type: m.item_type || 'other',
        order: idx + 1,
        match_type: m.match_type || (products.some((p) => p.isExact) ? 'exact' : 'none'),
        confidence: typeof m.confidence === 'number' ? m.confidence : 0,
        evidence: Array.isArray(m.evidence) ? m.evidence : [],
        rejected_candidates: Array.isArray(m.rejected_candidates) ? m.rejected_candidates : [],
        styling_tip: m.styling_tip || '',
        search_query: m.item_name || '',
        exactCount: products.some((p) => p.isExact) ? 1 : 0,
        products
      };
    });

    return res.status(200).json({
      items,
      colors: Array.isArray(identified.colors) ? identified.colors : [],
      style_summary: identified.style_summary || '',
      lens_used: !!imageUrl,
      lens_total: lensResults.length,
      log: log.join(' | ')
    });
  } catch (err) {
    return res.status(500).json({
      error: err?.message || 'Unknown error',
      log: log.join(' | ')
    });
  }
}
