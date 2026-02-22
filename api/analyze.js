export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    maxDuration: 120
  }
};

// ---------- Helpers ----------
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stripCodeFences(text) {
  if (!text) return '';
  return String(text)
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

function normalizePrice(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function dedupeByLink(arr) {
  const seen = new Set();
  return (arr || []).filter((x) => {
    const key = (x.link || '').trim();
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function encodeQ(q) {
  return encodeURIComponent(q || '');
}

function retailerSearchUrl(source, query) {
  const q = encodeQ(query);
  const s = (source || '').toLowerCase();

  if (s.includes('anthropologie')) return `https://www.anthropologie.com/search?q=${q}`;
  if (s.includes('pottery barn')) return `https://www.potterybarn.com/search/results.html?words=${q}`;
  if (s.includes('williams sonoma')) return `https://www.williams-sonoma.com/search/results.html?words=${q}`;
  if (s.includes('west elm')) return `https://www.westelm.com/search/results.html?words=${q}`;
  if (s.includes('crate') || s.includes('cb2')) return `https://www.crateandbarrel.com/search?query=${q}`;
  if (s.includes('target')) return `https://www.target.com/s?searchTerm=${q}`;
  if (s.includes('etsy')) return `https://www.etsy.com/search?q=${q}`;
  if (s.includes('amazon')) return `https://www.amazon.com/s?k=${q}`;
  if (s.includes('wayfair')) return `https://www.wayfair.com/keyword.php?keyword=${q}`;
  if (s.includes('serena')) return `https://www.serenaandlily.com/search?q=${q}`;
  if (s.includes('juliska')) return `https://www.juliska.com/search?type=product&q=${q}`;
  if (s.includes('sur la table')) return `https://www.surlatable.com/search/?q=${q}`;

  // Helpful for ShopMy / LTK / unknown sources
  return `https://www.google.com/search?q=${encodeQ(`${query} ${source}`)}`;
}

function looksLikeAllowedRecommendationSource(source) {
  const s = (source || '').toLowerCase();
  const allowed = [
    'anthropologie', 'pottery barn', 'williams sonoma', 'west elm',
    'crate & barrel', 'crate and barrel', 'cb2', 'serena & lily', 'serena',
    'mcgee', 'rejuvenation', 'schoolhouse', 'one kings lane', 'arhaus',
    'terrain', 'lulu and georgia', 'burke decor', 'ballard designs',
    'etsy', 'chairish', 'target', 'nordstrom', 'bloomingdale', 'juliska',
    'vietri', 'mackenzie-childs', 'sur la table', 'food52', 'wayfair',
    'amazon', 'world market', 'replacements', 'east fork', 'heath ceramics',
    'minted', 'ruggable', 'loloi',
    // Added for your request:
    'shopmy', 'shop my', 'liketoknowit', 'like to know it', 'ltk'
  ];
  return allowed.some((a) => s.includes(a));
}

async function fetchWithRetry(url, options, retries = 2, backoffMs = 1000) {
  let lastRes = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    lastRes = await fetch(url, options);

    // Retry only transient errors / rate limits
    if (![429, 500, 502, 503, 504].includes(lastRes.status)) return lastRes;
    if (attempt === retries) return lastRes;

    const wait = backoffMs * Math.pow(2, attempt); // 1s, 2s, 4s...
    await new Promise((r) => setTimeout(r, wait));
  }
  return lastRes;
}

function extractOpenAIText(data) {
  // Supports Chat Completions format
  return (
    data?.choices?.[0]?.message?.content ||
    ''
  );
}

// ---------- API Handler ----------
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
    image = body?.image;
    mediaType = body?.mediaType || 'image/jpeg';
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  if (!image) return res.status(400).json({ error: 'No image' });

  const cleanImage = String(image).replace(/^data:image\/\w+;base64,/, '');
  const log = [];

  try {
    // ═══════════════════════════════════════════════
    // STEP 1: Upload image for Google Lens (SerpApi)
    // ═══════════════════════════════════════════════
    let imageUrl = null;

    // freeimage.host (primary)
    try {
      const form = new URLSearchParams();
      form.append('source', cleanImage);
      form.append('type', 'base64');
      form.append('action', 'upload');

      const r = await fetchWithRetry(
        'https://freeimage.host/api/1/upload?key=6d207e02198a847aa98d0a2a901485a5',
        { method: 'POST', body: form },
        1
      );

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

    // imgbb (backup)
    if (!imageUrl) {
      try {
        const form = new URLSearchParams();
        form.append('image', cleanImage);
        form.append('expiration', '600');

        const r = await fetchWithRetry(
          'https://api.imgbb.com/1/upload?key=5e87bda0a1f4270c0813577d712e84e0',
          { method: 'POST', body: form },
          1
        );

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
    // STEP 2: Google Lens (visual matches + shopping results)
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

        const r = await fetchWithRetry('https://serpapi.com/search.json?' + p.toString(), {
          method: 'GET'
        });

        if (r.ok) {
          const d = await r.json();

          const visual = (d.visual_matches || []).slice(0, 40).map((vm) => ({
            title: vm.title || '',
            link: vm.link || '',
            source: vm.source || '',
            thumbnail: vm.thumbnail || '',
            price: vm.price ? normalizePrice(vm.price.value || vm.price) : 0
          }));

          const shopping = (d.shopping_results || []).slice(0, 20).map((sr) => ({
            title: sr.title || '',
            link: sr.link || sr.product_link || '',
            source: sr.source || '',
            thumbnail: sr.thumbnail || '',
            price: normalizePrice(sr.extracted_price || sr.price || 0)
          }));

          lensResults = dedupeByLink([...visual, ...shopping]).filter((x) => x.link);
          log.push('lens:' + lensResults.length + ' matches');
        } else {
          log.push('lens-fail:' + r.status);
        }
      } catch (e) {
        log.push('lens-err');
      }
    } else {
      if (!SERP_KEY) log.push('no-serp-key');
      if (!imageUrl) log.push('no-image-url-for-lens');
    }

    // ═══════════════════════════════════════════════
    // STEP 3: OpenAI identifies items + exact matches + better recommendations
    // ═══════════════════════════════════════════════
    const lensContext =
      lensResults.length > 0
        ? `\n\nGoogle Lens candidate results (use ONLY these for exact matches):\n` +
          lensResults
            .map((r, i) => {
              return `${i}. "${r.title}" | source: ${r.source || 'Unknown'}${
                r.price ? ` | price: $${r.price}` : ''
              } | link: ${r.link}`;
            })
            .join('\n')
        : `\n\nNo Google Lens results were available. You may still identify items, but exact_match should be null for all items.`;

    const openaiPrompt = `You are a precision visual shopping matcher for home decor, tablescapes, and interior styling.

Goal:
1) Identify the distinct shoppable items visible in the image.
2) For EACH item, choose the BEST exact replacement candidate from the Google Lens list (if truly the same item).
3) Recommend 2-4 visually CLOSE replacements inspired by the exact match (shape, material, rim detail, color, finish, silhouette, vibe).

IMPORTANT EXACT-MATCH RULES:
- Exact means same object type AND highly similar design details (not just same category).
- Never match a plate result to napkins/glassware/flatware/etc.
- If uncertain, set exact_match to null.
- Do not reuse the same Lens result for multiple items.
- Prefer candidates with matching silhouette, edge detail, material, finish, and color.
- Include "evidence" and "rejected_candidates" so the UI can explain why.

RECOMMENDATION QUALITY RULES:
- Recommendations must be VERY close to the exact match (not generic alternatives).
- Mirror key details: scalloped vs plain rim, coupe vs rimmed plate, fluted vs smooth glass, brass vs silver finish, linen weave, floral scale/pattern style, etc.
- If exact_match exists, use it as the anchor. Mention why each recommendation is close.
- Sources for recommendations can include approved retailers plus ShopMy / LTK-inspired sources. If unsure of exact product URL, use a source-specific search URL.
- Keep recommendations practical and shoppable.

Approved / preferred sources for recommendations:
Anthropologie, Pottery Barn, Williams Sonoma, West Elm, Crate & Barrel, CB2, Serena & Lily, McGee & Co, Rejuvenation, Schoolhouse, One Kings Lane, Arhaus, Terrain, Lulu and Georgia, Burke Decor, Ballard Designs, Etsy, Chairish, Target, Nordstrom, Bloomingdale's, Juliska, Vietri, MacKenzie-Childs, Sur La Table, Food52, Wayfair, Amazon, World Market, Replacements Ltd, East Fork, Heath Ceramics, Minted, Ruggable, Loloi, ShopMy, LTK (LikeToKnowIt)

${lensContext}

Return ONLY valid JSON in this exact shape:
{
  "item_matches": [
    {
      "item_id": "item_01",
      "item_name": "scalloped ceramic dinner plate",
      "match_type": "exact|none",
      "confidence": 93,
      "exact_match": {
        "lens_index": 4,
        "title": "Scalloped Stoneware Dinner Plate",
        "source": "Anthropologie",
        "link": "https://...",
        "thumbnail": "https://...",
        "price": 24
      },
      "evidence": [
        "Object type matches dinner plate",
        "Scalloped rim shape matches",
        "Color and glaze finish appear consistent"
      ],
      "rejected_candidates": [
        { "lens_index": 2, "reason": "Glassware, wrong object type" }
      ],
      "styling_tip": "brief styling tip",
      "recommendations": [
        {
          "title": "Product name",
          "source": "Anthropologie",
          "search_query": "ivory scalloped stoneware dinner plate",
          "search_url": "https://www.anthropologie.com/search?q=ivory%20scalloped%20stoneware%20dinner%20plate",
          "estimated_price": 22,
          "why": "Matches the scalloped rim and creamy glazed finish"
        }
      ]
    }
  ],
  "colors": [
    { "name": "Warm Ivory", "brand": "Benjamin Moore", "code": "OC-95", "hex": "#F2EDE3" }
  ],
  "style_summary": "Brief style description"
}`;

    const openaiPayload = {
      model: 'gpt-4o', // changed from gpt-5 to reduce 429/model-access issues
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are meticulous, conservative about exact matches, and prioritize visual precision over guessing.'
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: openaiPrompt
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mediaType};base64,${cleanImage}`,
                detail: 'high'
              }
            }
          ]
        }
      ]
    };

    const openaiRes = await fetchWithRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + OPENAI_KEY
        },
        body: JSON.stringify(openaiPayload)
      },
      2
    );

    if (!openaiRes.ok) {
      let errJson = null;
      let errTxt = '';
      try {
        errJson = await openaiRes.json();
      } catch (e) {
        try {
          errTxt = await openaiRes.text();
        } catch (_) {}
      }

      return res.status(500).json({
        error: 'OpenAI failed: ' + openaiRes.status,
        openai_error: errJson || errTxt || 'Unknown error',
        log: log.join(' | ')
      });
    }

    const openaiData = await openaiRes.json();
    const rawText = extractOpenAIText(openaiData);
    const cleanedText = stripCodeFences(rawText);

    let identified = safeJsonParse(cleanedText);

    if (!identified) {
      // last-resort bracket fix attempt
      let fixed = cleanedText.replace(/,\s*$/, '');
      const openBraces = (fixed.match(/{/g) || []).length;
      const closeBraces = (fixed.match(/}/g) || []).length;
      const openBrackets = (fixed.match(/\[/g) || []).length;
      const closeBrackets = (fixed.match(/\]/g) || []).length;

      for (let i = 0; i < openBrackets - closeBrackets; i++) fixed += ']';
      for (let i = 0; i < openBraces - closeBraces; i++) fixed += '}';

      identified = safeJsonParse(fixed);
    }

    if (!identified || !Array.isArray(identified.item_matches)) {
      return res.status(500).json({
        error: 'Could not parse OpenAI JSON response',
        raw_preview: cleanedText.slice(0, 1200),
        log: log.join(' | ')
      });
    }

    log.push('items:' + identified.item_matches.length);

    // ═══════════════════════════════════════════════
    // STEP 4: Build final UI-friendly results
    // ═══════════════════════════════════════════════
    const items = (identified.item_matches || []).map((item, idx) => {
      const products = [];

      // exact match (from lens only)
      const em = item.exact_match;
      const validLensIndex =
        em &&
        typeof em.lens_index === 'number' &&
        em.lens_index >= 0 &&
        em.lens_index < lensResults.length;

      if (validLensIndex) {
        const lr = lensResults[em.lens_index];
        products.push({
          title: lr.title || em.title || '',
          price: lr.price || normalizePrice(em.price) || 0,
          source: lr.source || em.source || '',
          link: lr.link || em.link || '',
          thumbnail: lr.thumbnail || em.thumbnail || '',
          isExact: true,
          why: (item.evidence || []).join(' • ')
        });
      } else if (em && em.link) {
        // Fallback if model gave a usable exact_match object
        products.push({
          title: em.title || '',
          price: normalizePrice(em.price),
          source: em.source || '',
          link: em.link || '',
          thumbnail: em.thumbnail || '',
          isExact: true,
          why: (item.evidence || []).join(' • ')
        });
      }

      // close recommendations
      for (const rec of (item.recommendations || []).slice(0, 6)) {
        const source = rec.source || 'Retailer';
        const searchQuery = rec.search_query || item.item_name || '';
        const searchUrl =
          rec.search_url ||
          retailerSearchUrl(source, searchQuery);

        products.push({
          title: rec.title || searchQuery || 'Similar item',
          price: normalizePrice(rec.estimated_price),
          source,
          link: searchUrl,
          thumbnail: '',
          isExact: false,
          why: rec.why || '',
          search_query: searchQuery
        });
      }

      return {
        id: item.item_id || `item_${String(idx + 1).padStart(2, '0')}`,
        name: item.item_name || `Item ${idx + 1}`,
        order: idx + 1,
        match_type: item.match_type || (products.some((p) => p.isExact) ? 'exact' : 'none'),
        confidence: typeof item.confidence === 'number' ? item.confidence : 0,
        styling_tip: item.styling_tip || '',
        evidence: Array.isArray(item.evidence) ? item.evidence : [],
        rejected_candidates: Array.isArray(item.rejected_candidates) ? item.rejected_candidates : [],
        exactCount: products.some((p) => p.isExact) ? 1 : 0,
        products: products.filter((p) => p.link)
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
      error: err?.message || 'Unknown server error',
      log: log.join(' | ')
    });
  }
}
