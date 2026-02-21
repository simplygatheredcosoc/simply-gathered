export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const SERP_KEY = process.env.SERPAPI_KEY;
  if (!SERP_KEY) return res.status(500).json({ error: 'SERPAPI_KEY not set' });

  try {
    const body = req.body || {};
    const query = body.query;
    if (!query) return res.status(400).json({ error: 'No query' });

    // Search with high-end bias by appending quality terms
    const highEndQuery = query + ' designer luxury high end';
    
    // Do two searches: one high-end biased, one normal for price range
    const urls = [
      'https://serpapi.com/search.json?engine=google_shopping&q=' + encodeURIComponent(highEndQuery) + '&api_key=' + SERP_KEY + '&num=6&gl=us&hl=en',
      'https://serpapi.com/search.json?engine=google_shopping&q=' + encodeURIComponent(query) + '&api_key=' + SERP_KEY + '&num=6&gl=us&hl=en'
    ];

    const [highEndRes, normalRes] = await Promise.all(urls.map(u => fetch(u).then(r => r.json()).catch(() => ({}))));
    
    const allResults = [
      ...(highEndRes.shopping_results || []),
      ...(normalRes.shopping_results || [])
    ];

    // High-end retailer rankings (higher = shown first)
    const retailerTier = {
      // Ultra luxury
      'over the moon': 11,
      'mytheresa': 11,
      'net-a-porter': 11, 'net a porter': 11,
      'shopbop': 11,
      'matchesfashion': 11, 'matches fashion': 11,
      'goop': 11,
      'moda operandi': 11,
      '1stdibs': 11,
      'chairish': 11,
      'the realreal': 11,
      'vivrelle': 11,
      'bergdorf': 11,
      'saks': 11, 'saks fifth': 11,
      'neiman marcus': 11,
      // Premium home
      'serena & lily': 10, 'serena and lily': 10,
      'one kings lane': 10,
      'rejuvenation': 10,
      'mcgee & co': 10, 'mcgee and co': 10, 'studio mcgee': 10,
      'arhaus': 10,
      'rh': 10, 'restoration hardware': 10,
      'anthropologie': 10,
      'terrain': 10,
      'lulu and georgia': 10, 'lulu & georgia': 10,
      'burke decor': 10,
      'perigold': 10,
      'circa lighting': 10,
      'visual comfort': 10,
      'aerin': 10,
      'mark and graham': 10,
      'lake pajamas': 10,
      'loeffler randall': 10,
      'alice + olivia': 10,
      'tory burch': 10,
      'ethan allen': 10,
      'schumacher': 10,
      'lee jofa': 10,
      // Premium mid
      'williams sonoma': 9, 'williams-sonoma': 9,
      'pottery barn': 9,
      'west elm': 9,
      'crate & barrel': 9, 'crate and barrel': 9,
      'cb2': 9,
      'ballard designs': 9,
      'nordstrom': 9,
      'bloomingdale': 9,
      'liberty london': 9,
      'john derian': 9,
      'astier de villatte': 9,
      'the citizenry': 9,
      'schoolhouse': 9,
      'food52': 9,
      'heath ceramics': 9,
      'east fork': 9,
      'hawkins new york': 9,
      'roman and williams': 9,
      'brook farm general': 9,
      // Quality mid
      'etsy': 8,
      'wayfair': 7,
      'world market': 7,
      'pier 1': 7,
      'macy': 7,
      'zara home': 7,
      'h&m home': 7,
      'target': 6,
      'amazon': 5,
      'overstock': 5,
      'walmart': 3,
      'temu': 0,
      'shein': 0,
      'aliexpress': 0,
      'wish': 0
    };

    // Retailer search URL patterns
    const retailerUrls = {
      // Ultra luxury
      'over the moon': 'https://www.overthemoon.com/search?q=',
      'mytheresa': 'https://www.mytheresa.com/en-us/search?q=',
      'net-a-porter': 'https://www.net-a-porter.com/en-us/shop/search/',
      'net a porter': 'https://www.net-a-porter.com/en-us/shop/search/',
      'shopbop': 'https://www.shopbop.com/s?searchTerm=',
      'matchesfashion': 'https://www.matchesfashion.com/us/search?q=',
      'goop': 'https://goop.com/search?q=',
      'moda operandi': 'https://www.modaoperandi.com/search?q=',
      '1stdibs': 'https://www.1stdibs.com/search/?q=',
      'chairish': 'https://www.chairish.com/shop?q=',
      'the realreal': 'https://www.therealreal.com/search?q=',
      'bergdorf': 'https://www.bergdorfgoodman.com/search?q=',
      'saks': 'https://www.saksfifthavenue.com/search?q=',
      'neiman': 'https://www.neimanmarcus.com/en-us/search?q=',
      // Premium home
      'serena': 'https://www.serenaandlily.com/search?q=',
      'one kings lane': 'https://www.onekingslane.com/search?q=',
      'rejuvenation': 'https://www.rejuvenation.com/search?query=',
      'mcgee': 'https://mcgeeandco.com/search?q=',
      'studio mcgee': 'https://mcgeeandco.com/search?q=',
      'arhaus': 'https://www.arhaus.com/search?q=',
      'restoration hardware': 'https://rh.com/search/results.jsp?query=',
      'rh.com': 'https://rh.com/search/results.jsp?query=',
      'anthropologie': 'https://www.anthropologie.com/search?q=',
      'terrain': 'https://www.shopterrain.com/search?q=',
      'lulu and georgia': 'https://www.luluandgeorgia.com/search?q=',
      'lulu & georgia': 'https://www.luluandgeorgia.com/search?q=',
      'burke decor': 'https://www.burkedecor.com/search?q=',
      'perigold': 'https://www.perigold.com/keyword.php?keyword=',
      'circa lighting': 'https://www.circalighting.com/search/?q=',
      'mark and graham': 'https://www.markandgraham.com/search/?q=',
      'ethan allen': 'https://www.ethanallen.com/search?q=',
      'john derian': 'https://www.johnderian.com/search?q=',
      'the citizenry': 'https://www.the-citizenry.com/search?q=',
      'schoolhouse': 'https://www.schoolhouse.com/search?q=',
      'food52': 'https://food52.com/shop/search?q=',
      'heath ceramics': 'https://www.heathceramics.com/search?q=',
      'east fork': 'https://www.eastfork.com/search?q=',
      'hawkins new york': 'https://www.hawkinsnewyork.com/search?q=',
      // Premium mid
      'williams sonoma': 'https://www.williams-sonoma.com/search/?q=',
      'williams-sonoma': 'https://www.williams-sonoma.com/search/?q=',
      'pottery barn': 'https://www.potterybarn.com/search/?q=',
      'west elm': 'https://www.westelm.com/search/?q=',
      'crate & barrel': 'https://www.crateandbarrel.com/search?query=',
      'crate and barrel': 'https://www.crateandbarrel.com/search?query=',
      'cb2': 'https://www.cb2.com/search?query=',
      'ballard designs': 'https://www.ballarddesigns.com/search?q=',
      'nordstrom': 'https://www.nordstrom.com/sr?keyword=',
      'bloomingdale': 'https://www.bloomingdales.com/shop/search?keyword=',
      'liberty': 'https://www.libertylondon.com/search?q=',
      'zara home': 'https://www.zarahome.com/search?q=',
      // Standard
      'etsy': 'https://www.etsy.com/search?q=',
      'amazon': 'https://www.amazon.com/s?k=',
      'target': 'https://www.target.com/s?searchTerm=',
      'walmart': 'https://www.walmart.com/search?q=',
      'wayfair': 'https://www.wayfair.com/keyword.php?keyword=',
      'ikea': 'https://www.ikea.com/us/en/search/?q=',
      'h&m': 'https://www2.hm.com/en_us/search-results.html?q=',
      'overstock': 'https://www.overstock.com/search?keywords=',
      'home depot': 'https://www.homedepot.com/s/',
      'lowe': 'https://www.lowes.com/search?searchTerm=',
      'world market': 'https://www.worldmarket.com/search?q=',
      'macy': 'https://www.macys.com/shop/featured/',
      'pier 1': 'https://www.pier1.com/search?q=',
      'tory burch': 'https://www.toryburch.com/en-us/search?q='
    };

    function getRetailerUrl(source, q) {
      var src = (source || '').toLowerCase();
      for (var key in retailerUrls) {
        if (src.includes(key)) {
          return retailerUrls[key] + encodeURIComponent(q);
        }
      }
      return null;
    }

    function getTier(source) {
      var src = (source || '').toLowerCase();
      for (var key in retailerTier) {
        if (src.includes(key)) return retailerTier[key];
      }
      return 5; // default mid-tier
    }

    function isGoodLink(u) {
      return u && u.length > 10 && u.startsWith('http') && 
        !u.includes('google.com/aclk') && 
        !u.includes('google.com/url') && 
        !u.includes('googleadservices') &&
        !u.includes('google.com/shopping');
    }

    // Process and deduplicate results
    var seen = {};
    var processed = [];
    
    for (var i = 0; i < allResults.length; i++) {
      var r = allResults[i];
      var source = r.source || '';
      var srcLower = source.toLowerCase();
      
      // Skip low-quality retailers
      if (srcLower.includes('temu') || srcLower.includes('shein') || srcLower.includes('aliexpress') || srcLower.includes('wish.com') || srcLower.includes('dhgate') || srcLower.includes('banggood') || srcLower.includes('light in the box')) continue;
      
      // Skip duplicates from same retailer
      if (seen[srcLower]) continue;
      seen[srcLower] = true;

      // Get the best link: direct product URL > retailer search
      var link = '';
      if (isGoodLink(r.product_link)) {
        link = r.product_link;
      } else if (isGoodLink(r.link)) {
        link = r.link;
      } else {
        link = getRetailerUrl(source, query) || 'https://www.google.com/search?tbm=shop&q=' + encodeURIComponent(source + ' ' + query);
      }

      // Also always include the retailer search URL as a fallback
      var retailerSearchUrl = getRetailerUrl(source, query) || link;

      var price = 0;
      if (typeof r.extracted_price === 'number') price = r.extracted_price;
      else if (r.price) {
        var m = String(r.price).match(/[\d,.]+/);
        if (m) price = parseFloat(m[0].replace(',', ''));
      }

      processed.push({
        title: r.title || '',
        price: price,
        source: source,
        link: link,
        retailerSearch: retailerSearchUrl,
        thumbnail: r.thumbnail || '',
        tier: getTier(source)
      });
    }

    // Sort by tier (high-end first), then by price descending
    processed.sort(function(a, b) {
      if (b.tier !== a.tier) return b.tier - a.tier;
      return b.price - a.price;
    });

    return res.status(200).json({ results: processed.slice(0, 8) });
  } catch (err) {
    return res.status(500).json({ error: 'Search failed: ' + err.message });
  }
}
