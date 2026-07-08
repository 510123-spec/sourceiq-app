// Product Source Search Engine - Backend
// Calls Google Custom Search API and classifies each result as
// "manufacturer" or "distributor" using keyword + domain heuristics.
// Falls back to bundled demo data automatically if no API key is configured,
// so the app is usable immediately and upgrades to live results once a key is added.

const express = require('express');
const compression = require('compression');
const path = require('path');
const cheerio = require('cheerio');
const session = require('express-session');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3000;

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX     = process.env.GOOGLE_CX;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const OPENAI_KEY    = process.env.OPENAI_API_KEY  || '';
const GEMINI_KEY    = process.env.GEMINI_API_KEY  || '';
const LIVE_MODE     = Boolean((GOOGLE_API_KEY && GOOGLE_CX) || BRAVE_API_KEY);
const AI_PROVIDER   = OPENAI_KEY ? 'openai' : GEMINI_KEY ? 'gemini' : null;

const LOGIN_USER = process.env.LOGIN_USER || 'admin';
const LOGIN_PASS = process.env.LOGIN_PASS || 'sourceiq2024';

app.set('trust proxy', 1);
app.use(compression()); // gzip responses — the dashboard HTML alone is ~260KB uncompressed
app.use(express.json({ limit: '10mb' })); // image identification uploads base64 photos
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'sourceiq-secret',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: { maxAge: 8 * 60 * 60 * 1000, secure: false } // 8 hours
}));

// Auth middleware — protects everything except login page and its assets
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.path === '/login' || req.path === '/login.html') return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login');
}

app.get('/login', (req, res) => {
  if (req.session && req.session.loggedIn) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === LOGIN_USER && password === LOGIN_PASS) {
    req.session.loggedIn = true;
    req.session.username = username;
    return req.session.save(() => res.redirect('/'));
  }
  return res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- Classification heuristics ----
const MANUFACTURER_HINTS = [
  'manufacturer', 'manufacturing', 'factory', 'factories', 'oem', 'odm', 'ems',
  'producer', 'production', 'production plant', 'production facility', 'production line',
  'mill', 'mills', 'fabricator', 'fabrication', 'plant', 'foundry', 'forge', 'casting',
  'made in', 'we manufacture', 'our factory', 'our plant', 'mfg', 'mfr',
  'iso 9001', 'iso certified', 'gmp certified', 'ce certified',
  'exporter', 'direct from factory', 'factory direct', 'factory price',
  'injection molding', 'stamping', 'machining', 'assembly line', 'production capacity',
  'r&d', 'research and development', 'patented', 'own brand', 'private label',
  'since 19', 'since 20', 'established in', 'founded in', 'years of experience',
  'metric ton', 'metric tons', 'annual capacity', 'monthly output'
];

const DISTRIBUTOR_HINTS = [
  'distributor', 'distribution', 'wholesaler', 'wholesale',
  'reseller', 'trading co', 'trading company', 'trading ltd', 'trade co',
  'stockist', 'sourcing agent', 'sourcing company', 'procurement agent',
  'authorized dealer', 'authorized distributor', 'dealer network',
  'multi-brand', 'multi brand', 'multiple brands', 'various brands', 'brands available',
  'in stock', 'stock available', 'ready stock', 'ex-stock', 'surplus stock',
  'minimum order', 'bulk order', 'bulk supply', 'bulk discount',
  'same day dispatch', 'next day delivery',
  'alibaba', 'made-in-china', 'indiamart', 'global sources', 'tradeindia',
  'buy online', 'add to cart', 'shop now'
  // Note: 'supplier', 'suppliers', 'export', 'import' removed — too common on manufacturer pages
];

const MANUFACTURER_URL_HINTS = [
  '/about-us', '/about', '/our-factory', '/manufacturing', '/production', '/facility',
  '/products/', '/product/', '/catalog', '/capabilities'
];

const DOMAIN_HINTS = {
  // These directories specifically focus on verifying/listing manufacturers
  manufacturer: [
    'thomasnet.com', 'globalspec.com', 'manufacturers.com', 'mfgpages.com'
  ],
  // B2B marketplaces and distributor/trading platforms
  distributor: [
    'alibaba.com', 'aliexpress.com', 'indiamart.com', 'made-in-china.com',
    'tradeindia.com', 'ec21.com', 'amazon.com', 'ebay.com', 'globaltrademart.com',
    'tradekey.com', 'exportersindia.com', 'dhgate.com', 'global-sources.com',
    'goldsupplier.com', '1688.com', 'diytrade.com',
    // B2B directories (list both — treat as neutral/distributor-leaning)
    'europages.com', 'europages.co.uk', 'kompass.com', 'directindustry.com',
    'exporters.sg', 'go4worldbusiness.com', 'tradewheel.com'
  ]
};

// Domains that are noise for supplier search — news, wikis, marketplaces we don't want
const NOISE_DOMAINS = [
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com',
  'youtube.com', 'pinterest.com', 'reddit.com', 'quora.com',
  'wikipedia.org', 'wikihow.com', 'wikidata.org',
  'amazon.com', 'ebay.com', 'etsy.com',
  'yelp.com', 'tripadvisor.com', 'yellowpages.com',
  'trustpilot.com', 'glassdoor.com',
  'indeed.com', 'linkedin.com', 'monster.com',
  'news.google.com', 'reuters.com', 'bloomberg.com', 'bbc.com', 'cnn.com',
  'sciencedirect.com', 'researchgate.net', 'scholar.google.com'
];

// Directory / data-aggregator domains. They host profiles for MANY companies, so an
// address scraped from them often belongs to a different entity than the one searched —
// we must NOT present their scraped street addresses as authoritative.
const AGGREGATOR_DOMAINS = [
  'zoominfo.com', 'crunchbase.com', 'bloomberg.com', 'dnb.com', 'dunsregistered.com',
  'rocketreach.co', 'theorg.com', 'comparably.com', 'globaldata.com', 'craft.co',
  'cbinsights.com', 'pitchbook.com', 'owler.com', 'apollo.io', 'leadiq.com',
  'sgpbusiness.com', 'opencorporates.com', 'importer.usaypage.com', 'addressadda.com',
  'clodura.ai', 'signalhire.com', 'lusha.com', 'kompass.com', 'europages.com',
  'tradeindia.com', 'indiamart.com', 'exportersindia.com', 'justdial.com',
  'startupnationcentral.org', 'tofler.in', 'zaubacorp.com',
  'exporters.sg', 'go4worldbusiness.com', 'tradewheel.com'
];
function isAggregatorHost(host = '') {
  const h = host.toLowerCase().replace(/^www\./, '');
  return AGGREGATOR_DOMAINS.some(d => h === d || h.endsWith('.' + d) || h.includes(d));
}

// Strip common legal/entity suffixes so "Erez Pte Ltd" → "Erez" for brand matching & queries.
function stripLegalSuffix(name = '') {
  return name
    .replace(/[.,]/g, ' ')
    .replace(/\b(pte|pvt|priv|private|public|co|company|corp|corporation|inc|incorporated|ltd|limited|llc|llp|lp|plc|gmbh|ag|sa|srl|bv|nv|oy|ab|as|sas|sdn|bhd|kk|pty|sl|spa|s\.?p\.?a)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classify(title, snippet, displayLink = '', url = '') {
  const titleLc   = title.toLowerCase();
  const snippetLc = snippet.toLowerCase();
  const host      = displayLink.toLowerCase().replace(/^www\./, '');
  const urlLc     = url.toLowerCase();

  // Title signals carry 3× more weight than snippet signals
  const titleText   = titleLc;
  const snippetText = snippetLc;

  let manuScore = 0;
  let distScore = 0;

  for (const k of MANUFACTURER_HINTS) {
    const w = k.length > 8 ? 2 : 1;
    if (titleText.includes(k))   manuScore += w * 3;
    if (snippetText.includes(k)) manuScore += w;
  }
  for (const k of DISTRIBUTOR_HINTS) {
    const w = k.length > 8 ? 2 : 1;
    if (titleText.includes(k))   distScore += w * 3;
    if (snippetText.includes(k)) distScore += w;
  }

  // Domain name carries very strong signal
  if (/manufactur|factory|industri|production|mfg|mfr|mill|fabricat|forge|casting/.test(host)) manuScore += 12;
  if (/distribut|wholesale|trading|import|export|supplier|supply|sourcing/.test(host))          distScore += 12;

  // Known manufacturer-focused directories
  if (DOMAIN_HINTS.manufacturer.some(d => host.includes(d))) manuScore += 6;
  // B2B marketplace / distributor sites
  if (DOMAIN_HINTS.distributor.some(d => host.includes(d)))  distScore += 8;

  // URL path signals (manufacturer site structure)
  if (MANUFACTURER_URL_HINTS.some(p => urlLc.includes(p))) manuScore += 4;

  // B2B marketplace listing pages: almost always distributor-type
  if (/alibaba|indiamart|made-in-china|tradeindia|ec21|dhgate|global.?sources|tradekey|goldsupplier/.test(host)) {
    distScore += 10;
  }

  // ccTLD signals: .cn = Chinese manufacturer/exporter is common; .co.in = India supplier
  if (host.endsWith('.cn') || host.includes('.com.cn')) manuScore += 4;

  // Strong title phrases (regex for higher precision)
  if (/\b(manufacturer|manufactures|manufacturing|factory|oem|odm|foundry|mill|forge)\b/.test(titleLc)) manuScore += 8;
  if (/\b(distributor|distributes|wholesale|wholesaler|reseller|stockist|trading co)\b/.test(titleLc))   distScore += 8;

  // Page contains contact/quote call-to-action — leans manufacturer or distributor
  if (/request.{0,10}quote|send.{0,10}inquiry|rfq|get.{0,8}price/i.test(snippetText)) manuScore += 3;
  if (/in.?stock|ready.?stock|same.?day.?dispatch|bulk.?discount/i.test(snippetText))  distScore += 4;

  // Weak fallback: generic "supplier/supply" wording was deliberately excluded above
  // (too common on both manufacturer and distributor pages to be a strong signal), but
  // a page that mentions it and triggers NOTHING else is still more likely a distributor/
  // trading page than truly unclassifiable — nudge it rather than giving up entirely.
  let weakFallback = false;
  if (manuScore === 0 && distScore === 0) {
    if (/\bsuppl(?:y|ier|iers)\b/.test(titleText) || /\bsuppl(?:y|ier|iers)\b/.test(snippetText)) {
      distScore += 2;
      weakFallback = true;
    }
  }

  // If both scores are still zero — genuinely cannot determine
  if (manuScore === 0 && distScore === 0) {
    return { type: 'unclassified', confidence: 0 };
  }

  const total = manuScore + distScore;
  const type  = manuScore >= distScore ? 'manufacturer' : 'distributor';
  const margin = Math.max(manuScore, distScore) / Math.max(total, 1); // 0.5–1.0

  // Confidence: starts at 50%, scaled by how decisive the margin is.
  // A margin of 0.5 (tie) → 50%. A margin of 1.0 (all on one side) → 97%.
  // The weak "supplier"-only fallback above is a guess, not a real signal — cap it
  // low so the UI doesn't present it with false certainty.
  const confidence = weakFallback ? 55 : Math.min(97, Math.round(50 + margin * 47));

  // If confidence is below 60%, still classify but mark it weaker
  return { type, confidence };
}

// ---- Demo data fallback (used when no API key is configured) ----
// Includes sample contact details (phone/email/address/key people) so the
// "company details" feature has something to display without needing to
// scrape example.com placeholder links.
const DEMO_DATA = [
  {keywords:["led","bulb","light","lighting"], country:"China", title:"BrightCore Industries", link:"https://example.com/brightcore", displayLink:"brightcore-industries.example.com", snippet:"Factory-direct manufacturer of LED bulbs and lighting components. OEM/ODM, ISO 9001 certified.", type:"manufacturer", confidence:95,
    phone:"+86 755 1234 5678", whatsapp:"+86 138 0013 8000", email:"sales@brightcore-industries.example.com", address:"88 Bao'an Road, Shenzhen, Guangdong, China", keyPeople:[{name:"Li Wei", title:"CEO"},{name:"Zhang Min", title:"Sales Director"}],
    employeeCount:"320", companySize:"Large (250+ employees)", founded:"2008"},
  {keywords:["led","bulb","light","lighting"], country:"India", title:"Volt & Glow Supply Co.", link:"https://example.com/voltglow", displayLink:"voltglow.example.com", snippet:"Wholesale distributor stocking LED bulbs from multiple manufacturers. Fast shipping, multi-brand.", type:"distributor", confidence:92,
    phone:"+91 22 4001 7766", whatsapp:"+91 98765 43210", email:"info@voltglow.example.com", address:"14 Andheri Industrial Estate, Mumbai, Maharashtra, India", keyPeople:[{name:"Raj Patel", title:"Founder"},{name:"Anita Sharma", title:"Operations Manager"}],
    employeeCount:"45", companySize:"Small (under 50 employees)", founded:"2014"},
  {keywords:["plastic","bottle","packaging"], country:"USA", title:"PolyForm Manufacturing", link:"https://example.com/polyform", displayLink:"polyform.example.com", snippet:"Injection-molding manufacturer of plastic bottles and containers. Custom molds, food-grade.", type:"manufacturer", confidence:96,
    phone:"+1 713 555 0148", email:"contact@polyform.example.com", address:"4500 Industrial Pkwy, Houston, TX 77029, USA", keyPeople:[{name:"Mark Reynolds", title:"President"},{name:"Susan Lee", title:"Plant Manager"}],
    employeeCount:"180", companySize:"Medium (50–250 employees)", founded:"1991"},
  {keywords:["plastic","bottle","packaging"], country:"Netherlands", title:"PackLine Distributors", link:"https://example.com/packline", displayLink:"packline.example.com", snippet:"Regional distributor of packaging materials including plastic bottles. Warehouse stock, EU logistics.", type:"distributor", confidence:90,
    phone:"+31 10 234 5678", email:"sales@packline.example.com", address:"Maashaven NZ 12, 3016 Rotterdam, Netherlands", keyPeople:[{name:"Joost Bakker", title:"Managing Director"}],
    employeeCount:"38", companySize:"Small (under 50 employees)", founded:"2003"},
  {keywords:["steel","pipe","metal"], country:"USA", title:"IronGate Steel Works", link:"https://example.com/irongate", displayLink:"irongate.example.com", snippet:"Steel pipe and tube manufacturer with rolling mill facilities. ASTM certified, custom diameters.", type:"manufacturer", confidence:94,
    phone:"+1 412 555 0199", email:"info@irongate.example.com", address:"2200 Steel Mill Rd, Pittsburgh, PA 15222, USA", keyPeople:[{name:"Robert Hayes", title:"CEO"},{name:"Diane Foster", title:"VP Operations"}],
    employeeCount:"540", companySize:"Large (250+ employees)", founded:"1967"},
  {keywords:["steel","pipe","metal"], country:"UAE", title:"MetalFlow Trading Co.", link:"https://example.com/metalflow", displayLink:"metalflow.example.com", snippet:"Distributor supplying steel pipes to construction and industrial clients. JIT delivery, credit terms.", type:"distributor", confidence:91,
    phone:"+971 4 567 8901", whatsapp:"+971 50 123 4567", email:"sales@metalflow.example.com", address:"Jebel Ali Free Zone, Dubai, UAE", keyPeople:[{name:"Omar Al Falasi", title:"General Manager"}],
    employeeCount:"60", companySize:"Medium (50–250 employees)", founded:"2011"},
  {keywords:["textile","fabric","cloth"], country:"Bangladesh", title:"WeaveTech Mills", link:"https://example.com/weavetech", displayLink:"weavetech.example.com", snippet:"Textile mill producing cotton and synthetic fabrics at scale. Private label, GOTS certified.", type:"manufacturer", confidence:93,
    phone:"+880 2 9876 5432", email:"export@weavetech.example.com", address:"Tongi Industrial Area, Dhaka, Bangladesh", keyPeople:[{name:"Kamal Hossain", title:"Managing Director"}],
    employeeCount:"1200", companySize:"Large (250+ employees)", founded:"1985"},
  {keywords:["textile","fabric","cloth"], country:"Turkey", title:"Fabric Hub Distribution", link:"https://example.com/fabrichub", displayLink:"fabrichub.example.com", snippet:"Distributes fabrics sourced from various mills to garment makers. Small MOQ, sample swatches.", type:"distributor", confidence:89,
    phone:"+90 212 345 6789", whatsapp:"+90 532 123 4567", email:"info@fabrichub.example.com", address:"Merter Tekstil Merkezi, Istanbul, Turkey", keyPeople:[{name:"Elif Yildiz", title:"Owner"}],
    employeeCount:"22", companySize:"Small (under 50 employees)", founded:"2016"},
  {keywords:["electronics","circuit","pcb","chip"], country:"Taiwan", title:"CircuitForge Electronics", link:"https://example.com/circuitforge", displayLink:"circuitforge.example.com", snippet:"PCB and electronic component manufacturer with SMT assembly lines. RoHS compliant.", type:"manufacturer", confidence:95,
    phone:"+886 2 8765 4321", email:"sales@circuitforge.example.com", address:"Hsinchu Science Park, Taipei, Taiwan", keyPeople:[{name:"Chen Yu-Ting", title:"CTO"},{name:"Wang Jia-Hao", title:"Sales Manager"}],
    employeeCount:"410", companySize:"Large (250+ employees)", founded:"1999"},
  {keywords:["electronics","circuit","pcb","chip"], country:"USA", title:"ChipChain Distributors", link:"https://example.com/chipchain", displayLink:"chipchain.example.com", snippet:"Authorized distributor of electronic components from major brands. Same-day quote.", type:"distributor", confidence:92,
    phone:"+1 408 555 0172", email:"quotes@chipchain.example.com", address:"1200 Component Way, San Jose, CA 95131, USA", keyPeople:[{name:"Kevin Tran", title:"VP Sales"}],
    employeeCount:"95", companySize:"Medium (50–250 employees)", founded:"2006"},
  {keywords:["furniture","wood","chair","table"], country:"Vietnam", title:"OakCraft Manufacturing", link:"https://example.com/oakcraft", displayLink:"oakcraft.example.com", snippet:"Solid wood furniture manufacturer with in-house carpentry. Custom design, FSC certified wood.", type:"manufacturer", confidence:94,
    phone:"+84 28 3812 3456", email:"export@oakcraft.example.com", address:"Binh Tan Industrial Zone, Ho Chi Minh City, Vietnam", keyPeople:[{name:"Nguyen Van Minh", title:"Founder"}],
    employeeCount:"275", companySize:"Large (250+ employees)", founded:"2009"},
  {keywords:["furniture","wood","chair","table"], country:"Poland", title:"HomeStock Furniture Distribution", link:"https://example.com/homestock", displayLink:"homestock.example.com", snippet:"Distributes furniture from multiple factories to retail stores. Showroom network, bulk discounts.", type:"distributor", confidence:90,
    phone:"+48 22 123 4567", email:"biuro@homestock.example.com", address:"ul. Przemyslowa 8, 00-001 Warsaw, Poland", keyPeople:[{name:"Pawel Kowalski", title:"Managing Director"}],
    employeeCount:"30", companySize:"Small (under 50 employees)", founded:"2012"},
  {keywords:["pharma","medicine","tablet","drug"], country:"India", title:"MediSynth Labs", link:"https://example.com/medisynth", displayLink:"medisynth.example.com", snippet:"Pharmaceutical manufacturer producing tablets and capsules under GMP.", type:"manufacturer", confidence:97,
    phone:"+91 40 6789 1234", email:"info@medisynth.example.com", address:"Genome Valley, Hyderabad, Telangana, India", keyPeople:[{name:"Dr. Suresh Rao", title:"Chairman"},{name:"Priya Nair", title:"Head of Regulatory Affairs"}],
    employeeCount:"850", companySize:"Large (250+ employees)", founded:"1996"},
  {keywords:["pharma","medicine","tablet","drug"], country:"Germany", title:"PharmaLink Distribution", link:"https://example.com/pharmalink", displayLink:"pharmalink.example.com", snippet:"Pharmaceutical distributor supplying pharmacies and hospitals. Cold chain logistics.", type:"distributor", confidence:93,
    phone:"+49 69 1234 5678", email:"kontakt@pharmalink.example.com", address:"Logistikpark 5, 60314 Frankfurt, Germany", keyPeople:[{name:"Markus Weber", title:"Geschäftsführer (Managing Director)"}],
    employeeCount:"130", companySize:"Medium (50–250 employees)", founded:"1978"},
  {keywords:["food","snack","beverage"], country:"Brazil", title:"FreshBatch Food Manufacturing", link:"https://example.com/freshbatch", displayLink:"freshbatch.example.com", snippet:"Food production facility manufacturing packaged snacks and beverages. HACCP certified.", type:"manufacturer", confidence:95,
    phone:"+55 11 4567 8901", whatsapp:"+55 11 91234 5678", email:"contato@freshbatch.example.com", address:"Av. Industrial 900, São Paulo, Brazil", keyPeople:[{name:"Carlos Mendes", title:"CEO"}],
    employeeCount:"410", companySize:"Large (250+ employees)", founded:"2001"},
  {keywords:["food","snack","beverage"], country:"Australia", title:"GroceryChain Distributors", link:"https://example.com/grocerychain", displayLink:"grocerychain.example.com", snippet:"Distributes packaged food and beverages to supermarkets nationwide.", type:"distributor", confidence:91,
    phone:"+61 2 9876 5432", email:"sales@grocerychain.example.com", address:"22 Distribution Dr, Sydney NSW 2000, Australia", keyPeople:[{name:"Emma Wilson", title:"National Sales Manager"}],
    employeeCount:"210", companySize:"Medium (50–250 employees)", founded:"1994"},
  {keywords:["solar","panel","energy"], country:"China", title:"SunCell Manufacturing", link:"https://example.com/suncell", displayLink:"suncell.example.com", snippet:"Solar panel manufacturer with photovoltaic cell production. High efficiency cells, 25-yr warranty.", type:"manufacturer", confidence:96,
    phone:"+86 29 8765 4321", email:"sales@suncell.example.com", address:"High-Tech Zone, Xi'an, Shaanxi, China", keyPeople:[{name:"Liu Yang", title:"CEO"},{name:"Sun Qing", title:"R&D Director"}],
    employeeCount:"890", companySize:"Large (250+ employees)", founded:"2010"},
  {keywords:["solar","panel","energy"], country:"Spain", title:"GreenWatt Distribution", link:"https://example.com/greenwatt", displayLink:"greenwatt.example.com", snippet:"Distributor of solar panels and inverters to installers. Installer network, financing options.", type:"distributor", confidence:90,
    phone:"+34 91 234 5678", email:"info@greenwatt.example.com", address:"Calle de la Energía 15, 28001 Madrid, Spain", keyPeople:[{name:"Carmen Ruiz", title:"Managing Director"}],
    employeeCount:"55", companySize:"Medium (50–250 employees)", founded:"2015"},
  {keywords:["irrigation","agritech","drip","sensor"], country:"Israel", title:"AgriFlow Technologies", link:"https://example.com/agriflow", displayLink:"agriflow.example.com", snippet:"Manufacturer of precision drip irrigation systems and agritech sensors. R&D facility, patented emitters.", type:"manufacturer", confidence:95,
    phone:"+972 3 555 0123", whatsapp:"+972 50 555 0123", email:"info@agriflow.example.com", address:"Kibbutz Industrial Park, Hadera, Israel", keyPeople:[{name:"Yossi Cohen", title:"Founder & CEO"},{name:"Tamar Levi", title:"VP R&D"}],
    employeeCount:"75", companySize:"Medium (50–250 employees)", founded:"2017"},
  {keywords:["irrigation","agritech","drip","sensor"], country:"Thailand", title:"FarmLink Distribution", link:"https://example.com/farmlink", displayLink:"farmlink.example.com", snippet:"Regional distributor of irrigation and agritech equipment to Southeast Asian farms. Local stock, dealer network.", type:"distributor", confidence:90,
    phone:"+66 2 123 4567", whatsapp:"+66 81 234 5678", email:"sales@farmlink.example.com", address:"Lat Krabang Industrial Estate, Bangkok, Thailand", keyPeople:[{name:"Somchai Suwan", title:"Managing Director"}],
    employeeCount:"40", companySize:"Small (under 50 employees)", founded:"2013"},
  {keywords:["rubber","tire","auto","parts"], country:"Thailand", title:"SiamRubber Manufacturing", link:"https://example.com/siamrubber", displayLink:"siamrubber.example.com", snippet:"Rubber and auto parts manufacturer with vulcanization plant. Tier-1 automotive supplier, ISO/TS certified.", type:"manufacturer", confidence:96,
    phone:"+66 38 234 5678", whatsapp:"+66 81 987 6543", email:"export@siamrubber.example.com", address:"Amata City Industrial Estate, Chonburi, Thailand", keyPeople:[{name:"Anan Wattana", title:"CEO"}],
    employeeCount:"620", companySize:"Large (250+ employees)", founded:"1988"},
  {keywords:["rubber","tire","auto","parts"], country:"Israel", title:"AutoPart Distributors Israel", link:"https://example.com/autopartil", displayLink:"autopart-il.example.com", snippet:"Distributor of rubber components and auto parts to garages and retailers nationwide. Authorized dealer.", type:"distributor", confidence:91,
    phone:"+972 3 555 0456", whatsapp:"+972 50 555 0456", email:"info@autopart-il.example.com", address:"Holon Industrial Zone, Holon, Israel", keyPeople:[{name:"David Mizrahi", title:"Owner"}],
    employeeCount:"18", companySize:"Small (under 50 employees)", founded:"2019"},

  // ── Copper cathode producers — one verified real producer per continent ──────
  // Unlike the entries above, these are REAL companies with REAL official sites,
  // not example.com placeholders. We deliberately do NOT include phone/email/
  // address here — we don't have verified current contact details for these, and
  // fabricating them for real companies would be misleading. Clicking through
  // triggers the app's normal live scraper (/api/enrich) to pull real contact
  // info directly from each site instead.
  {keywords:["copper","cathode"], continent:"South America", country:"Chile", title:"Codelco — Corporación Nacional del Cobre de Chile", link:"https://www.codelco.com", displayLink:"codelco.com", snippet:"State-owned Chilean mining company; the world's largest copper producer, producing copper cathodes for global export.", type:"manufacturer", confidence:97},
  {keywords:["copper","cathode"], continent:"North America", country:"United States", title:"Freeport-McMoRan Inc.", link:"https://www.fcx.com", displayLink:"fcx.com", snippet:"Major U.S.-based copper producer with mining and smelting/refining operations producing copper cathodes.", type:"manufacturer", confidence:97},
  {keywords:["copper","cathode"], continent:"Asia", country:"China", title:"Jiangxi Copper Corporation", link:"https://www.jxcc.com", displayLink:"jxcc.com", snippet:"China's largest integrated copper producer, with cathode production at its Guixi smelter/refinery complex.", type:"manufacturer", confidence:96},
  {keywords:["copper","cathode"], continent:"Europe", country:"Germany", title:"Aurubis AG", link:"https://www.aurubis.com", displayLink:"aurubis.com", snippet:"Europe's largest copper producer and recycler, manufacturing copper cathodes from both mined concentrate and recycled material.", type:"manufacturer", confidence:96},
  {keywords:["copper","cathode"], continent:"Africa", country:"Zambia", title:"First Quantum Minerals — Kansanshi Mining", link:"https://www.first-quantum.com", displayLink:"first-quantum.com", snippet:"Operates the Kansanshi mine in Zambia, one of Africa's largest copper cathode producers.", type:"manufacturer", confidence:95},
  {keywords:["copper","cathode"], continent:"Oceania", country:"Australia", title:"BHP — Olympic Dam", link:"https://www.bhp.com", displayLink:"bhp.com", snippet:"Operates the Olympic Dam mine in South Australia, producing copper cathodes alongside uranium, gold and silver.", type:"manufacturer", confidence:95}
];

function searchDemo(subject, country) {
  const terms = subject.toLowerCase().split(/\s+/).filter(Boolean);
  const countryLc = country.toLowerCase();

  return DEMO_DATA.filter(item => {
    const matchesSubject = terms.length === 0 || terms.some(t => item.keywords.some(k => k.includes(t) || t.includes(k)));
    const matchesCountry = !countryLc || item.country.toLowerCase() === countryLc;
    return matchesSubject && matchesCountry;
  }).map(({ keywords, ...rest }) => rest);
}

// A handful of DEMO_DATA entries point to REAL companies (not example.com
// placeholders) — e.g. the copper cathode producers. Unlike the rest of DEMO_DATA
// (which only activates with no API keys at all), these should always be surfaced
// in live search results too when the query matches, since they're a curated,
// verified reference set worth showing regardless of live search quality.
function curatedRealMatches(subjectTerms) {
  if (!subjectTerms.length) return [];
  return DEMO_DATA
    .filter(item => !item.link.includes('example.com'))
    .filter(item => subjectTerms.some(t => item.keywords.some(k => k.includes(t) || t.includes(k))))
    .map(({ keywords, continent, ...rest }) => ({
      ...rest, signals: [], category: 'direct', thumbnail: null, age: null, curated: true
    }));
}

function searchDemoByCompanyName(company) {
  const needle = company.toLowerCase();
  return DEMO_DATA
    .filter(item => item.title.toLowerCase().includes(needle))
    .map(({ keywords, ...rest }) => rest);
}

function searchDemoByPersonName(person) {
  const needle = person.toLowerCase();
  return DEMO_DATA
    .filter(item => item.keyPeople && item.keyPeople.some(p => p.name.toLowerCase().includes(needle)))
    .map(({ keywords, ...rest }) => rest);
}

// ---- External company enrichment: Wikipedia, DuckDuckGo, Brave Search ----
async function enrichFromExternalSources(companyName, websiteOrigin) {
  const out = {
    description: null, wikipedia: null, linkedin: null,
    revenue: null, employeesExt: null, industry: null, news: [],
    fundingStage: null, founders: []
  };
  if (!companyName || companyName.length < 2) return out;

  const tasks = [];

  // 1. Wikipedia REST summary (free, no key)
  tasks.push(
    (async () => {
      try {
        const wikiName = companyName.replace(/\s+/g, '_');
        const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiName)}`, {
          headers: { 'User-Agent': 'ErezImpex/1.0' },
          signal: AbortSignal.timeout(5000)
        });
        if (!r.ok) return;
        const d = await r.json();
        if (d.type === 'standard' && d.extract && d.extract.length > 60) {
          out.description = d.extract.replace(/\s+/g, ' ').slice(0, 500);
          out.wikipedia = d.content_urls?.desktop?.page || null;
        }
      } catch (_) {}
    })()
  );

  // 2. DuckDuckGo Instant Answer (free, no key — fallback description)
  tasks.push(
    (async () => {
      try {
        const r = await fetch(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(companyName)}&format=json&no_html=1&skip_disambig=1`,
          { headers: { 'User-Agent': 'ErezImpex/1.0' }, signal: AbortSignal.timeout(5000) }
        );
        if (!r.ok) return;
        const d = await r.json();
        if (d.Abstract && d.Abstract.length > 60 && !out.description) {
          out.description = d.Abstract.slice(0, 500);
          out.wikipedia = out.wikipedia || d.AbstractURL || null;
        }
      } catch (_) {}
    })()
  );

  // 3. Brave Search — company profile data + news (3 parallel queries)
  if (BRAVE_API_KEY) {
    const braveHdr = { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': BRAVE_API_KEY };
    const braveFetch = async (q, extra = '') => {
      try {
        const r = await fetch(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5${extra}`,
          { headers: braveHdr, signal: AbortSignal.timeout(7000) }
        );
        return r.ok ? (await r.json()).web?.results || [] : [];
      } catch (_) { return []; }
    };

    // 3a. Employee count, revenue, industry from business directories
    tasks.push(
      braveFetch(`"${companyName}" employees revenue turnover industry`).then(items => {
        for (const item of items) {
          const text = ((item.title || '') + ' ' + (item.description || '')).replace(/\s+/g, ' ');
          if (!out.employeesExt) {
            const m = text.match(/(\d[\d,]+)\+?\s*employees/i);
            if (m) out.employeesExt = m[1].replace(/,/g,'') + ' employees';
          }
          if (!out.revenue) {
            const m = text.match(/(?:revenue|turnover|sales|annual)[^\d]{0,20}\$?([\d,.]+)\s*(billion|million|bn|mn|b|m)\b/i);
            if (m) {
              const unit = /^b/i.test(m[2]) ? 'B' : 'M';
              out.revenue = `$${m[1]}${unit}`;
            }
          }
          if (!out.industry && !out.description) {
            const m = text.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)?)\s+(?:company|manufacturer|supplier|provider)\b/);
            if (m) out.industry = m[1];
          }
        }
      })
    );

    // 3b. LinkedIn company page URL
    tasks.push(
      braveFetch(`"${companyName}" site:linkedin.com/company`).then(items => {
        for (const item of items) {
          if (item.url && /linkedin\.com\/company\//i.test(item.url)) {
            out.linkedin = item.url.split('?')[0].replace(/\/$/, '');
            break;
          }
        }
      })
    );

    // 3d. Funding stage & founders from Crunchbase / news
    tasks.push(
      braveFetch(`"${companyName}" funding round Series Seed investors founders`).then(items => {
        const FUNDING_STAGES = ['Pre-Seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Series D', 'Series E', 'Series F', 'IPO', 'Acquired', 'Grant'];
        for (const item of items) {
          const text = ((item.title || '') + ' ' + (item.description || '')).replace(/\s+/g, ' ');
          if (!out.fundingStage) {
            for (const stage of FUNDING_STAGES) {
              if (new RegExp('\\b' + stage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text)) {
                out.fundingStage = stage;
                break;
              }
            }
          }
          if (out.founders.length < 3) {
            const founderMatch = text.match(/(?:founded by|co-founded by|founder[s]?[^a-z]{0,5})([A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2}(?:\s(?:and|&)\s[A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2})?)/i);
            if (founderMatch) {
              const names = founderMatch[1].split(/\s+(?:and|&)\s+/i).map(n => n.trim()).filter(n => n.length > 2);
              for (const name of names) {
                if (!out.founders.includes(name)) out.founders.push(name);
              }
            }
          }
        }
      })
    );

    // 3c. Recent news (exclude the company's own site)
    tasks.push(
      braveFetch(`${companyName} company news 2025`, '&freshness=py').then(items => {
        const originHost = websiteOrigin ? new URL(websiteOrigin).host.replace(/^www\./, '') : '';
        out.news = items
          .filter(item => {
            if (!item.url) return false;
            try { return !new URL(item.url).host.replace(/^www\./, '').includes(originHost); } catch (_) { return true; }
          })
          .slice(0, 4)
          .map(item => ({
            title: (item.title || '').slice(0, 120),
            url: item.url,
            snippet: (item.description || '').slice(0, 160),
            age: item.age || null
          }));
      })
    );
  }

  await Promise.all(tasks);
  return out;
}

// ---- Company detail enrichment (best-effort scrape of a company's own website) ----
const TITLE_KEYWORDS = [
  'Chief Executive Officer', 'CEO', 'Chief Operating Officer', 'COO',
  'Chief Technology Officer', 'CTO', 'Chief Financial Officer', 'CFO',
  'Founder', 'Co-Founder', 'President', 'Vice President', 'VP',
  'Managing Director', 'General Manager', 'Director', 'Chairman',
  'Owner', 'Sales Manager', 'Plant Manager'
];

// Pull structured contact data out of JSON-LD (schema.org Organization/LocalBusiness).
// Most company sites embed this for SEO — it's authoritative and far cleaner than
// regex-scraping visible text, so we use it as the highest-priority source.
function extractJsonLd($) {
  const out = { phone: null, fax: null, email: null, address: null, whatsapp: null, founded: null, country: null };
  const formatAddress = (a) => {
    if (!a || typeof a !== 'object') return null;
    const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
      .filter(Boolean).map(String).map(s => s.trim());
    return parts.length ? parts.join(', ') : null;
  };
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const type = (node['@type'] || '').toString();
    if (/Organization|LocalBusiness|Corporation|Store/i.test(type)) {
      if (!out.phone && node.telephone) out.phone = String(node.telephone).trim();
      if (!out.fax && node.faxNumber) out.fax = String(node.faxNumber).trim();
      if (!out.email && node.email) out.email = String(node.email).trim();
      if (!out.address) out.address = formatAddress(node.address);
      // Capture the country code/name directly, independent of whether the full
      // street address assembled above — gives us a fallback even when other
      // address fields (street, postal code) are missing from the markup.
      if (!out.country && node.address && typeof node.address === 'object' && node.address.addressCountry) {
        const ac = node.address.addressCountry;
        out.country = typeof ac === 'object' ? (ac.name || null) : String(ac).trim();
      }
      if (!out.founded && node.foundingDate) {
        const y = String(node.foundingDate).match(/\d{4}/);
        if (y) out.founded = y[0];
      }
      if (Array.isArray(node.contactPoint)) {
        for (const cp of node.contactPoint) {
          if (!out.phone && cp.telephone) out.phone = String(cp.telephone).trim();
          if (!out.email && cp.email) out.email = String(cp.email).trim();
          if (!out.whatsapp && /whatsapp/i.test(cp.contactType || '') && cp.telephone) out.whatsapp = String(cp.telephone).trim();
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === '@type') continue;
      const v = node[key];
      if (v && typeof v === 'object') visit(v);
    }
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).contents().text());
      visit(json);
    } catch (_) { /* malformed JSON-LD — ignore */ }
  });
  return out;
}

function extractContactInfo(html) {
  const $ = cheerio.load(html);
  const jsonLd = extractJsonLd($);
  // Strip elements unlikely to contain real contact info and likely to produce
  // false-positive address/phone matches (nav menus, scripts, etc.)
  $('script, style, noscript, nav, header').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();

  // Address detection is the most false-positive-prone heuristic, so restrict it
  // to footer content and elements explicitly marked as contact/address sections.
  const addressCandidateText = [
    $('footer').text(),
    $('[class*="address" i], [id*="address" i], [class*="contact" i], [id*="contact" i]').text()
  ].join(' ').replace(/\s+/g, ' ').trim();

  // --- Email: prefer mailto: links, fall back to scanning text ---
  const mailtoEmails = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const addr = ($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
    if (addr) mailtoEmails.push(addr);
  });
  const itempropEmail = $('[itemprop="email"]').first().text().trim();
  if (itempropEmail) mailtoEmails.push(itempropEmail);
  const textEmails = (text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
    .filter(e => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e));
  // De-obfuscate common anti-scrape patterns, but ONLY the bracketed forms
  // ("info [at] domain [dot] com", "info(at)domain(dot)com"). We deliberately do
  // NOT treat the bare words " at " / " dot " as separators — those appear
  // constantly in normal prose and produce false-positive emails.
  const deobfText = text
    .replace(/\s*[\[({]\s*at\s*[\])}]\s*/gi, '@')
    .replace(/\s*[\[({]\s*dot\s*[\])}]\s*/gi, '.');
  const obfEmails = (deobfText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
    .filter(e => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e))
    // Reject prose-like false positives: a valid TLD is 2–24 lowercase letters,
    // not a capitalized word like "According".
    .filter(e => /\.[a-z]{2,24}$/.test(e));
  // Placeholder / example domains that appear in boilerplate and docs, never real.
  const JUNK_EMAIL_DOMAINS = /@(example|test|domain|yourdomain|email|sentry|wix|wordpress|godaddy|sentry\.io)\.|@(.+\.)?(example|test)\.(com|org|net)$|\.(png|jpg|gif)$/i;
  const allEmails = [...new Set([...mailtoEmails, ...textEmails, ...obfEmails])]
    // Final sanity: real email addresses end in a lowercase TLD (2–24 letters).
    // This drops prose false positives like "name@home.According".
    .filter(e => /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,24}$/.test(e))
    .filter(e => !JUNK_EMAIL_DOMAINS.test(e));
  const email = allEmails.sort((a, b) => {
    const score = s => /^(info|contact|sales|hello|office|export)@/i.test(s) ? -1 : 0;
    return score(a) - score(b);
  })[0] || null;

  // --- Phone: prefer tel: links, fall back to scanning text ---
  // A validator that rejects common false positives: bare year ranges
  // (e.g. "2018-2026" copyright), all-same digits, and date-like strings.
  const looksLikePhone = (raw) => {
    if (!raw) return false;
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return false;          // E.164-ish bounds
    if (/^(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}$/.test(raw.trim())) return false; // year range
    if (/^(\d)\1+$/.test(digits)) return false;                          // 00000000 etc.
    // A 4-digit-only or 8-digit run that is just two years stuck together
    if (digits.length === 8 && /^(19|20)\d{2}(19|20)\d{2}$/.test(digits)) return false;
    return true;
  };
  let phone = null;
  $('a[href^="tel:"]').each((_, el) => {
    if (phone) return;
    const cand = ($(el).attr('href') || '').replace(/^tel:/i, '').split('?')[0].trim();
    if (looksLikePhone(cand)) phone = cand;
  });
  if (!phone) {
    // Prefer numbers that appear near a phone label, then any plausible number.
    const labeled = text.match(/(?:tel|phone|call|mobile|cell|whatsapp|fax|t:|p:)\D{0,4}(\+?\d[\d\s().-]{7,16}\d)/i);
    if (labeled && looksLikePhone(labeled[1])) phone = labeled[1].trim();
  }
  if (!phone) {
    const phoneMatches = text.match(/\+?\d[\d\s().-]{7,16}\d/g) || [];
    phone = phoneMatches.map(p => p.trim()).find(looksLikePhone) || null;
  }
  if (!phone) {
    const itemprop = $('[itemprop="telephone"]').first().text().trim();
    if (looksLikePhone(itemprop)) phone = itemprop;
  }

  // --- Address: <address> tag, schema.org markup, or a street-pattern heuristic
  //     scoped to footer/contact sections only, requiring a comma to cut down
  //     on false positives from unrelated page text. ---
  // Trim trailing boilerplate that often runs into a scraped address
  // (e.g. "…Singapore 169208 Website www.x.com WhatsApp Message us Email…").
  const cleanAddress = (a) => {
    if (!a) return a;
    let s = a.replace(/\s+/g, ' ').trim();
    // Cut at the first trailing contact-label keyword
    s = s.replace(/\s+(Website|WhatsApp|Whats App|Email|E-mail|Phone|Tel|Fax|Mobile|Call|Contact|Hours|Copyright|©|Follow|Subscribe|Newsletter|Menu|Home)\b.*$/i, '').trim();
    // Cut right after a postal/zip code if it's followed by an unrelated sentence
    // (e.g. "...Suite 110, Phoenix, AZ 85040 Communication will be forwarded to...").
    // Addresses continue with commas; a capitalized word + 2+ lowercase words with
    // no comma is prose, not an address continuation — but "Blvd. Suite 110" (an
    // abbreviation immediately followed by digits) must NOT be caught by this.
    s = s.replace(/(\d[\d-]{3,7})\s+[A-Z][a-z]+(?:\s+[a-z]+){2,}.*$/, '$1');
    // Drop a dangling trailing connector/punctuation
    s = s.replace(/[\s,;|·•\-]+$/, '').trim();
    return s.length >= 8 ? s : null;
  };
  let address = cleanAddress($('address').first().text()) || null;
  if (!address) {
    const schemaAddr = cleanAddress($('[itemtype*="PostalAddress"]').first().text());
    if (schemaAddr) address = schemaAddr;
  }
  if (!address && addressCandidateText) {
    const addrMatch = addressCandidateText.match(/\d{1,5}[^,\n]{0,40}(Street|St\.|Road|Rd\.|Avenue|Ave\.|Blvd|Boulevard|Lane|Drive|Suite|Floor|Building)[^,\n]{0,30},[^\n]{0,80}/i);
    if (addrMatch) { const c = cleanAddress(addrMatch[0]); if (c && c.length < 140) address = c; }
  }

  // --- Fax: look for fax-labeled numbers ---
  let fax = null;
  const faxMatch = text.match(/(?:fax|facsimile|f:)[^\d]{0,4}(\+?\d[\d\s().-]{7,16}\d)/i);
  if (faxMatch && looksLikePhone(faxMatch[1]) && faxMatch[1] !== phone) fax = faxMatch[1].trim();

  // --- WhatsApp: look for wa.me / api.whatsapp.com links, or a "WhatsApp: <number>"
  //     mention in the text. Note this is a company-level contact channel — sites
  //     essentially never publish a separate WhatsApp number per individual person. ---
  let whatsapp = null;
  $('a[href*="wa.me/"], a[href*="api.whatsapp.com"], a[href*="whatsapp.com/send"]').each((_, el) => {
    if (whatsapp) return;
    const href = $(el).attr('href') || '';
    const numMatch = href.match(/(?:wa\.me\/|phone=)\+?(\d{7,15})/i);
    if (numMatch) whatsapp = '+' + numMatch[1];
  });
  if (!whatsapp) {
    const waTextMatch = text.match(/whatsapp[^a-zA-Z0-9]{0,5}(\+?\d[\d\s().-]{6,15}\d)/i);
    if (waTextMatch) whatsapp = waTextMatch[1].trim();
  }

  // --- Hiring status: detect careers/jobs sections or "we're hiring" signals ---
  let hiringStatus = null;
  const hiringLinks = [];
  $('a[href*="career"], a[href*="jobs"], a[href*="hiring"], a[href*="work-with-us"], a[href*="join-us"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href && !href.startsWith('#')) hiringLinks.push(href);
  });
  if (hiringLinks.length > 0) {
    hiringStatus = 'Actively hiring';
  } else if (/(?:we're|we are|now)\s+hiring|join our team|career opportunities|open positions|current openings|job openings/i.test(text)) {
    hiringStatus = 'Actively hiring';
  } else if (/no open positions|no current openings|not hiring/i.test(text)) {
    hiringStatus = 'Not currently hiring';
  }

  // --- Key people: name immediately followed by a recognized title ---
  const titleAlt = TITLE_KEYWORDS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const peopleRegex = new RegExp(`([A-Z][a-zA-Z'-]+(?:\\s[A-Z][a-zA-Z'-]+){0,2})\\s*[,\\-–|]\\s*(${titleAlt})\\b`, 'g');
  const seen = new Set();
  const keyPeople = [];
  let m;
  while ((m = peopleRegex.exec(text)) && keyPeople.length < 5) {
    const name = m[1].trim();
    if (seen.has(name)) continue;
    seen.add(name);
    keyPeople.push({ name, title: m[2].trim() });
  }

  // --- Company size: employee count mention, bucketed into a rough size band.
  //     Financial figures (revenue, profit, funding) are deliberately NOT scraped —
  //     they're rarely on a company's own site and guessing would be misleading. ---
  // Deliberately excludes the generic word "people" — marketing copy frequently
  // pairs large numbers with "people" in unrelated contexts (e.g. "used by
  // 2 million people"), which caused false positives in testing.
  let employeeCount = null;
  const empMatch = text.match(/(\d{1,3}(?:,\d{3})*\+?)\s*(?:employees|members of staff)/i)
    || text.match(/(?:team|staff)\s+of\s+(\d{1,3}(?:,\d{3})*\+?)\s*(?:employees|people)?/i);
  if (empMatch) {
    const n = parseInt(empMatch[1].replace(/[^\d]/g, ''), 10);
    // Sanity bound: implausible employee counts (e.g. matched from an unrelated stat) are discarded.
    if (!isNaN(n) && n >= 1 && n <= 100000) employeeCount = empMatch[1].trim();
  }

  let companySize = null;
  if (employeeCount) {
    const n = parseInt(employeeCount.replace(/[^\d]/g, ''), 10);
    if (!isNaN(n)) {
      if (n < 50) companySize = 'Small (under 50 employees)';
      else if (n < 250) companySize = 'Medium (50–250 employees)';
      else companySize = 'Large (250+ employees)';
    }
  }

  let founded = null;
  const foundedMatch = text.match(/(?:founded|established|incorporated|since)\D{0,12}((?:19|20)\d{2})\b/i);
  if (foundedMatch) founded = foundedMatch[1];

  // Country: even when we can't assemble a full street address, try to at least
  // pin down which country the company is in. Priority: JSON-LD's explicit
  // addressCountry > a country name/alias mentioned in the footer/contact section
  // > the same scan over the whole page as a last resort before falling back to
  // the domain's ccTLD (done one level up, in /api/enrich, where the host is known).
  const country = jsonLd.country
    || detectCountryFromText(addressCandidateText)
    || detectCountryFromText(text);

  // JSON-LD is authoritative — prefer it over the regex-scraped guesses above.
  return {
    phone: jsonLd.phone || phone,
    fax: jsonLd.fax || fax,
    email: jsonLd.email || email,
    address: jsonLd.address || address,
    whatsapp: jsonLd.whatsapp || whatsapp,
    keyPeople, employeeCount, companySize,
    founded: jsonLd.founded || founded,
    hiringStatus,
    country
  };
}

// In-memory cache for scraped enrichment data, keyed by domain (not full URL —
// contact info lives at the company level, so re-scraping the same domain across
// different search-result pages or repeat searches is wasted work). 12h TTL: long
// enough to avoid re-hitting the same sites within a workday, short enough that
// stale contact info doesn't linger indefinitely.
const ENRICH_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const enrichCache = new Map();

app.get('/api/enrich', async (req, res) => {
  const url = (req.query.url || '').trim();
  const nameHint = (req.query.name || '').trim();
  // Optional: the country the search result was already tagged with (e.g. from
  // a country-filtered search, or one of the curated reference entries) — used
  // as a fallback if scraping can't determine a country on its own.
  const countryHint = (req.query.country || '').trim();
  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  let cacheHost = '';
  try { cacheHost = new URL(url).host.replace(/^www\./, '').toLowerCase(); } catch (_) {}
  if (cacheHost) {
    const cached = enrichCache.get(cacheHost);
    if (cached && (Date.now() - cached.time) < ENRICH_CACHE_TTL_MS) {
      // A cached scrape may predate a countryHint the caller now supplies (or be
      // from before the country-detection fallback existed) — still apply the
      // hint/TLD fallback on a cache hit rather than serving a stale empty country.
      const country = cached.data.country || countryHint || countryFromHost(cacheHost);
      return res.json({ ...cached.data, website: url, country, cached: true });
    }
  }

  // Directory/aggregator pages (ZoomInfo, Bloomberg, Crunchbase, D&B, importer dirs…)
  // list many companies; an address scraped from them is frequently the WRONG entity.
  // Never present their scraped contact details as authoritative — just link out.
  let enrichHost = '';
  try { enrichHost = new URL(url).host.replace(/^www\./, '').toLowerCase(); } catch (_) {}
  if (enrichHost && isAggregatorHost(enrichHost)) {
    return res.json({
      success: true, website: url, phone: null, email: null, address: null,
      whatsapp: null, keyPeople: [], employeeCount: null, companySize: null, founded: null,
      country: countryHint || countryFromHost(enrichHost),
      isAggregator: true,
      note: `This is a third-party directory listing (${enrichHost}); its details may not match the exact company. Open it to verify.`
    });
  }

  // If this is one of our bundled demo links, return the canned demo contact info
  // instead of trying to fetch a non-existent example.com page.
  // Only example.com placeholder entries should short-circuit to canned data —
  // curated real-company entries (e.g. copper cathode producers) must always go
  // through live scraping below, since they have real websites worth actually fetching.
  const demoMatch = DEMO_DATA.find(d => d.link === url && d.link.includes('example.com'));
  if (demoMatch) {
    const demoFounders = (demoMatch.keyPeople || []).filter(p => /founder/i.test(p.title)).map(p => p.name);
    return res.json({
      success: true,
      website: url,
      phone: demoMatch.phone || null,
      fax: demoMatch.fax || null,
      email: demoMatch.email || null,
      address: demoMatch.address || null,
      whatsapp: demoMatch.whatsapp || null,
      keyPeople: demoMatch.keyPeople || [],
      employeeCount: demoMatch.employeeCount || null,
      companySize: demoMatch.companySize || null,
      founded: demoMatch.founded || null,
      hiringStatus: demoMatch.hiringStatus || null,
      fundingStage: demoMatch.fundingStage || null,
      country: demoMatch.country || countryHint || null,
      founders: demoFounders
    });
  }

  const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Upgrade-Insecure-Requests': '1'
  };

  // Try a URL, return { html, status } or null on failure
  async function tryFetch(fetchUrl) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(fetchUrl, { headers: BROWSER_HEADERS, redirect: 'follow', signal: controller.signal });
      clearTimeout(tid);
      if (!r.ok) return { html: null, status: r.status };
      return { html: await r.text(), status: r.status };
    } catch (_) { return null; }
  }

  // Status codes that mean the site is actively blocking bots (Cloudflare, WAF,
  // rate-limit) rather than the page simply not existing.
  const BLOCK_CODES = new Set([401, 403, 405, 429, 451, 503, 999]);

  try {
    // Derive the site ROOT (origin) from the search-result URL. The result link is
    // usually a deep page (e.g. /led-bulb-manufacturer-china/), so appending
    // "/contact" to it would produce a bogus URL — we must build contact/about
    // pages off the origin instead.
    let origin, deep = url.replace(/[#?].*$/, '').replace(/\/$/, '');
    try { origin = new URL(url).origin; } catch (_) { origin = deep; }

    let combinedInfo = { phone:null, fax:null, email:null, address:null, whatsapp:null, keyPeople:[], employeeCount:null, companySize:null, founded:null, hiringStatus:null, country:null };
    let blocked = false, fetchedAny = false;

    const mergeFrom = (html) => {
      fetchedAny = true;
      const info = extractContactInfo(html);
      for (const key of ['phone','fax','email','address','whatsapp','employeeCount','companySize','founded','hiringStatus','country']) {
        if (!combinedInfo[key] && info[key]) combinedInfo[key] = info[key];
      }
      if (!combinedInfo.keyPeople.length && info.keyPeople.length) combinedInfo.keyPeople = info.keyPeople;
    };
    const enough = () => combinedInfo.phone && (combinedInfo.email || combinedInfo.whatsapp) && combinedInfo.address;

    // Phase 1: fetch the result page + homepage in parallel (fast).
    const phase1Urls = [...new Set([deep, origin])];
    const phase1 = await Promise.all(phase1Urls.map(tryFetch));
    let homepageHtml = null;
    phase1.forEach((r, i) => {
      if (!r) return;
      if (!r.html) { if (BLOCK_CODES.has(r.status)) blocked = true; return; }
      mergeFrom(r.html);
      if (phase1Urls[i] === origin) homepageHtml = r.html;
    });

    // Discover the site's actual contact-page link from the homepage nav/footer
    // instead of only guessing fixed paths — far more reliable for sites whose
    // contact page lives somewhere a static path list would never predict
    // (localized slugs, non-standard URL structures, etc.).
    let discoveredContactUrls = [];
    if (homepageHtml) {
      try {
        const $h = cheerio.load(homepageHtml);
        const found = new Set();
        $h('a[href]').each((_, el) => {
          const href = ($h(el).attr('href') || '').trim();
          const linkText = $h(el).text().trim();
          if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
          const isContactish = /contact|contacto|contato|kontakt|contatti|nous-contacter|get-in-touch/i.test(href) ||
            /^(contact|contact us|get in touch|contáctenos|contato|kontakt)$/i.test(linkText);
          if (!isContactish) return;
          try {
            const abs = new URL(href, origin).href;
            if (new URL(abs).origin === origin) found.add(abs);
          } catch (_) {}
        });
        discoveredContactUrls = [...found].slice(0, 3);
      } catch (_) { /* malformed homepage HTML — ignore */ }
    }

    // Derive a company name for external lookups:
    // prefer the passed name hint, fall back to domain (strip TLD + hyphens → spaces).
    const companyName = nameHint ||
      enrichHost.replace(/^www\./, '').replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').trim();

    // Run Phase 2 (contact sub-pages) and external enrichment in parallel.
    const [, extData] = await Promise.all([
      (async () => {
        if (!enough() && !(blocked && !fetchedAny)) {
          // English plus common non-English contact-page conventions — many global
          // suppliers (LatAm, Europe, China) publish contact details only on a
          // localized path that an English-only path list would never try.
          const contactPaths = [
            '/contact', '/contact-us', '/contactus', '/contact.html', '/get-in-touch',
            '/about-us', '/about', '/en/contact', '/en/contact-us', '/company', '/company/contact',
            '/contacto', '/contactenos', '/contactanos',              // Spanish
            '/contato', '/fale-conosco',                              // Portuguese
            '/contactez-nous', '/nous-contacter',                     // French
            '/kontakt', '/kontaktieren-sie-uns',                      // German
            '/contatti',                                              // Italian
            '/lianxiwomen', '/contact-cn'                              // CN fallback (most CN sites use English path anyway)
          ];
          // Try the actual discovered contact link(s) first — they're far more
          // likely to be correct than a guessed path — then fall back to the
          // static guess list for sites where nothing contact-like was found in nav.
          const phase2Urls = [...new Set([...discoveredContactUrls, ...contactPaths.map(p => origin + p)])];
          const phase2 = await Promise.all(phase2Urls.map(tryFetch));
          for (const r of phase2) {
            if (!r) continue;
            if (!r.html) { if (BLOCK_CODES.has(r.status)) blocked = true; continue; }
            mergeFrom(r.html);
            if (enough()) break;
          }
        }
      })(),
      enrichFromExternalSources(companyName, origin)
    ]);

    // Merge: external employee count only if not found on site
    if (!combinedInfo.employeeCount && extData.employeesExt) {
      const n = parseInt(extData.employeesExt, 10);
      combinedInfo.employeeCount = extData.employeesExt;
      if (!isNaN(n)) {
        combinedInfo.companySize = n < 50 ? 'Small (under 50 employees)' : n < 250 ? 'Medium (50–250 employees)' : 'Large (250+ employees)';
      }
    }

    // Country fallback chain: scraped (JSON-LD / text scan, already in
    // combinedInfo.country) > caller-supplied hint (the country the search result
    // was already tagged with) > the domain's ccTLD. This guarantees we surface
    // SOME country even on sites that publish no usable contact info at all.
    if (!combinedInfo.country && countryHint) combinedInfo.country = countryHint;
    if (!combinedInfo.country) combinedInfo.country = countryFromHost(enrichHost);

    const hasAny = combinedInfo.phone || combinedInfo.email || combinedInfo.address ||
                   combinedInfo.whatsapp || combinedInfo.keyPeople.length ||
                   combinedInfo.employeeCount || combinedInfo.founded ||
                   extData.description || extData.revenue || extData.news.length;

    let note;
    if (!hasAny && blocked) note = 'This website blocks automated access (bot protection). Open it directly to see contact details.';
    else if (!hasAny && !fetchedAny) note = 'This website could not be reached automatically. Open it directly to see contact details.';
    else if (!hasAny) note = 'No contact details were published on this website.';

    // Merge founders: prefer scraped keyPeople with Founder titles, fall back to external
    const founderPeople = (combinedInfo.keyPeople || []).filter(p => /founder/i.test(p.title)).map(p => p.name);
    const founders = founderPeople.length ? founderPeople : extData.founders;

    const responseData = {
      success: true, website: url, ...combinedInfo, note, blocked: blocked && !hasAny,
      description: extData.description,
      wikipedia: extData.wikipedia,
      linkedin: extData.linkedin,
      revenue: extData.revenue,
      industry: extData.industry,
      news: extData.news,
      fundingStage: extData.fundingStage,
      founders
    };
    // Company Brain: was this company known BEFORE this visit? (capture first)
    const prior = cacheHost ? lookupCompanyBrain(cacheHost) : null;
    if (prior && (prior.interactions || []).length) {
      responseData.memory = {
        known: true, lastSeen: prior.lastSeen, firstSeen: prior.firstSeen,
        trustRating: prior.trustRating || null, interactionCount: (prior.interactions || []).length
      };
    }
    // Only cache real, usable results — a blocked/empty scrape shouldn't poison the
    // cache for 12h in case a retry later would succeed.
    if (cacheHost && hasAny) {
      if (enrichCache.size >= 500) enrichCache.delete(enrichCache.keys().next().value); // evict oldest
      enrichCache.set(cacheHost, { data: responseData, time: Date.now() });
      // ...then record this visit for next time
      recordCompanyBrain(cacheHost, {
        name: nameHint || combinedInfo.title, phone: combinedInfo.phone, email: combinedInfo.email,
        address: combinedInfo.address, country: combinedInfo.country, event: 'enriched'
      });
    }
    res.json(responseData);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch the company website: ' + err.message });
  }
});

// ── Buyer type classification ─────────────────────────────────────────────────
function classifyBuyer(title, snippet, displayLink) {
  const t = (title   || '').toLowerCase();
  const s = (snippet || '').toLowerCase();
  const h = (displayLink || '').toLowerCase().replace(/^www\./, '');
  let score = { importer:0, retailer:0, wholesaler:0, procurement:0 };

  const add = (key, n) => { score[key] += n; };

  // Title signals (3×)
  if (/\bimport(?:er|ing|s)?\b/.test(t))                  add('importer', 9);
  if (/\bimport company\b|\bimport house\b/.test(t))       add('importer', 9);
  if (/\bretail(?:er|s)?\b|supermarket|hypermarket|chain store/.test(t)) add('retailer', 9);
  if (/\bwholesaler\b|\bwholesale buyer\b/.test(t))         add('wholesaler', 9);
  if (/\bprocurement\b|\bpurchas(?:ing|er)\b|\brfq\b/.test(t)) add('procurement', 9);
  if (/\bbuyer\b/.test(t))                                 { add('importer',2); add('wholesaler',2); }

  // Snippet signals (1×)
  if (/\bimport(?:er|ing)?\b/.test(s))                     add('importer', 3);
  if (/\bretail(?:er)?\b|supermarket|chain store/.test(s)) add('retailer', 3);
  if (/\bwholesale\b|\bwholesaler\b/.test(s))               add('wholesaler', 3);
  if (/\bprocurement\b|\bpurchasing\b/.test(s))             add('procurement', 3);
  if (/looking for supplier|seeking manufacturer|request for quotation|rfq/i.test(s)) add('procurement', 5);

  // Domain signals
  if (/import/.test(h)) add('importer', 6);
  if (/retail|shop|store/.test(h)) add('retailer', 6);
  if (/wholesale|trade/.test(h)) add('wholesaler', 6);

  const best = Object.entries(score).sort((a,b) => b[1]-a[1])[0];
  const total = Object.values(score).reduce((a,b)=>a+b,0);
  if (total === 0) return { type:'buyer', confidence:55 };
  const type = best[1] > 0 ? best[0] : 'buyer';
  const confidence = Math.min(90, 50 + Math.round((best[1] / Math.max(total,1)) * 45));
  return { type, confidence };
}

// ── Find customers / buyers for a product ────────────────────────────────────
app.get('/api/search-customers', async (req, res) => {
  const product = (req.query.product || '').trim();
  const country = (req.query.country || '').trim();

  if (!product) return res.status(400).json({ error: 'product parameter required' });

  if (!LIVE_MODE) {
    // Demo fallback: return a few canned buyer results
    return res.json({
      success: true, total: 3, note: 'Demo mode — add BRAVE_API_KEY to .env for live results.',
      results: [
        { title:'GlobalBuyers Import Co.', link:'https://example.com/globalbuyers', displayLink:'globalbuyers.example.com', snippet:`Leading importer and wholesale buyer of ${product} serving ${country||'global'} markets.`, type:'importer', confidence:86, category:'direct' },
        { title:'RetailChain International', link:'https://example.com/retailchain', displayLink:'retailchain.example.com', snippet:`Major retail chain purchasing ${product} in bulk quantities for ${country||'international'} stores.`, type:'retailer', confidence:82, category:'direct' },
        { title:'TradeBridge Procurement', link:'https://example.com/tradebridge', displayLink:'tradebridge.example.com', snippet:`B2B procurement company sourcing ${product} on behalf of manufacturers in ${country||'multiple countries'}.`, type:'procurement', confidence:78, category:'direct' }
      ]
    });
  }

  const cc = country || '';
  const q1 = cc ? `${product} importer wholesale buyer ${cc}` : `${product} importer bulk buyer wholesale`;
  const q2 = cc ? `${product} procurement purchasing retailer ${cc} -site:alibaba.com` : `${product} procurement purchasing retailer B2B -site:alibaba.com`;
  const q3 = cc ? `${product} "looking for supplier" OR "request for quotation" OR "seeking manufacturer" ${cc}` : `${product} "request for quotation" OR "looking for supplier" B2B sourcing`;
  const q4 = cc ? `${product} import company distributor purchaser ${cc}` : `${product} import company buyer purchaser`;
  const q5 = cc ? `${product} retail chain supermarket buyer ${cc} -site:amazon.com` : `${product} retail chain wholesale buyer -site:amazon.com`;
  const q6 = cc ? `site:importyeti.com ${product} ${cc}` : `site:importyeti.com ${product}`;
  const q7 = cc ? `${product} "buying agent" OR "trading company" OR "sourcing company" ${cc}` : `${product} "buying agent" OR "sourcing company" OR "trading company"`;
  // q8: ACTIVE buying leads — posted buy requests / RFQs on B2B lead portals.
  // These are companies asking to buy right now, the strongest signal there is.
  const q8 = `${product}${cc ? ' ' + cc : ''} ("buy offer" OR "buying lead" OR "buy leads" OR "buyer inquiry" OR RFQ) (site:go4worldbusiness.com OR site:tradewheel.com OR site:tradekey.com OR site:ec21.com OR site:exporters.sg)`;
  // q9 & q10: simple queries LAST — braveMulti's DuckDuckGo fallback uses the
  // final queries, and DDG returns nothing for the boolean/site: ones above.
  const q9  = cc ? `${product} importers ${cc}` : `${product} importers`;
  const q10 = cc ? `${product} buyers ${cc}` : `${product} buyers`;

  try {
    const [r1,r2,r3,r4,r5,r6,r7,r8,r9,r10] = await braveMulti([
      { q:q1, country:cc }, { q:q2, country:cc }, { q:q3, country:cc }, { q:q4, country:cc },
      { q:q5, country:cc }, { q:q6 }, { q:q7, country:cc }, { q:q8 },
      { q:q9, country:cc }, { q:q10, country:cc }
    ]);

    // Map raw results to buyer objects
    const BUYER_NOISE = ['alibaba.com','aliexpress.com','amazon.com','ebay.com','indiamart.com',
      'made-in-china.com','dhgate.com','tradeindia.com','thomasnet.com'];

    const mapped = [r1,r2,r3,r4,r5,r6,r7,r8,r9,r10].flat().map(item => {
      const itemUrl    = item.url || item.link || '';
      const displayLink = itemUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
      const title      = item.title || '';
      const snippet    = item.description || item.snippet || '';
      const { type, confidence } = classifyBuyer(title, snippet, displayLink);
      const category   = categorise(displayLink, title, snippet);
      const thumbnail  = item.thumbnail?.src || null;
      // Flag results that look like an ACTIVE buy request (posted RFQ / buying
      // lead) rather than just a company that generally buys this product.
      const isRFQ = /buy offer|buying lead|buy leads?\b|buyer inquiry|request for quotation|\bRFQ\b|looking for suppliers?|seeking (?:a )?(?:supplier|manufacturer)|want(?:ed)? to buy/i.test(title + ' ' + snippet);
      return { title, link: itemUrl, snippet, displayLink, type, confidence, category, thumbnail, isRFQ };
    }).filter(r => r.link);

    // Deduplicate
    const seen = new Set(), seenDomain = new Map();
    const deduped = [];
    for (const r of mapped) {
      if (seen.has(r.link)) continue;
      seen.add(r.link);
      const dom = r.displayLink.toLowerCase();
      if (BUYER_NOISE.some(n => dom.includes(n))) continue;
      if (NOISE_DOMAINS.some(n => dom.includes(n))) continue;
      const dc = seenDomain.get(dom) || 0;
      if (dc >= 2) continue;
      seenDomain.set(dom, dc+1);
      deduped.push(r);
      if (deduped.length >= 40) break;
    }

    // Score: boost country matches
    const scored = deduped.map(r => {
      let s = r.confidence;
      const hay = (r.title + ' ' + r.snippet + ' ' + r.displayLink).toLowerCase();
      if (cc) {
        const matchers = countryMatchers(cc);
        if (matchers.some(a => hay.includes(a))) s += 20;
        const tld = COUNTRY_TLD[cc];
        if (tld && r.displayLink.toLowerCase().endsWith('.' + tld)) s += 15;
      }
      // Boost specific buyer signals
      if (/importer|wholesale buyer|procurement|purchasing/i.test(r.title)) s += 12;
      if (/request for quotation|looking for supplier|seeking manufacturer/i.test(r.title + ' ' + r.snippet)) s += 10;
      // Active buy requests outrank passive "this company buys X" results
      if (r.isRFQ) s += 25;
      return { ...r, score: s };
    });

    scored.sort((a,b) => b.score - a.score);

    const { results, note } = cc
      ? applyCountryFilter(scored, cc)
      : { results: scored, note: null };

    res.json({ success:true, total: results.length, note, results: results.slice(0, 35) });
  } catch (err) {
    res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});

app.get('/api/trust-check', async (req, res) => {
  const url  = (req.query.url  || '').trim();
  const name = (req.query.name || '').trim();
  let people = [];
  try { people = JSON.parse(req.query.people || '[]'); } catch(_) {}
  people = people.slice(0, 4); // max 4 people to avoid API quota burn

  if (!url && !name) return res.status(400).json({ error: 'url or name required' });

  // Demo example.com links — no real domain to check
  if (url.includes('example.com')) {
    const demoPeople = people.map(p => ({
      name: p, risk: 'unknown',
      findings: [{ type: 'info', text: 'ℹ️ Demo mode — add your Google API key to run real background checks on this person.' }]
    }));
    return res.json({
      score: null, rating: 'Demo Mode', ratingClass: 'trust-info', demoMode: true,
      findings: [{ type: 'info', text: 'ℹ️ This is sample demo data. For real companies the trust check examines HTTPS, domain age, Google Safe Browsing, scam/fraud reports, and individual background checks on key people.' }],
      searchLinks: [], reviewLinks: [], peopleResults: demoPeople
    });
  }

  const findings = [];
  let score = 100;

  // ── 1. HTTPS ────────────────────────────────────────────────────────
  if (url) {
    if (url.startsWith('https://')) {
      findings.push({ type: 'good', text: '✅ Website uses HTTPS (secure, encrypted connection)' });
    } else {
      findings.push({ type: 'warning', text: '⚠️ Website does not use HTTPS — connection is unencrypted' });
      score -= 15;
    }
  }

  // ── 2. Domain age via RDAP (free public registry data) ───────────────
  if (url) {
    try {
      const domain = new URL(url).hostname.replace(/^www\./, '');
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 6000);
      const rdapRes = await fetch(`https://rdap.org/domain/${domain}`, {
        headers: { Accept: 'application/json' }, signal: controller.signal
      });
      clearTimeout(tid);
      if (rdapRes.ok) {
        const rd = await rdapRes.json();
        const reg = (rd.events || []).find(e => e.eventAction === 'registration');
        if (reg) {
          const regDate = new Date(reg.eventDate);
          const ageYrs = (Date.now() - regDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
          if (ageYrs < 0.5) {
            findings.push({ type: 'danger', text: `🚨 Domain registered very recently (${regDate.toDateString()}) — under 6 months, high-risk indicator` });
            score -= 35;
          } else if (ageYrs < 1) {
            findings.push({ type: 'warning', text: `⚠️ Domain registered recently (${regDate.toDateString()}) — less than 1 year old` });
            score -= 15;
          } else {
            findings.push({ type: 'good', text: `✅ Domain established since ${regDate.getFullYear()} (${Math.floor(ageYrs)} year${Math.floor(ageYrs)===1?'':'s'} old)` });
          }
        }
      }
    } catch (_) { /* RDAP timed out or domain not found — skip */ }
  }

  // ── 3. Google Safe Browsing ────────────────────────────────────────
  if (url && GOOGLE_API_KEY) {
    try {
      const sbRes = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${GOOGLE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client: { clientId: 'product-source-search', clientVersion: '1.0' },
          threatInfo: {
            threatTypes: ['MALWARE','SOCIAL_ENGINEERING','UNWANTED_SOFTWARE','POTENTIALLY_HARMFUL_APPLICATION'],
            platformTypes: ['ANY_PLATFORM'], threatEntryTypes: ['URL'],
            threatEntries: [{ url }]
          }
        })
      });
      if (sbRes.ok) {
        const sbData = await sbRes.json();
        if (sbData.matches && sbData.matches.length) {
          const threatLabel = sbData.matches[0].threatType.replace(/_/g,' ').toLowerCase();
          findings.push({ type: 'danger', text: `🚨 Google Safe Browsing flagged this URL as: ${threatLabel}` });
          score -= 50;
        } else {
          findings.push({ type: 'good', text: '✅ Not flagged by Google Safe Browsing' });
        }
      }
    } catch (_) { /* Safe Browsing API not enabled — skip */ }
  }

  // ── 4. Web search: scam / fraud / complaints ─────────────────────
  let searchLinks = [], reviewLinks = [];
  const canWebSearch = (GOOGLE_API_KEY && GOOGLE_CX) || BRAVE_API_KEY;

  async function webSearch(q, num) {
    if (BRAVE_API_KEY) {
      const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${num}`, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY }
      });
      const d = await r.json();
      return (d.web && d.web.results || []).map(i => ({ title: i.title, url: i.url, snippet: i.description }));
    } else {
      const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(GOOGLE_API_KEY)}&cx=${encodeURIComponent(GOOGLE_CX)}&q=${encodeURIComponent(q)}&num=${num}`);
      const d = await r.json();
      return (d.items || []).map(i => ({ title: i.title, url: i.link, snippet: i.snippet }));
    }
  }

  if (name && canWebSearch) {
    try {
      const scamQ = `"${name}" (scam OR fraud OR complaint OR "stay away" OR "avoid" OR "not recommended" OR "ripoff")`;
      searchLinks = await webSearch(scamQ, 5);
      if (searchLinks.length) {
        findings.push({ type: 'warning', text: `⚠️ Found ${searchLinks.length} web result(s) mentioning complaints, scam, or fraud — see links below` });
        score -= Math.min(searchLinks.length * 8, 25);
      } else {
        findings.push({ type: 'good', text: '✅ No scam or fraud reports found in web search' });
      }
    } catch (_) {}

    try {
      const revQ = `"${name}" (reviews OR rating OR trustpilot OR "BBB" OR "better business bureau")`;
      reviewLinks = (await webSearch(revQ, 4)).map(i => ({ title: i.title, url: i.url }));
    } catch (_) {}
  }

  if (!canWebSearch) {
    findings.push({ type: 'info', text: 'ℹ️ Add a Brave or Google API key to .env for complaint web search' });
  }

  // ── 5. Per-person background checks ──────────────────────────────
  const peopleResults = [];
  if (people.length && canWebSearch) {
    for (const personName of people) {
      const personFindings = [];
      let personRisk = 'clean';

      try {
        const issueQ = `"${personName}" (scam OR fraud OR lawsuit OR convicted OR arrested OR "legal action" OR "court case" OR "criminal charges" OR indicted OR "money laundering" OR "securities fraud")`;
        const issueItems = await webSearch(issueQ, 5);
        if (issueItems.length) {
          personRisk = 'flagged';
          personFindings.push({ type: 'warning', text: `⚠️ Found ${issueItems.length} result(s) linked to legal issues, fraud, or scam`, links: issueItems });
          score -= Math.min(issueItems.length * 6, 20);
        } else {
          personFindings.push({ type: 'good', text: '✅ No scam or legal records found' });
        }
      } catch (_) {}

      if (name) {
        try {
          const newsQ = `"${personName}" "${name}" (news OR profile OR background OR CEO OR director OR founder)`;
          const newsLinks = (await webSearch(newsQ, 3)).map(i => ({ title: i.title, url: i.url || i.link }));
          if (newsLinks.length) personFindings.push({ type: 'info', text: `ℹ️ ${newsLinks.length} news / profile result(s) found`, links: newsLinks });
        } catch (_) {}
      }

      peopleResults.push({ name: personName, risk: personRisk, findings: personFindings });
    }
  } else if (people.length && !canWebSearch) {
    people.forEach(p => peopleResults.push({ name: p, risk: 'unknown', findings: [{ type: 'info', text: 'ℹ️ Add a Brave or Google API key to enable background checks on individuals' }] }));
  }

  let rating, ratingClass;
  if      (score >= 75) { rating = 'Appears Trustworthy';        ratingClass = 'trust-good';   }
  else if (score >= 45) { rating = 'Exercise Caution';           ratingClass = 'trust-warn';   }
  else                  { rating = 'High Risk — Verify Carefully'; ratingClass = 'trust-danger'; }

  // Company Brain: remember the trust verdict for this company
  try {
    const th = brainHost(new URL(url).host);
    if (th) recordCompanyBrain(th, { name, trustRating: rating, trustScore: score, event: 'trust-checked' });
  } catch (_) {}

  res.json({ score, rating, ratingClass, findings, searchLinks, reviewLinks, peopleResults, demoMode: false });
});

// Maps country names to Brave Search country codes
// Supported: AR AU AT BE BR CA CL DK FI FR DE GR HK IN ID IT JP KR MY MX NL NZ NO CN PL PT PH RU SA ZA ES SE CH TW TR GB US ALL
const COUNTRY_META = {
  // Asia
  'China':          { code: 'CN' }, 'India':         { code: 'IN' },
  'Japan':          { code: 'JP' }, 'South Korea':   { code: 'KR' },
  'Taiwan':         { code: 'TW' }, 'Malaysia':      { code: 'MY' },
  'Indonesia':      { code: 'ID' }, 'Philippines':   { code: 'PH' },
  'Singapore':      { code: 'ALL' }, 'Vietnam':      { code: 'ALL' },
  'Thailand':       { code: 'ALL' }, 'Bangladesh':   { code: 'ALL' },
  'Pakistan':       { code: 'ALL' }, 'Sri Lanka':    { code: 'ALL' },
  'Nepal':          { code: 'ALL' }, 'Myanmar':      { code: 'ALL' },
  'Cambodia':       { code: 'ALL' }, 'Laos':         { code: 'ALL' },
  'Mongolia':       { code: 'ALL' }, 'Brunei':       { code: 'ALL' },
  'Maldives':       { code: 'ALL' }, 'Bhutan':       { code: 'ALL' },
  'Timor-Leste':    { code: 'ALL' }, 'Uzbekistan':   { code: 'ALL' },
  'Kazakhstan':     { code: 'ALL' }, 'Kyrgyzstan':   { code: 'ALL' },
  'Tajikistan':     { code: 'ALL' }, 'Turkmenistan': { code: 'ALL' },
  'Afghanistan':    { code: 'ALL' },
  // Middle East
  'UAE':            { code: 'ALL' }, 'Saudi Arabia':  { code: 'SA' },
  'Turkey':         { code: 'TR' }, 'Israel':         { code: 'ALL' },
  'Iran':           { code: 'ALL' }, 'Iraq':          { code: 'ALL' },
  'Jordan':         { code: 'ALL' }, 'Kuwait':        { code: 'ALL' },
  'Qatar':          { code: 'ALL' }, 'Bahrain':       { code: 'ALL' },
  'Oman':           { code: 'ALL' }, 'Lebanon':       { code: 'ALL' },
  'Syria':          { code: 'ALL' }, 'Yemen':         { code: 'ALL' },
  'Palestine':      { code: 'ALL' }, 'Cyprus':        { code: 'ALL' },
  // Europe
  'Germany':        { code: 'DE' }, 'France':         { code: 'FR' },
  'United Kingdom': { code: 'GB' }, 'Italy':          { code: 'IT' },
  'Spain':          { code: 'ES' }, 'Netherlands':    { code: 'NL' },
  'Poland':         { code: 'PL' }, 'Portugal':       { code: 'PT' },
  'Belgium':        { code: 'BE' }, 'Sweden':         { code: 'SE' },
  'Switzerland':    { code: 'CH' }, 'Austria':        { code: 'AT' },
  'Norway':         { code: 'NO' }, 'Denmark':        { code: 'DK' },
  'Finland':        { code: 'FI' }, 'Greece':         { code: 'GR' },
  'Russia':         { code: 'RU' }, 'Ukraine':        { code: 'ALL' },
  'Czech Republic': { code: 'ALL' }, 'Romania':       { code: 'ALL' },
  'Hungary':        { code: 'ALL' }, 'Slovakia':      { code: 'ALL' },
  'Bulgaria':       { code: 'ALL' }, 'Croatia':       { code: 'ALL' },
  'Serbia':         { code: 'ALL' }, 'Slovenia':      { code: 'ALL' },
  'Lithuania':      { code: 'ALL' }, 'Latvia':        { code: 'ALL' },
  'Estonia':        { code: 'ALL' }, 'Albania':       { code: 'ALL' },
  'North Macedonia':{ code: 'ALL' }, 'Kosovo':        { code: 'ALL' },
  'Montenegro':     { code: 'ALL' }, 'Bosnia and Herzegovina': { code: 'ALL' },
  'Moldova':        { code: 'ALL' }, 'Georgia':       { code: 'ALL' },
  'Armenia':        { code: 'ALL' }, 'Azerbaijan':    { code: 'ALL' },
  'Belarus':        { code: 'ALL' }, 'Luxembourg':    { code: 'ALL' },
  'Malta':          { code: 'ALL' }, 'Iceland':       { code: 'ALL' },
  'Ireland':        { code: 'ALL' }, 'Andorra':       { code: 'ALL' },
  'Liechtenstein':  { code: 'ALL' }, 'Monaco':        { code: 'ALL' },
  'San Marino':     { code: 'ALL' },
  // Americas
  'USA':            { code: 'US' }, 'Canada':         { code: 'CA' },
  'Mexico':         { code: 'MX' }, 'Brazil':         { code: 'BR' },
  'Argentina':      { code: 'AR' }, 'Chile':          { code: 'CL' },
  'Colombia':       { code: 'ALL' }, 'Peru':          { code: 'ALL' },
  'Venezuela':      { code: 'ALL' }, 'Ecuador':       { code: 'ALL' },
  'Bolivia':        { code: 'ALL' }, 'Paraguay':      { code: 'ALL' },
  'Uruguay':        { code: 'ALL' }, 'Guyana':        { code: 'ALL' },
  'Suriname':       { code: 'ALL' }, 'Costa Rica':    { code: 'ALL' },
  'Panama':         { code: 'ALL' }, 'Guatemala':     { code: 'ALL' },
  'Honduras':       { code: 'ALL' }, 'El Salvador':   { code: 'ALL' },
  'Nicaragua':      { code: 'ALL' }, 'Cuba':          { code: 'ALL' },
  'Dominican Republic': { code: 'ALL' }, 'Jamaica':   { code: 'ALL' },
  'Trinidad and Tobago': { code: 'ALL' }, 'Belize':   { code: 'ALL' },
  'Haiti':          { code: 'ALL' }, 'Puerto Rico':   { code: 'ALL' },
  // Oceania
  'Australia':      { code: 'AU' }, 'New Zealand':    { code: 'NZ' },
  'Papua New Guinea':{ code: 'ALL' }, 'Fiji':         { code: 'ALL' },
  'Solomon Islands':{ code: 'ALL' }, 'Vanuatu':       { code: 'ALL' },
  // Africa
  'South Africa':   { code: 'ZA' }, 'Nigeria':        { code: 'ALL' },
  'Egypt':          { code: 'ALL' }, 'Kenya':         { code: 'ALL' },
  'Ethiopia':       { code: 'ALL' }, 'Ghana':         { code: 'ALL' },
  'Tanzania':       { code: 'ALL' }, 'Morocco':       { code: 'ALL' },
  'Algeria':        { code: 'ALL' }, 'Angola':        { code: 'ALL' },
  'Ivory Coast':    { code: 'ALL' }, 'Cameroon':      { code: 'ALL' },
  'Uganda':         { code: 'ALL' }, 'Mozambique':    { code: 'ALL' },
  'Zimbabwe':       { code: 'ALL' }, 'Zambia':        { code: 'ALL' },
  'Senegal':        { code: 'ALL' }, 'Tunisia':       { code: 'ALL' },
  'DRC':            { code: 'ALL' }, 'Congo':         { code: 'ALL' },
  'Namibia':        { code: 'ALL' }, 'Burkina Faso':  { code: 'ALL' },
  'Mali':           { code: 'ALL' }, 'Niger':         { code: 'ALL' },
  'Chad':           { code: 'ALL' }, 'Sudan':         { code: 'ALL' },
  'South Sudan':    { code: 'ALL' }, 'Somalia':       { code: 'ALL' },
  'Rwanda':         { code: 'ALL' }, 'Burundi':       { code: 'ALL' },
  'Malawi':         { code: 'ALL' }, 'Madagascar':    { code: 'ALL' },
  'Libya':          { code: 'ALL' }, 'Sierra Leone':  { code: 'ALL' },
  'Liberia':        { code: 'ALL' }, 'Togo':          { code: 'ALL' },
  'Benin':          { code: 'ALL' }, 'Guinea':        { code: 'ALL' },
  'Guinea-Bissau':  { code: 'ALL' }, 'Gabon':         { code: 'ALL' },
  'Equatorial Guinea': { code: 'ALL' }, 'Eritrea':    { code: 'ALL' },
  'Djibouti':       { code: 'ALL' }, 'Comoros':       { code: 'ALL' },
  'Cabo Verde':     { code: 'ALL' }, 'Mauritius':     { code: 'ALL' },
  'Mauritania':     { code: 'ALL' }, 'Seychelles':    { code: 'ALL' },
  'Eswatini':       { code: 'ALL' }, 'Lesotho':       { code: 'ALL' },
  'Botswana':       { code: 'ALL' }, 'Gambia':        { code: 'ALL' },
  'Sao Tome and Principe': { code: 'ALL' },
};

// ── Strict country filtering ──────────────────────────────────────────────────
// Brave's `country` param only *biases* results, it doesn't filter — so results
// from other countries leak in. We post-filter using country-name/alias mentions
// and ccTLD evidence to enforce the user's selected country.
//
// ccTLD per country (lowercased). For most this equals the ISO2 code; notable
// exception: United Kingdom uses ".uk", not ".gb".
const COUNTRY_TLD = {
  'China':'cn','India':'in','Japan':'jp','South Korea':'kr','Taiwan':'tw','Malaysia':'my',
  'Indonesia':'id','Philippines':'ph','Singapore':'sg','Vietnam':'vn','Thailand':'th',
  'Bangladesh':'bd','Pakistan':'pk','Sri Lanka':'lk','Nepal':'np','Myanmar':'mm',
  'Cambodia':'kh','Mongolia':'mn','Brunei':'bn','Kazakhstan':'kz','Uzbekistan':'uz',
  'Afghanistan':'af','UAE':'ae','Saudi Arabia':'sa','Turkey':'tr','Israel':'il','Iran':'ir',
  'Iraq':'iq','Jordan':'jo','Kuwait':'kw','Qatar':'qa','Bahrain':'bh','Oman':'om',
  'Lebanon':'lb','Syria':'sy','Yemen':'ye','Cyprus':'cy','Germany':'de','France':'fr',
  'United Kingdom':'uk','Italy':'it','Spain':'es','Netherlands':'nl','Poland':'pl',
  'Portugal':'pt','Belgium':'be','Sweden':'se','Switzerland':'ch','Austria':'at',
  'Norway':'no','Denmark':'dk','Finland':'fi','Greece':'gr','Russia':'ru','Ukraine':'ua',
  'Czech Republic':'cz','Romania':'ro','Hungary':'hu','Slovakia':'sk','Bulgaria':'bg',
  'Croatia':'hr','Serbia':'rs','Slovenia':'si','Lithuania':'lt','Latvia':'lv','Estonia':'ee',
  'Ireland':'ie','Iceland':'is','Luxembourg':'lu','Malta':'mt','Moldova':'md','Georgia':'ge',
  'Armenia':'am','Azerbaijan':'az','Belarus':'by','USA':'us','Canada':'ca','Mexico':'mx',
  'Brazil':'br','Argentina':'ar','Chile':'cl','Colombia':'co','Peru':'pe','Venezuela':'ve',
  'Ecuador':'ec','Bolivia':'bo','Paraguay':'py','Uruguay':'uy','Costa Rica':'cr','Panama':'pa',
  'Guatemala':'gt','Honduras':'hn','Dominican Republic':'do','Jamaica':'jm','Australia':'au',
  'New Zealand':'nz','Fiji':'fj','South Africa':'za','Nigeria':'ng','Egypt':'eg','Kenya':'ke',
  'Ethiopia':'et','Ghana':'gh','Tanzania':'tz','Morocco':'ma','Algeria':'dz','Angola':'ao',
  'Cameroon':'cm','Uganda':'ug','Mozambique':'mz','Zimbabwe':'zw','Zambia':'zm','Senegal':'sn',
  'Tunisia':'tn','Namibia':'na','Mali':'ml','Libya':'ly','Rwanda':'rw','Mauritius':'mu',
  'Madagascar':'mg','Botswana':'bw'
};
// Aliases / demonyms / major cities that indicate a country in free text.
const COUNTRY_ALIASES = {
  'USA':['usa','u.s.a','united states','u.s.','america','american'],
  'United Kingdom':['uk','u.k','united kingdom','britain','british','england','scotland','wales','london'],
  'UAE':['uae','u.a.e','united arab emirates','dubai','abu dhabi','sharjah','ajman','emirati','emirates'],
  'South Korea':['south korea','korea','korean','republic of korea','seoul'],
  'China':['china','chinese','prc','shenzhen','shanghai','guangzhou','beijing','ningbo','yiwu'],
  'Singapore':['singapore','singaporean'],
  'Saudi Arabia':['saudi arabia','saudi','riyadh','jeddah','ksa'],
  'Netherlands':['netherlands','holland','dutch','amsterdam','rotterdam'],
  'Germany':['germany','german','deutschland','berlin','munich','hamburg','frankfurt'],
  'India':['india','indian','mumbai','delhi','bangalore','chennai','gujarat','pune'],
  'Russia':['russia','russian','moscow'],
  'Czech Republic':['czech republic','czechia','czech','prague'],
  'Vietnam':['vietnam','vietnamese','hanoi','ho chi minh','saigon'],
  'Taiwan':['taiwan','taiwanese','taipei'],
  'Hong Kong':['hong kong','hk']
};
function countryMatchers(country) {
  const lc = country.toLowerCase();
  const list = COUNTRY_ALIASES[country] ? [...COUNTRY_ALIASES[country]] : [lc];
  if (!list.includes(lc)) list.push(lc);
  return list;
}

// Inverted ccTLD lookup (tld → country name) — last-resort fallback when a site
// publishes no contact info at all: the domain's country-code TLD is still a
// reasonably reliable signal of where the company is based.
const TLD_TO_COUNTRY = Object.fromEntries(Object.entries(COUNTRY_TLD).map(([c, t]) => [t, c]));
function countryFromHost(host = '') {
  const h = host.toLowerCase().replace(/^www\./, '');
  const labels = h.split('.');
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1];
  // .com.cn, .co.in, .co.uk style — the real ccTLD is the LAST label, already
  // captured above; this branch just avoids misreading "com"/"co" as the TLD.
  return TLD_TO_COUNTRY[tld] || null;
}

// Scan free text for a country name or known alias/demonym/major-city mention —
// used when structured address data isn't available so we can still surface
// "this company appears to be based in X" rather than nothing at all.
const ALL_COUNTRY_NAMES = Object.keys(COUNTRY_TLD);
function detectCountryFromText(text = '') {
  if (!text) return null;
  const lc = text.toLowerCase();
  // Prefer alias/demonym/city matches first (more specific, fewer false positives
  // than a bare country name appearing incidentally in unrelated prose).
  for (const [country, aliases] of Object.entries(COUNTRY_ALIASES)) {
    if (aliases.some(a => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lc))) {
      return country;
    }
  }
  for (const country of ALL_COUNTRY_NAMES) {
    if (new RegExp(`\\b${country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lc)) {
      return country;
    }
  }
  return null;
}
// Known ccTLDs that are clearly NOT a target country — used to detect SEO-keyword stuffing
// e.g. rajveerstainless.com (Indian) targeting "Germany" is not a German manufacturer
const INDIAN_SEO_DOMAINS = /\.(in|co\.in)$|rajveer|philips.?metal|prosaic.?steel|neelcon|metline|rexton|sachiya|kinnari|guru|shree|panchal|bhavya/i;

function resultInCountry(r, country) {
  if (!country) return true;
  const hay  = `${r.title || ''} ${r.snippet || ''} ${r.displayLink || ''}`.toLowerCase();
  const host = (r.displayLink || '').toLowerCase().split('/')[0];

  // 1) Domain uses the target country's ccTLD — most reliable signal
  const tld = COUNTRY_TLD[country];
  if (tld && (host.endsWith('.' + tld) || host.includes('.' + tld + '.'))) return true;

  // 2) Country name / alias / major city mentioned anywhere in text
  const matchers = countryMatchers(country);
  const mentionsCountry = matchers.some(a => {
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`, 'i').test(hay);
  });
  if (!mentionsCountry) return false;

  // 3) If country appears only in the title (likely SEO keyword stuffing) and the domain
  //    pattern looks like an Indian stainless-steel SEO farm, downgrade it.
  // We still include it (return true) so the result shows, but flag it for scoring.
  if (INDIAN_SEO_DOMAINS.test(host) && !['India','Pakistan','Bangladesh','Nepal','Sri Lanka'].includes(country)) {
    r._seoSpam = true;
  }
  return true;
}
// Apply country filter to a scored list. Strictly returns only in-country results.
function applyCountryFilter(results, country, { keep = () => false } = {}) {
  if (!country) return { results, note: null };
  const inC = results.filter(r => keep(r) || resultInCountry(r, country));
  return { results: inC, note: null };
}

// Extract actionable trade signals from a snippet
function extractSignals(title, snippet) {
  const text = (title + ' ' + snippet).replace(/\s+/g, ' ');
  const signals = [];

  // Price
  const priceM = text.match(/(?:USD?|US\$|\$|€|£|¥|CNY|INR|₹)\s*[\d,.]+(?: ?[-–] ?(?:USD?|US\$|\$|€|£|¥|CNY|INR|₹)?\s*[\d,.]+)?(?:\s*\/\s*(?:pc|pcs|piece|unit|kg|mt|ton|set|roll|yard|meter|m))?/i)
    || text.match(/[\d,.]+ ?(?:USD|EUR|GBP|CNY|INR)(?:\s*\/\s*(?:pc|pcs|piece|unit|kg|mt|set))?/i);
  if (priceM) signals.push({ type: 'price', label: priceM[0].trim() });

  // MOQ
  const moqM = text.match(/MOQ[:\s]+[\d,]+ ?(?:pcs?|pieces?|units?|sets?|kg|mt|tons?|meters?|yards?)?/i)
    || text.match(/minimum order[:\s]+[\d,]+ ?(?:pcs?|pieces?|units?|sets?|kg|mt)?/i)
    || text.match(/min(?:imum)? ?(?:order)?[:\s]+[\d,]+ ?(?:pcs?|units?|sets?|kg)?/i);
  if (moqM) signals.push({ type: 'moq', label: moqM[0].trim() });

  // Certifications
  const certs = [];
  const certPatterns = [
    /ISO\s*\d{3,5}(?::\d{4})?/gi, /CE\b/g, /\bRoHS\b/gi, /\bGOTS?\b/gi,
    /\bHACCP\b/gi, /\bGMP\b/gi, /\bFDA\b/gi, /\bUL\b/g, /\bBIS\b/g,
    /\bASTM\b/gi, /\bDIN\b/g, /\bJIS\b/g, /\bBSCI\b/gi, /\bOEKO-TEX\b/gi,
    /\bFSC\b/g, /\bReach\b/gi, /\bTS\s*16949\b/gi, /\bIATF\b/gi,
    /\bUL\s*listed\b/gi, /\bUL\s*certified\b/gi
  ];
  for (const pat of certPatterns) {
    const m = text.match(pat);
    if (m) m.forEach(c => certs.push(c.trim()));
  }
  if (certs.length) signals.push({ type: 'cert', label: [...new Set(certs)].slice(0, 4).join(' · ') });

  // Lead time / delivery
  const ltM = text.match(/(?:lead time|delivery|ship|dispatch)[:\s]+\d+[-–]?\d*\s*(?:days?|weeks?|business days?)/i)
    || text.match(/ready to ship in\s+\d+[-–]?\d*\s*(?:days?|weeks?)/i)
    || text.match(/\d+[-–]\d+\s*(?:days?|weeks?)\s*(?:delivery|lead time|shipping)/i);
  if (ltM) signals.push({ type: 'leadtime', label: ltM[0].trim() });

  // Location / city
  const locM = text.match(/(?:located in|based in|factory in|plant in|headquartered in)[:\s]+([A-Z][a-zA-Z\s,]{3,40})/i);
  if (locM) signals.push({ type: 'location', label: locM[1].trim().slice(0, 35) });

  // Year established
  const yrM = text.match(/(?:est(?:ablished)?\.?|since|founded|incorporated)\s*(?:in\s*)?((?:19|20)\d{2})\b/i);
  if (yrM) signals.push({ type: 'since', label: 'Est. ' + yrM[1] });

  // Capacity / output
  const capM = text.match(/(?:annual|monthly|daily)\s+(?:capacity|output|production)[:\s]+[\d,.]+ ?(?:MT|tons?|pcs|units?|m²|sqm)?/i);
  if (capM) signals.push({ type: 'capacity', label: capM[0].trim() });

  // Export experience
  if (/export(?:er|ing|s)?\s+(?:to|since|for)/i.test(text)) signals.push({ type: 'export', label: 'Exporter' });

  return signals;
}

// Categorise a result so the frontend can separate direct sites from directories
function categorise(displayLink, title, snippet) {
  const dom = (displayLink || '').toLowerCase();
  const MARKETPLACES = [
    'alibaba.com', 'aliexpress.com', 'made-in-china.com', 'indiamart.com',
    'tradeindia.com', 'ec21.com', 'tradekey.com', 'dhgate.com',
    'global-sources.com', 'globalsources.com', '1688.com', 'diytrade.com',
    'exportersindia.com', 'b2bmart.com', 'esources.co.uk',
    'goldsupplier.com',   // Alibaba Gold Supplier subdomain pages
    'europages.com', 'europages.co.uk', 'kompass.com', 'directindustry.com',
    'thomasnet.com', 'wer-liefert-was.de', 'yellowpages.com', 'mfgpages.com',
    'exporters.sg', 'go4worldbusiness.com', 'tradewheel.com'
  ];
  if (MARKETPLACES.some(m => dom.includes(m))) return 'marketplace';
  if (/linkedin\.com/i.test(dom)) return 'linkedin';
  return 'direct';
}

// ── Service health tracker ─────────────────────────────────────────────────────
// Records the outcome of every Brave and Gemini call so the dashboard can show
// a live green/amber/red indicator. Counters reset each calendar day.
const svcStatus = {
  brave:  { date: '', count: 0, status: 'unknown', detail: '', ts: 0 },
  gemini: { date: '', count: 0, status: 'unknown', detail: '', ts: 0 }
};
function recordSvc(name, status, detail = '') {
  const s = svcStatus[name];
  if (!s) return;
  const today = new Date().toISOString().slice(0, 10);
  if (s.date !== today) { s.date = today; s.count = 0; }
  s.count++;
  s.status = status;   // 'ok' | 'rate-limited' | 'quota' | 'error'
  s.detail = String(detail).slice(0, 160);
  s.ts = Date.now();
}

app.get('/api/service-status', (req, res) => {
  res.json({
    brave: {
      configured: Boolean(BRAVE_API_KEY),
      ...svcStatus.brave
    },
    gemini: {
      configured: Boolean(GEMINI_KEY || OPENAI_KEY),
      // Known ceiling on the free tier — lets the UI warn BEFORE hitting the wall.
      freeTierDailyLimit: 20,
      ...svcStatus.gemini
    }
  });
});

async function searchBrave(query, country, count = 20, offset = 0) {
  const meta = country ? COUNTRY_META[country] : null;
  const params = new URLSearchParams({ q: query, count: String(Math.min(count, 20)) });
  if (offset > 0) params.set('offset', String(Math.min(offset, 9)));
  if (meta && meta.code !== 'ALL') {
    params.set('country', meta.code);
  }
  const url = `https://api.search.brave.com/res/v1/web/search?${params.toString()}`;

  // Retry up to 3 times on transient errors (429 rate-limit, 5xx). Brave's free
  // tier allows ~1 req/sec, so a brief backoff turns a hard failure into a success.
  let data, resp, lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      resp = await fetch(url, {
        headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': BRAVE_API_KEY }
      });
      if (resp.status === 402) recordSvc('brave', 'quota', 'HTTP 402 — subscription/quota exhausted');
      else if (resp.status === 429) recordSvc('brave', 'rate-limited', 'HTTP 429 — request rate too high');
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new Error(`Brave Search ${resp.status}`);
        await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      data = await resp.json();
      if (!resp.ok) throw new Error((data && data.message) || `Brave Search error (${resp.status})`);
      recordSvc('brave', 'ok');
      break;
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!data) throw (lastErr || new Error('Brave Search failed'));

  return (data.web && data.web.results || []).map(item => {
    const itemUrl = item.url || '';
    const displayLink = itemUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
    const title = item.title || '';
    const snippet = item.description || '';
    const { type, confidence } = classify(title, snippet, displayLink, itemUrl);
    const thumbnail = (item.thumbnail && item.thumbnail.src) ? item.thumbnail.src : null;
    const signals = extractSignals(title, snippet);
    const category = categorise(displayLink, title, snippet);
    const age = item.age || item.page_age || null;
    return { title, link: itemUrl, snippet, displayLink, type, confidence, thumbnail, signals, category, age };
  });
}

// Google Custom Search fallback — used when BRAVE_API_KEY is absent
async function searchDDG(query, count = 10) {
  try {
    const r = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ErezImpex/1.0)', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) { console.warn(`[searchDDG] HTTP ${r.status}`); return []; }
    const html = await r.text();
    const $ = cheerio.load(html);
    const out = [];
    $('.result').each((_, el) => {
      if (out.length >= count) return false;
      const titleEl = $(el).find('.result__title a');
      const snippetEl = $(el).find('.result__snippet');
      const title = titleEl.text().trim();
      const snippet = snippetEl.text().trim();
      let link = titleEl.attr('href') || '';
      if (link.startsWith('//duckduckgo.com/l/?')) {
        try { link = new URL('https:' + link).searchParams.get('uddg') || link; } catch {}
      }
      if (!link || !title) return;
      const displayLink = link.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
      const { type, confidence } = classify(title, snippet, displayLink, link);
      const signals = extractSignals(title, snippet);
      const category = categorise(displayLink, title, snippet);
      out.push({ title, link, snippet, displayLink, type, confidence, signals, category, thumbnail: null, age: null });
    });
    console.log(`[searchDDG] "${query.slice(0,50)}" → ${out.length} results`);
    return out;
  } catch (err) { console.warn(`[searchDDG] error: ${err.message}`); return []; }
}

async function searchGoogle(query, count = 10) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) return [];
  try {
    const r = await fetch(
      `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(GOOGLE_API_KEY)}&cx=${encodeURIComponent(GOOGLE_CX)}&q=${encodeURIComponent(query)}&num=${Math.min(count, 10)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) { console.warn(`[searchGoogle] HTTP ${r.status} for "${query.slice(0,40)}"`); return []; }
    const d = await r.json();
    const items = d.items || [];
    console.log(`[searchGoogle] "${query.slice(0,50)}" → ${items.length} results (total=${d.searchInformation?.totalResults}, err=${d.error?.code})`);
    return items.map(item => {
      const itemUrl = item.link || '';
      const displayLink = item.displayLink || itemUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
      const title = item.title || '';
      const snippet = item.snippet || '';
      const { type, confidence } = classify(title, snippet, displayLink, itemUrl);
      const signals = extractSignals(title, snippet);
      const category = categorise(displayLink, title, snippet);
      return { title, link: itemUrl, snippet, displayLink, type, confidence, signals, category, thumbnail: null, age: null };
    });
  } catch (err) { console.warn(`[searchGoogle] error: ${err.message}`); return []; }
}

// Run several Brave queries resiliently — a failure in one query never kills the
// whole search; we just use whatever results the successful queries returned.
// Falls back to Google Custom Search when BRAVE_API_KEY is absent.
async function braveMulti(queries) {
  if (BRAVE_API_KEY) {
    const settled = await Promise.allSettled(
      queries.map(({ q, country = null, offset = 0 }) => searchBrave(q, country, 20, offset))
    );
    const results = settled.map(s => (s.status === 'fulfilled' ? s.value : []));
    const totalResults = results.reduce((n, r) => n + r.length, 0);
    // If ALL queries returned nothing (likely 402 quota/billing issue), fall back to Google
    if (totalResults === 0) {
      if (GOOGLE_API_KEY && GOOGLE_CX) {
        console.warn('[braveMulti] Brave returned 0 results — falling back to Google Search');
        const googleResults = [];
        for (const { q } of queries) googleResults.push(await searchGoogle(q, 10));
        const googleTotal = googleResults.reduce((n, r) => n + r.length, 0);
        if (googleTotal > 0) return googleResults;
        console.warn('[braveMulti] Google also returned 0 results — falling back to DuckDuckGo');
      } else {
        console.warn('[braveMulti] Brave returned 0 results — falling back to DuckDuckGo');
      }
      // Brave/Google both down — squeeze the most out of DuckDuckGo (our free
      // engine). DDG chokes on boolean/site: operators, so simplify each query
      // to plain keywords, then run several DISTINCT ones and dedup. This lifts
      // "degraded mode" from ~2 queries' worth of results to the full breadth.
      const simplify = (q) => q
        .replace(/\bsite:[^\s)]+/gi, ' ')          // drop site: filters
        .replace(/-\S+/g, ' ')                      // drop -exclusions
        .replace(/\([^)]*\bOR\b[^)]*\)/gi, ' ')     // drop (A OR B) groups
        .replace(/\bOR\b/gi, ' ')                   // drop stray OR
        .replace(/"/g, ' ')                          // drop quotes
        .replace(/\s+/g, ' ').trim();
      const ddgSeen = new Set();
      const ddgQueries = [];
      for (const { q } of queries) {
        const sq = simplify(q);
        if (sq && !ddgSeen.has(sq.toLowerCase())) { ddgSeen.add(sq.toLowerCase()); ddgQueries.push(sq); }
        if (ddgQueries.length >= 6) break;          // cap for speed (~1 req/sec each)
      }
      const ddgResults = [];
      for (const q of ddgQueries) {
        ddgResults.push(await searchDDG(q, 12));
        await new Promise(r => setTimeout(r, 300)); // gentle pacing
      }
      // Last resort: bare simplest query if everything came up empty
      if (ddgResults.every(r => r.length === 0)) {
        const bare = simplify(queries[queries.length - 1].q);
        if (bare) ddgResults.push(await searchDDG(bare, 12));
      }
      // Spread the DDG results across all query slots so dedup/scoring still works
      const merged = ddgResults.flat();
      return queries.map((_, i) => (i < ddgResults.length ? ddgResults[i] : merged));

    }
    return results;
  }
  // No Brave key — try Google then DDG
  const results = [];
  for (const { q } of queries) {
    const gr = await searchGoogle(q, 10);
    results.push(gr.length ? gr : await searchDDG(q, 10));
  }
  return results;
}

function deduplicateResults(arrays, { maxPerDomain = 2, limit = 25, noiseFilter = true } = {}) {
  const seen = new Set();
  const seenDomain = new Map();
  const out = [];
  for (const item of arrays.flat()) {
    if (!item.link) continue;
    if (seen.has(item.link)) continue;
    seen.add(item.link);
    const dom = (item.displayLink || '').toLowerCase();
    if (noiseFilter && NOISE_DOMAINS.some(d => dom.includes(d))) continue;
    const domCount = seenDomain.get(dom) || 0;
    if (domCount >= maxPerDomain) continue;
    seenDomain.set(dom, domCount + 1);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

// Words that are never part of a real person's name — if a captured "name"
// contains any of these, it's a prose fragment (e.g. "and Executive Vice"), not a person.
const NON_NAME_WORDS = new Set([
  'and','or','the','of','for','to','in','at','on','with','from','by','our','your','their','its',
  'a','an','as','is','are','was','were','be','we','us','you','he','she','they','this','that',
  'including','include','key','decision','decisions','team','teams','member','members','staff',
  'group','company','companies','corporation','corp','inc','ltd','llc','gmbh','co','holdings',
  'executive','executives','chief','officer','officers','president','vice','senior','junior',
  'board','management','leadership','director','directors','manager','managers','head','heads',
  'ceo','cfo','cto','coo','cmo','founder','founders','chairman','chairwoman','owner','partner',
  'global','international','national','regional','worldwide','corporate','department','division',
  'about','contact','overview','news','profile','services','products','solutions','industries',
  'meet','learn','more','read','view','see','all','other','new','top','best','list','people',
  // Geographic / business-unit words — "Asia Pacific", "Greater China", "Customer Service"
  'asia','pacific','europe','european','america','american','africa','african','china','chinese',
  'india','indian','japan','korea','greater','middle','east','west','north','south','central',
  'energy','mobility','healthineers','customer','service','strategy','diagnostic','imaging',
  'digital','financial','cloud','security','enterprise','consumer','retail','wholesale','unit'
]);

// Strictly validate that a captured string looks like a real human name.
function isValidPersonName(raw) {
  if (!raw) return false;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 4 || name.length > 40) return false;
  const words = name.split(' ');
  if (words.length < 2 || words.length > 4) return false;
  for (const w of words) {
    // Each word: a capital letter, then letters/'/- (allow "McAdam", "O'Neil", "Jean-Luc")
    if (!/^[A-Z][a-zA-Z'’\-.]*[a-zA-Z'’]$|^[A-Z][a-zA-Z]$/.test(w)) return false;
    if (NON_NAME_WORDS.has(w.toLowerCase().replace(/[.'’\-]/g, ''))) return false;
    // Reject ALL-CAPS tokens longer than 1 char (acronyms/titles, e.g. "USA", "CEO")
    if (w.length > 1 && w === w.toUpperCase() && /[A-Z]{2,}/.test(w)) return false;
  }
  return true;
}

// Clean a raw title string into a concise role label.
function cleanRoleTitle(raw) {
  if (!raw) return '';
  let t = raw.trim().replace(/\s+/g, ' ').replace(/\s*\|\s*linkedin.*$/i, '');
  // Cut at the company/"at"/"@" boundary so we keep just the role
  t = t.replace(/\s+(at|@|—|–|-)\s+.*$/i, '').trim();
  if (t.length > 48) t = t.slice(0, 48).trim();
  return t;
}

// ── Company key-people lookup ─────────────────────────────────────────────────
app.get('/api/company-people', async (req, res) => {
  const company = (req.query.company || '').trim();
  if (!company) return res.status(400).json({ error: 'company required' });

  const EXEC_TITLES = ['Chief Executive Officer','CEO','Chief Operating Officer','COO',
    'Chief Financial Officer','CFO','Chief Technology Officer','CTO','Chief Marketing Officer','CMO',
    'Co-Founder','Founder','President','Vice President','Chairman','Chairwoman',
    'Managing Director','General Manager','Sales Director','Marketing Director',
    'Head of Sales','Head of Marketing','Director','Owner','Partner'];

  const titleOr = '(CEO OR Founder OR "Managing Director" OR President OR Chairman OR "Chief Executive" OR director OR owner)';
  // Mix of: people-listing pages, LinkedIn profiles, and structured directories.
  const q1 = `"${company}" leadership team executives`;
  const q2 = `"${company}" ${titleOr}`;
  const q3 = `"${company}" site:linkedin.com/in`;
  const q4 = `"${company}" (management OR "board of directors" OR "our team" OR "key people")`;

  try {
    const [r1, r2, r3, r4] = await braveMulti([
      { q: q1 }, { q: q2 }, { q: q3 }, { q: q4 }
    ]);

    // Company-name tokens — used to reject (a) people who merely share the company
    // surname ("Samuel Bosch" when searching Bosch) and (b) division/place "names"
    // like "Siemens Greater China". Real executives won't have the company name as
    // one of their name words.
    const companyTokens = new Set(
      company.toLowerCase().split(/\s+/).filter(w => w.length > 2)
        .filter(w => !['the','and','llc','ltd','inc','corp','gmbh','group','company','co'].includes(w))
    );

    const people = [];
    const seenNames = new Set();
    const addPerson = (name, title, source, sourceUrl) => {
      const clean = (name || '').trim().replace(/\s+/g, ' ');
      if (!isValidPersonName(clean)) return false;
      // Reject if any name word IS a company token (named-after-company / division names)
      const nameWords = clean.toLowerCase().split(' ').map(w => w.replace(/[.'’\-]/g, ''));
      if (nameWords.some(w => companyTokens.has(w))) return false;
      const key = clean.toLowerCase();
      if (seenNames.has(key)) return false;

      // Clean the title; if it's empty or just the company name, use a neutral label.
      let role = cleanRoleTitle(title);
      const roleLc = role.toLowerCase();
      const roleIsCompany = role && [...companyTokens].some(t => roleLc === t || roleLc.includes(t)) && role.split(' ').length <= 2;
      if (!role || roleIsCompany) role = 'Executive / Team';

      seenNames.add(key);
      people.push({ name: clean, title: role, source, sourceUrl });
      return true;
    };

    const titlePattern = EXEC_TITLES.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    // "Name, Title" / "Name - Title" / "Name | Title"
    const patA = new RegExp(`([A-Z][a-zA-Z'’.\\-]+(?:\\s[A-Z][a-zA-Z'’.\\-]+){1,2})\\s*[,\\-–—|:]\\s*(${titlePattern})`, 'g');
    // "Title Name" e.g. "CEO John Smith" / "President Jane Doe"
    const patB = new RegExp(`(?:^|[\\s,.])(${titlePattern})\\s+([A-Z][a-zA-Z'’.\\-]+(?:\\s[A-Z][a-zA-Z'’.\\-]+){1,2})`, 'g');

    const processText = (text, source, sourceUrl) => {
      let m;
      patA.lastIndex = 0;
      while ((m = patA.exec(text)) !== null) addPerson(m[1], m[2], source, sourceUrl);
      patB.lastIndex = 0;
      while ((m = patB.exec(text)) !== null) addPerson(m[2], m[1], source, sourceUrl);
    };

    // LinkedIn profile: title is usually "Name - Role - Company | LinkedIn"
    const extractLinkedIn = (r) => {
      const titleM = (r.title || '').match(/^([^|–—-]+?)\s*[-–—]\s*(.+?)(?:\s*[-–—|]|$)/);
      if (titleM && addPerson(titleM[1], titleM[2], 'LinkedIn', r.link)) return;
      // Fallback: derive name from the /in/<slug>
      const slugM = (r.link || '').match(/linkedin\.com\/in\/([a-z0-9\-]+)/i);
      if (slugM) {
        const nameFromSlug = slugM[1].replace(/-\d+$/, '').split('-')
          .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        addPerson(nameFromSlug, '(LinkedIn Profile)', 'LinkedIn', r.link);
      }
    };

    // Crunchbase / ZoomInfo person profiles: "John Smith - CEO @ Company - Crunchbase..."
    const extractDirectory = (r) => {
      const titleM = (r.title || '').match(/^([^|–—-]+?)\s*[-–—]\s*(.+?)(?:\s*(?:@|at)\s|[-–—|]|$)/);
      if (titleM) addPerson(titleM[1], titleM[2], r.displayLink, r.link);
    };

    for (const r of [...r1, ...r2, ...r3, ...r4]) {
      const url = (r.link || '').toLowerCase();
      if (url.includes('linkedin.com/in/')) extractLinkedIn(r);
      else if (/crunchbase|zoominfo|theorg\.com|rocketreach/.test(url)) extractDirectory(r);
      else processText(((r.title || '') + '. ' + (r.snippet || '')), r.displayLink || r.link, r.link);
    }

    res.json({ company, people: people.slice(0, 12) });
  } catch (err) {
    res.status(500).json({ error: 'People lookup failed: ' + err.message });
  }
});

// Short-TTL cache for search results, keyed by the full query combination.
// Repeat searches (refresh, back-button, two colleagues searching the same term)
// currently re-run the whole multi-query pipeline — wasted seconds and, once the
// Brave subscription is active, wasted paid quota. 10 min is short enough that
// results stay fresh, long enough to absorb the repeat-search pattern.
// ── Company registry extraction ───────────────────────────────────────────────
// Registry-listing sites (ACRA resellers for SG, OpenCorporates, etc.) publish
// structured facts in their snippets: registration number, incorporation date,
// entity status. Parse those out into a verified "registry" block instead of
// leaving them buried in result text. Only trusted registry domains are read.
const REGISTRY_DOMAINS = /sgpbusiness\.com|opengovsg\.com|companies\.sg|sgpgrid\.com|ltddir\.com|singapore-corp\.com|opencorporates\.com|recordowl\.com|zaubacorp\.com|tofler\.in/i;

function extractRegistryInfo(results) {
  const reg = { uen: null, incorporated: null, status: null, entityType: null, source: null, sourceLink: null };
  for (const r of results) {
    if (!REGISTRY_DOMAINS.test(r.displayLink || '')) continue;
    const text = `${r.title || ''} ${r.snippet || ''}`;

    if (!reg.uen) {
      // SG UEN in a title like "EREZ IMPEX PTE. LTD. (200702352E)" or "UEN 200702352E";
      // generic registration-number labels for other registries.
      const uenM = text.match(/\(([0-9]{8,10}[A-Z])\)/) ||
                   text.match(/(?:UEN|UEN ID|Registration Number|Reg(?:istration)?\.? No\.?)[:\s]+([0-9]{8,10}[A-Z]?)/i);
      if (uenM) reg.uen = uenM[1];
    }
    if (!reg.incorporated) {
      const incM = text.match(/incorporat\w*\s+(?:on|in|date is)?\s*([0-9]{1,2}\s+\w+\s+[0-9]{4}|\w+\s+[0-9]{1,2},?\s+[0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i);
      if (incM) reg.incorporated = incM[1];
    }
    if (!reg.status) {
      const stM = text.match(/status is\s+(Live Company|Live|Struck Off|Dissolved|Active|Inactive|Wound Up|In Liquidation)/i) ||
                  text.match(/\b(Live Company|Struck Off|In Liquidation|Wound Up)\b/i);
      if (stM) reg.status = stM[1];
    }
    if (!reg.entityType) {
      const etM = text.match(/\b(Exempt Private Company Limited by Shares|Private Company Limited by Shares|Public Company Limited by Shares|Limited Liability Partnership|Sole Proprietor(?:ship)?|Local Company)\b/i);
      if (etM) reg.entityType = etM[1];
    }
    if (!reg.source) { reg.source = r.displayLink; reg.sourceLink = r.link; }
    if (reg.uen && reg.incorporated && reg.status && reg.entityType) break;
  }
  return reg.uen || reg.incorporated || reg.status ? reg : null;
}

const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;
const searchCache = new Map();

app.get('/api/search', async (req, res) => {
  const subject = (req.query.q || '').trim();
  const country = (req.query.country || '').trim();
  const company = (req.query.company || '').trim();
  const person  = (req.query.person  || '').trim();
  const gender  = (req.query.gender  || '').trim().toLowerCase(); // 'male', 'female', or ''
  const website = (req.query.website || '').trim(); // optional known company website
  const regno   = (req.query.regno   || '').trim(); // optional registration number / UEN

  if (!subject && !country && !company && !person && !regno) {
    return res.status(400).json({ error: 'Please provide a product subject, a country, a company name, or a person name to search.' });
  }

  const searchKey = JSON.stringify([subject, country, company, person, gender, website, regno]).toLowerCase();
  const cachedSearch = searchCache.get(searchKey);
  if (cachedSearch && (Date.now() - cachedSearch.time) < SEARCH_CACHE_TTL_MS) {
    return res.json({ ...cachedSearch.data, cached: true });
  }
  // Intercept the outgoing JSON so every success path below populates the cache
  // without having to touch each return statement individually.
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (body && !body.error && Array.isArray(body.results) && body.results.length) {
      if (searchCache.size >= SEARCH_CACHE_MAX) {
        // Evict the oldest entry (Map preserves insertion order)
        searchCache.delete(searchCache.keys().next().value);
      }
      searchCache.set(searchKey, { data: body, time: Date.now() });
    }
    return origJson(body);
  };

  if (!LIVE_MODE) {
    let results;
    if (person)  results = searchDemoByPersonName(person);
    else if (company) results = searchDemoByCompanyName(company);
    else results = searchDemo(subject, country);
    return res.json({ subject, country, company, person, count: results.length, results, demoMode: true });
  }

  // Build a tight, country-specific query
  const meta = country ? COUNTRY_META[country] : null;
  let query;
  if (person) {
    const countryClause = country ? ` "${country}"` : '';
    const genderClause  = gender === 'male'   ? ' (he OR his OR him OR "Mr." OR businessman OR "male")' :
                          gender === 'female' ? ' (she OR her OR "Ms." OR "Mrs." OR businesswoman OR "female")' : '';
    // q1: LinkedIn profile (most reliable source for professionals)
    const q1 = `"${person}" linkedin${countryClause}${genderClause}`;
    // q2: executive/role titles — find their company position
    const q2 = `"${person}" (CEO OR director OR founder OR owner OR president OR chairman OR manager OR partner)${countryClause}${genderClause}`;
    // q3: general professional presence — news, company pages, interviews
    const q3 = `"${person}" (company OR business OR contact OR email OR interview OR biography)${countryClause}${genderClause}`;
    // q4: structured professional directories
    const q4 = `"${person}" (crunchbase OR zoominfo OR bloomberg OR "executive profile" OR "board member")${countryClause}${genderClause}`;
    // q5 & q6: simple DDG-friendly fallback queries (no complex boolean operators)
    const q5 = `${person} biography${countryClause}`;
    const q6 = `${person}${countryClause}`;
    try {
      const [r1, r2, r3, r4, r5, r6] = await braveMulti([
        { q: q1, country }, { q: q2, country }, { q: q3, country }, { q: q4, country },
        { q: q5, country }, { q: q6, country }
      ]);

      const nameLower = person.toLowerCase();
      const nameParts = nameLower.split(/\s+/).filter(Boolean);
      // Score every candidate first, then dedup so the best page per domain wins.
      const scoredAll = [
        ...r1.map(r=>({...r,_qs:3})), ...r2.map(r=>({...r,_qs:2})),
        ...r3.map(r=>({...r,_qs:1})), ...r4.map(r=>({...r,_qs:2})),
        ...r5.map(r=>({...r,_qs:2})), ...r6.map(r=>({...r,_qs:1}))
      ].map(r => {
          const url     = (r.link    || '').toLowerCase();
          const title   = (r.title   || '').toLowerCase();
          const snippet = (r.snippet || '').toLowerCase();
          let score = r._qs * 10;
          if (url.includes('linkedin.com/in'))                           score += 45;
          else if (url.includes('linkedin.com'))                         score += 25;
          if (/crunchbase|zoominfo|bloomberg|dnb\.com/.test(url))        score += 18;
          if (url.includes(nameLower.replace(/\s+/g, '-')))             score += 20;
          if (title.includes(nameLower))                                 score += 15;
          if (snippet.includes(nameLower))                               score += 8;
          if (/ceo|director|founder|owner|president|chairman|manager|partner/i.test(title + snippet)) score += 10;
          if (/email|phone|contact|\+\d/.test(snippet))                 score += 6;
          // Relevance: at least one name part must appear somewhere
          const mentions = nameParts.some(p => title.includes(p) || snippet.includes(p) || url.includes(p));
          return { ...r, _score: score, _relevant: mentions };
        });

      const relevantP = scoredAll.filter(r => r._relevant);
      const poolP = relevantP.length >= 4 ? relevantP : scoredAll;
      poolP.sort((a, b) => b._score - a._score);

      const scoredP = deduplicateResults([poolP], { maxPerDomain: 2, limit: 24, noiseFilter: false })
        .map(r => { const { _qs, _score, _relevant, ...rest } = r; return { ...rest, type: 'person', confidence: null }; });

      const { results: scored, note: countryNote } = applyCountryFilter(scoredP, country);
      return res.json({ subject: '', country, company: '', person, count: scored.length, results: scored, countryNote, demoMode: false });
    } catch(err) {
      return res.status(500).json({ error: 'Person search failed: ' + err.message });
    }
  } else if (company || regno) {
    const countryClause = country ? ` "${country}"` : '';
    const brand = stripLegalSuffix(company) || company; // "Erez Pte Ltd" → "Erez"

    // If the user supplied a known website, normalise it to host + origin and make it
    // the authoritative source.
    let wantHost = null, wantOrigin = null;
    if (website) {
      let w = website.trim();
      if (!/^https?:\/\//i.test(w)) w = 'https://' + w;
      try { const u = new URL(w); wantHost = u.host.replace(/^www\./, '').toLowerCase(); wantOrigin = u.origin; } catch (_) {}
    }
    const siteClause = wantHost ? ` site:${wantHost}` : '';

    // q1: official website / homepage — try exact name first, brand as fallback
    const cq1 = `"${company}" (official website OR homepage OR "official site")${countryClause}`;
    // q2: company profile / about / overview
    const cq2 = `"${company}" (about OR "company profile" OR overview OR "who we are" OR headquarters)${countryClause}`;
    // q3: contact details
    const cq3 = `"${company}" (contact OR phone OR email OR address)${countryClause}`;
    // q4: authoritative structured sources — LinkedIn, Crunchbase, Wikipedia, Bloomberg
    const cq4 = `"${company}" company (linkedin OR crunchbase OR wikipedia OR bloomberg OR "dun & bradstreet")${countryClause}`;
    // q5: brand (legal suffix stripped) + leadership/products — widens discovery for
    //     names like "Erez Pte Ltd" whose official site doesn't carry the full legal name.
    const cq5 = wantHost
      ? `${brand}${siteClause}`
      : `${brand} (company OR official website OR contact OR products)${countryClause}`;
    // q6 & q7: unquoted relaxed queries using just the brand name (catches companies
    //          whose web presence doesn't include the full legal name).
    const cq6 = `${brand} company${countryClause}`;
    const cq7 = `${brand}${countryClause}`;
    try {
      // Registration-number queries run FIRST: registries (ACRA resellers,
      // OpenCorporates…) index the exact number, so these hits are authoritative
      // and also feed the registry strip. Works with or without a company name.
      const regQueries = regno ? [
        { q: `"${regno}"`, country },
        { q: `"${regno}" (company OR registration OR UEN OR incorporated)${countryClause}`, country }
      ] : [];
      const nameQueries = company ? [
        { q: cq1, country }, { q: cq2, country }, { q: cq3, country },
        { q: cq4, country }, { q: cq5, country: wantHost ? null : country },
        { q: cq6, country }, { q: cq7, country: wantHost ? null : country }
      ] : [
        // Reg-number-only search: simple trailing queries keep the DuckDuckGo
        // fallback alive (it can't handle the boolean forms above)
        { q: `${regno} company profile${countryClause}`, country },
        { q: `${regno}${countryClause}`, country }
      ];
      const resultSets = await braveMulti([...regQueries, ...nameQueries]);
      const regHits = resultSets.slice(0, regQueries.length).flat().map(r => ({ ...r, _qs: 4 }));
      const nameSets = resultSets.slice(regQueries.length);
      const [cr1, cr2, cr3, cr4, cr5, cr6, cr7] = company
        ? nameSets
        : [nameSets[0] || [], nameSets[1] || [], [], [], [], [], []];

      const companySlug  = company.toLowerCase().replace(/[^a-z0-9]/g, '');
      const companyWords = company.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      // Registrable-ish host (strip leading www. and any sub-domain noise for matching)
      const hostOf = (r) => (r.displayLink || '').toLowerCase().replace(/^www\./, '');
      const matchesName = (host) => {
        const h = host.replace(/[^a-z0-9]/g, '');
        if (companySlug.length >= 4 && h.includes(companySlug)) return true;
        // all significant words present in the host
        return companyWords.length > 0 && companyWords.every(w => host.includes(w));
      };

      // Third-party / aggregator domains that merely MENTION the company but are not
      // the company itself — retailer Q&A, review, repair, complaint, jobs sites.
      const THIRD_PARTY = /(bestbuy|lowes|homedepot|walmart|amazon|ebay|target|costco|repair|review|complaint|glassdoor|indeed|trustpilot|yelp|justdial|yellowpages|mapquest|facebook|tiktok|pinterest|reddit|quora)/i;

      const all = [
        ...regHits,
        ...cr1.map(r=>({...r,_qs:3})), ...cr2.map(r=>({...r,_qs:3})),
        ...cr3.map(r=>({...r,_qs:2})), ...cr4.map(r=>({...r,_qs:2})),
        ...cr5.map(r=>({...r,_qs:1})),
        ...cr6.map(r=>({...r,_qs:1})), ...cr7.map(r=>({...r,_qs:1}))
      ];

      // If the user supplied a website, guarantee its homepage is present as a result
      // even if the search didn't return it — this is the authoritative source.
      if (wantOrigin && !all.some(r => hostOf(r) === wantHost)) {
        all.unshift({
          title: `${company} — Official Website`,
          link: wantOrigin, snippet: `Official website of ${company}.`,
          displayLink: wantHost, type: 'unclassified', confidence: null,
          signals: [], category: 'direct', _qs: 5
        });
      }

      // Detect the OFFICIAL domain. If the user gave a website, that wins outright.
      // Otherwise: among hosts whose name matches the company, the one appearing most
      // often (ties broken by shortest host = closest to root).
      let officialDomain = wantHost;
      if (!officialDomain) {
        const officialCounts = {};
        for (const r of all) {
          const h = hostOf(r);
          if (h && matchesName(h) && !THIRD_PARTY.test(h) && !isAggregatorHost(h)) officialCounts[h] = (officialCounts[h] || 0) + 1;
        }
        officialDomain = Object.keys(officialCounts)
          .sort((a, b) => (officialCounts[b] - officialCounts[a]) || (a.length - b.length))[0] || null;
      }

      // Score first, THEN dedup, so the best page per domain survives. noiseFilter is
      // off here because LinkedIn/Crunchbase/Wikipedia are valuable for company lookups.
      const scoredAll = all.map(r => {
        const url = (r.link || '').toLowerCase();
        const host = hostOf(r);
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        const title = (r.title || '').toLowerCase();
        const snippet = (r.snippet || '').toLowerCase();
        let score = r._qs * 8;

        const isOfficial = officialDomain && host === officialDomain;
        const nameInHost = matchesName(host);
        const thirdParty = THIRD_PARTY.test(host);
        const aggregator = isAggregatorHost(host);

        // The company's OWN official site is by far the most relevant
        if (isOfficial)        score += 80;
        else if (nameInHost)   score += 35;          // other domain bearing the name
        // The user-supplied website always wins
        if (wantHost && host === wantHost) score += 120;
        // Homepage/about/contact pages of the official site
        if (isOfficial && /^\/?$/.test(path))               score += 25;
        if (isOfficial && /contact|about|company/.test(path)) score += 12;
        // Authoritative structured profiles
        if (url.includes('linkedin.com/company')) score += 40;
        if (/crunchbase|bloomberg|zoominfo|dnb\.com|\.wikipedia\.org/.test(host)) score += 28;
        // Company name in title
        if (companyWords.length && companyWords.every(w => title.includes(w))) score += 12;
        // Contact signals
        if (/phone|email|address|tel:|fax|\+\d/.test(snippet)) score += 6;
        // Penalize third-party retailer/review/aggregator pages heavily
        if (thirdParty) score -= 45;
        // Penalize results that don't bear the company name anywhere meaningful
        const nameInTitle = companyWords.some(w => title.includes(w));
        if (!nameInTitle && !nameInHost) score -= 25;

        // Relevance: the company name must appear in the title or the host (snippet
        // alone is too weak — many off-topic pages mention a brand in passing).
        const relevant = companyWords.length === 0 || nameInTitle || nameInHost;
        // Tag aggregator/directory results so the frontend won't scrape a possibly-
        // wrong street address from them and present it as authoritative.
        return { ...r, _score: score, _relevant: relevant, isAggregator: aggregator, isOfficial: isOfficial || (wantHost && host === wantHost) };
      });

      const relevantC = companyWords.length ? scoredAll.filter(r => r._relevant) : scoredAll;
      const poolC = relevantC.length >= 4 ? relevantC : scoredAll;
      poolC.sort((a, b) => b._score - a._score);

      const scoredC = deduplicateResults([poolC], { maxPerDomain: 3, limit: 24, noiseFilter: false })
        .map(r => { const { _qs, _score, _relevant, ...rest } = r; return rest; });

      const { results: scored, note: countryNote } = applyCountryFilter(scoredC, country, { keep: r => r.isOfficial });
      const registry = extractRegistryInfo(scored);
      return res.json({ subject: '', country, company, person: '', officialDomain, registry, count: scored.length, results: scored, countryNote, demoMode: false });
    } catch(err) {
      return res.status(500).json({ error: 'Company search failed: ' + err.message });
    }
  } else {
    // ── Product / supplier search ──────────────────────────────────────────────
    // Strategy: run 9 complementary queries covering different angles (manufacturer
    // direct sites, distributors, marketplaces, industry directories, exporters,
    // broad fallback). Country is embedded IN the query text (not just as a Brave
    // country param) so Brave's full-text index picks up snippets that mention the
    // country — this is far more reliable than post-filtering alone.
    const cc = country ? `"${country}"` : '';

    // Exclude low-value noise pages only — keep broad enough to surface real suppliers
    const noNoise = `-wikipedia -"top 10" -"top 20" -"top 5" -"best of" -"ranking"`;

    // q1: Manufacturer direct sites (highest value)
    const q1 = cc
      ? `${subject} manufacturer ${cc} -site:alibaba.com -site:amazon.com -site:ebay.com`
      : `${subject} manufacturer OEM factory direct -site:alibaba.com -site:amazon.com`;

    // q2: Distributors / wholesalers
    const q2 = cc
      ? `${subject} distributor wholesaler supplier ${cc} -site:amazon.com -site:ebay.com`
      : `${subject} wholesale distributor supplier B2B bulk -site:amazon.com`;

    // q3: B2B directory listings — Alibaba, IndiaMART, MIC, GlobalSources, TradeKey,
    // plus Exporters.sg, Go4WorldBusiness, TradeWheel for broader exporter/trader coverage
    const q3 = `${subject}${cc ? ' ' + cc : ''} (site:alibaba.com OR site:indiamart.com OR site:made-in-china.com OR site:globalsources.com OR site:tradekey.com OR site:ec21.com OR site:exporters.sg OR site:go4worldbusiness.com OR site:tradewheel.com)`;

    // q4: Export / trade companies
    const q4 = cc
      ? `${subject} exporter ${cc} (FOB OR CIF OR "export price" OR "shipping" OR "container")`
      : `${subject} exporter manufacturer (FOB OR CIF OR EXW OR "export price" OR "trade") ${noNoise}`;

    // q5: Industry B2B directories (ThomasNet, DirectIndustry, Kompass, Europages)
    const q5 = `${subject}${cc ? ' ' + cc : ''} (site:thomasnet.com OR site:directindustry.com OR site:kompass.com OR site:europages.com OR site:mfgpages.com OR site:globalspec.com)`;

    // q6: Broad unconstrained — catches suppliers the focused queries miss
    const q6 = cc
      ? `${subject} supplier factory ${cc} ${noNoise}`
      : `${subject} (manufacturer OR supplier OR factory OR producer) ${noNoise}`;

    // q7: Contact/quote pages — pages most likely to be actual business websites
    const q7 = cc
      ? `${subject} ${cc} ("request a quote" OR "contact us" OR "get a quote" OR "inquiry" OR "RFQ") -site:alibaba.com`
      : `${subject} ("request a quote" OR "contact us" OR "get a quote" OR "send inquiry" OR "RFQ") manufacturer -site:alibaba.com`;

    // q8: Certification and capacity signals — pages mentioning production details
    const q8 = cc
      ? `${subject} ${cc} (ISO OR GMP OR "annual capacity" OR "production line" OR "our factory" OR "our plant")`
      : `${subject} (ISO OR "ISO 9001" OR "annual capacity" OR "production capacity" OR "our factory" OR OEM ODM)`;

    // q9: Page 2 of the highest-value query for extra depth
    const q9 = cc
      ? `${subject} manufacturer ${cc} -site:alibaba.com -site:amazon.com`
      : `${subject} manufacturer factory direct -site:alibaba.com`;

    // q10 & q11: Simple DDG-friendly fallback queries (no complex boolean operators)
    const q10 = cc ? `${subject} supplier ${cc}` : `${subject} supplier`;
    const q11 = cc ? `${subject} ${cc}` : subject;

    try {
      const [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11] = await braveMulti([
        { q: q1, country },
        { q: q2, country },
        { q: q3 },
        { q: q4, country },
        { q: q5 },
        { q: q6, country },
        { q: q7, country },
        { q: q8, country },
        { q: q9, country, offset: 1 },
        { q: q10, country },
        { q: q11, country },
      ]);

      const subjectTerms = subject.toLowerCase().split(/\s+/).filter(Boolean);

      // Assign each result a quality score before dedup
      const scored = [
        ...r1.map(r => ({ ...r, _qs: 5 })),   // manufacturer direct — highest
        ...r7.map(r => ({ ...r, _qs: 5 })),   // contact/quote pages
        ...r8.map(r => ({ ...r, _qs: 4 })),   // cert/capacity signals
        ...r9.map(r => ({ ...r, _qs: 4 })),   // page 2 manufacturer
        ...r2.map(r => ({ ...r, _qs: 4 })),   // distributors
        ...r6.map(r => ({ ...r, _qs: 3 })),   // broad
        ...r4.map(r => ({ ...r, _qs: 3 })),   // exporters
        ...r5.map(r => ({ ...r, _qs: 2 })),   // industry directories
        ...r3.map(r => ({ ...r, _qs: 1 })),   // marketplace listings (lower priority)
        ...r10.map(r => ({ ...r, _qs: 2 })), // simple DDG fallback
        ...r11.map(r => ({ ...r, _qs: 1 })), // simple DDG fallback broad
      ].map(r => {
        const titleLc   = (r.title   || '').toLowerCase();
        const snippetLc = (r.snippet || '').toLowerCase();
        const dom       = (r.displayLink || '').toLowerCase();
        let s = r._qs * 10;

        // ── Subject relevance (most important signal) ─────────────────────────
        const titleTerms   = subjectTerms.filter(t => titleLc.includes(t)).length;
        const snippetTerms = subjectTerms.filter(t => snippetLc.includes(t)).length;
        s += titleTerms * 18;    // title match worth much more than snippet
        s += snippetTerms * 6;

        // ── Country relevance ─────────────────────────────────────────────────
        if (country) {
          const countryAliases = countryMatchers(country);
          const inTitle   = countryAliases.some(a => titleLc.includes(a));
          const inSnippet = countryAliases.some(a => snippetLc.includes(a));
          const inDomain  = (() => { const tld = COUNTRY_TLD[country]; return tld && (dom.endsWith('.' + tld) || dom.includes('.' + tld + '.')); })();
          if (inTitle)   s += 20;
          if (inSnippet) s += 12;
          if (inDomain)  s += 15;
        }

        // ── Page type ─────────────────────────────────────────────────────────
        if (r.category === 'direct')      s += 30;  // real company website
        if (r.category === 'marketplace') s -= 10;  // listing page — lower priority

        // ── Supplier-type signals (more nuanced weighting) ────────────────────
        if (r.type === 'manufacturer') s += 10;
        if (r.type === 'distributor')  s += 7;
        // Unclassified direct sites are still better than marketplace listings
        if (r.type === 'unclassified' && r.category === 'direct') s += 3;

        // ── Business quality signals ──────────────────────────────────────────
        if (r.signals && r.signals.length >= 2) s += 18;
        if (r.signals && r.signals.length >= 4) s += 10;  // extra for info-rich pages
        if (r.signals && r.signals.some(sg => sg.type === 'price'))    s += 12;
        if (r.signals && r.signals.some(sg => sg.type === 'cert'))     s += 10;
        if (r.signals && r.signals.some(sg => sg.type === 'moq'))      s += 8;
        if (r.signals && r.signals.some(sg => sg.type === 'capacity')) s += 8;

        // Contact/quote intent on page
        if (/contact|inquiry|quote|rfq|\+\d{6,}/.test(snippetLc)) s += 12;
        if (/email|phone|tel:/.test(snippetLc))                    s += 6;

        // Domain quality signals (manufacturer words in domain = strong signal)
        if (/manufactur|factory|industri|production|mfg|mfr/.test(dom)) s += 14;
        if (/distribut|wholesale|trading|supply|supplier/.test(dom))    s += 10;
        if (/alibaba|indiamart|made-in-china|tradekey|ec21/.test(dom))  s -= 8;

        // ── Noise penalties ───────────────────────────────────────────────────
        if (/top \d+|best \d+|list of|ranking|review of|guide to/i.test(titleLc)) s -= 40;
        if (!r.snippet || r.snippet.length < 50)  s -= 20;  // very low info
        if (!r.snippet || r.snippet.length < 100) s -= 8;   // thin snippet

        // Penalize Indian SEO farms keyword-stuffing foreign country names in titles.
        // Signal: non-ccTLD .com domain, "manufacturer in <country>" pattern in title,
        // but snippet mentions India / Indian cities / Indian pricing (₹/INR/Rs.).
        if (country && country !== 'India') {
          const isIndianSEO = INDIAN_SEO_DOMAINS.test(dom) ||
            (/manufacturer.{1,20}in\s+(germany|usa|uk|france|italy|uae|canada|australia|netherlands)/i.test(titleLc) &&
             /india|mumbai|gujarat|chennai|delhi|pune|kolkata|₹|inr|\brs\b/i.test(snippetLc));
          if (isIndianSEO) s -= 40;
        }

        // Mark relevance: at least one subject term must appear somewhere
        r._relevant = subjectTerms.length === 0 || (titleTerms + snippetTerms) > 0;

        return { ...r, _score: s };
      });

      // Drop off-topic results; fall back to full pool if subject is very niche
      const relevant = subjectTerms.length ? scored.filter(r => r._relevant) : scored;
      const pool = relevant.length >= 6 ? relevant : scored;

      pool.sort((a, b) => b._score - a._score);

      // Stricter per-domain limit for marketplaces (max 2), normal for direct sites
      const allItemsRaw = (() => {
        const seen = new Set();
        const seenDomain = new Map();
        const out = [];
        for (const item of pool) {
          if (!item.link || seen.has(item.link)) continue;
          seen.add(item.link);
          const dom = (item.displayLink || '').toLowerCase();
          if (NOISE_DOMAINS.some(d => dom.includes(d))) continue;
          const isMarket = item.category === 'marketplace';
          const max = isMarket ? 2 : 4;
          const cnt = seenDomain.get(dom) || 0;
          if (cnt >= max) continue;
          seenDomain.set(dom, cnt + 1);
          out.push(item);
          if (out.length >= 80) break;
        }
        return out;
      })().map(({ _qs, _score, _relevant, ...rest }) => rest);

      // Country filter: if country selected, keep results that mention it;
      // fall back to full set so we never return empty on thin markets.
      const { results: allItems, note: countryNote } = applyCountryFilter(allItemsRaw, country);

      // Merge in curated real-company reference entries (e.g. copper cathode
      // producers) that match this query — skip any domain live search already
      // surfaced on its own. Placed first since they're verified, high-confidence picks.
      const existingDomains = new Set(allItems.map(r => (r.displayLink || '').toLowerCase()));
      const curated = curatedRealMatches(subjectTerms)
        .filter(r => !existingDomains.has((r.displayLink || '').toLowerCase()));

      // Present direct company sites first, marketplace listings as supplementary
      const direct      = [...curated, ...allItems.filter(r => r.category !== 'marketplace')].slice(0, 40);
      const marketplace = allItems.filter(r => r.category === 'marketplace').slice(0, 12);
      const items = [...direct, ...marketplace];

      return res.json({
        subject, country, company, person,
        count: items.length,
        results: items,
        countryNote,
        resultSections: { direct: direct.length, marketplace: marketplace.length },
        demoMode: false
      });
    } catch (err) {
      return res.status(500).json({ error: 'Search request failed: ' + err.message });
    }
  }
});

// ── Physical Stock Search ─────────────────────────────────────────────────────
// Finds suppliers who have a specific product physically in stock right now:
// ready-to-ship inventory, MOQ, unit price, and warehouse/delivery info.

const DEMO_STOCK = [
  { title:'LED Bulbs 10W — In Stock, MOQ 500pcs | BrightCore Industries', link:'https://example.com/brightcore-led', displayLink:'brightcore-industries.example.com', snippet:'10W LED bulbs in stock. MOQ: 500 pcs. Unit price: $0.85–$1.20 FOB Shenzhen. Ready to ship within 3 days. Bulk discount available.', subtype:'direct', type:'stock', thumbnail:null },
  { title:'Steel Pipe 48mm — Warehouse Stock 200 Tons | IronGate Steel', link:'https://example.com/irongate-stock', displayLink:'irongate.example.com', snippet:'200 MT of 48mm schedule 40 steel pipe in stock at Pittsburgh warehouse. ASTM A53 certified. Immediate delivery. Quote within 24h.', subtype:'direct', type:'stock', thumbnail:null },
  { title:'Cotton Fabric 100% — 50,000 Yards Available | WeaveTech Mills', link:'https://example.com/weavetech-stock', displayLink:'weavetech.example.com', snippet:'50,000 yards of plain-weave 100% cotton fabric in stock. 40s count, 60" wide. CIF port available. GOTS certified. MOQ: 1,000 yards.', subtype:'direct', type:'stock', thumbnail:null },
  { title:'LED Bulbs Wholesale — Ready Stock 10,000 Units | Volt & Glow', link:'https://example.com/voltglow-stock', displayLink:'voltglow.example.com', snippet:'Multi-brand LED bulbs ready stock in Mumbai warehouse. 5W, 9W, 12W, 18W variants. Price: ₹22–₹65 per piece. Same-day dispatch.', subtype:'warehouse', type:'stock', thumbnail:null },
  { title:'Solar Panels 400W Mono — Stock Alert: 2,000 Units | SunCell', link:'https://example.com/suncell-stock', displayLink:'suncell.example.com', snippet:'400W monocrystalline panels currently in stock. 2,000 units available. Price: $0.22/Wp FOB Shanghai. Pallet-ready for container loading.', subtype:'direct', type:'stock', thumbnail:null },
  { title:'Drip Irrigation Kits — 500 Sets In Stock | AgriFlow Technologies', link:'https://example.com/agriflow-stock', displayLink:'agriflow.example.com', snippet:'Complete drip irrigation kits (0.5 acre coverage) in stock at Hadera warehouse. 500 sets available. Ship within 5 business days. MOQ: 10 sets.', subtype:'direct', type:'stock', thumbnail:null },
  { title:'PCB Assembly Boards — 10,000 Units Surplus Stock | CircuitForge', link:'https://example.com/circuitforge-stock', displayLink:'circuitforge.example.com', snippet:'Surplus PCB stock: 10,000 assembled units from cancelled order. SMT, RoHS compliant. Deep discount. Inquire for specs and pricing.', subtype:'surplus', type:'stock', thumbnail:null },
  { title:'Plastic Bottles 500ml — 100,000 Units | PolyForm Manufacturing', link:'https://example.com/polyform-stock', displayLink:'polyform.example.com', snippet:'100,000 food-grade HDPE 500ml bottles in stock. Clear and colored variants. MOQ: 5,000 units. $0.09 per unit EXW Houston. Stock updated weekly.', subtype:'direct', type:'stock', thumbnail:null },
  { title:'Wheat Flour — 500MT Spot Cargo Available | Cargill Grain', link:'https://example.com/cargill-flour', displayLink:'cargill.example.com', snippet:'500 MT of milling-grade wheat flour available for spot delivery. FOB Rotterdam. Moisture < 14%. HACCP certified. Delivery lead time: 7 days.', subtype:'warehouse', type:'stock', thumbnail:null },
  { title:'Rubber Seals — Ex-Stock 20,000 pcs | SiamRubber', link:'https://example.com/siamrubber-stock', displayLink:'siamrubber.example.com', snippet:'O-rings and seals in EPDM and NBR in stock. 20,000 pcs across 15 sizes. Automotive grade. Price from $0.04/pc. Air freight available.', subtype:'direct', type:'stock', thumbnail:null },
];

function searchDemoStock(product, country) {
  const needle = product.toLowerCase();
  const countryLc = country.toLowerCase();
  return DEMO_STOCK.filter(d => {
    const matchProduct = !needle || d.title.toLowerCase().includes(needle) || d.snippet.toLowerCase().includes(needle);
    const matchCountry = !countryLc || d.snippet.toLowerCase().includes(countryLc) || d.title.toLowerCase().includes(countryLc);
    return matchProduct && matchCountry;
  });
}

app.get('/api/stock', async (req, res) => {
  const product  = (req.query.product  || '').trim();
  const country  = (req.query.country  || '').trim();
  const minQty   = (req.query.minQty   || '').trim(); // e.g. "1000"
  const unit     = (req.query.unit     || '').trim(); // e.g. "pcs", "kg", "mt"

  if (!product) {
    return res.status(400).json({ error: 'Please provide a product name.' });
  }

  if (!LIVE_MODE) {
    const results = searchDemoStock(product, country);
    return res.json({ product, country, count: results.length, results, demoMode: true });
  }

  const countryClause = country ? ` "${country}"` : '';
  const qtyClause     = minQty  ? ` "${minQty} ${unit || 'pcs'}" OR "MOQ ${minQty}"` : '';

  // q1: suppliers explicitly advertising in-stock / ready-to-ship inventory
  const q1 = `"${product}" ("in stock" OR "ready to ship" OR "ex-stock" OR "ex stock" OR "available now" OR "immediate delivery" OR "spot cargo")${countryClause}${qtyClause}`;
  // q2: warehouse stock, bulk availability, surplus
  const q2 = `"${product}" (warehouse OR inventory OR "bulk stock" OR "stock available" OR "available stock" OR surplus OR "ready inventory")${countryClause}`;
  // q3: B2B wholesale listings with price / MOQ signals
  const q3 = `"${product}" (wholesale OR "price per" OR "unit price" OR MOQ OR "minimum order" OR "FOB price" OR "bulk price")${countryClause}`;

  try {
    // braveMulti (not raw searchBrave) so these searches inherit the same
    // Google → DuckDuckGo fallback chain as product search when Brave is down.
    const [r1, r2, r3] = await braveMulti([
      { q: q1, country: country || null },
      { q: q2, country: country || null },
      { q: q3, country: country || null }
    ]);

    const seenStock = new Set();
    const seenStockDomain = new Map();

    const scored = [
      ...r1.map(r => ({ ...r, _qs: 3 })),
      ...r2.map(r => ({ ...r, _qs: 2 })),
      ...r3.map(r => ({ ...r, _qs: 1 }))
    ].filter(r => {
      if (seenStock.has(r.link)) return false;
      seenStock.add(r.link);
      const dom = (r.displayLink || '').toLowerCase();
      if (NOISE_DOMAINS.some(d => dom.includes(d))) return false;
      const domCount = seenStockDomain.get(dom) || 0;
      if (domCount >= 3) return false;
      seenStockDomain.set(dom, domCount + 1);
      return true;
    }).map(r => {
      const snippet = (r.snippet || '').toLowerCase();
      const title   = (r.title   || '').toLowerCase();
      let score   = r._qs * 10;
      let subtype = 'listing';

      // Strong in-stock signals
      if (/in stock|ready to ship|ex.?stock|available now|immediate delivery|spot cargo/.test(snippet + title)) {
        score += 45; subtype = 'direct';
      } else if (/warehouse|inventory|bulk stock|stock available|surplus/.test(snippet + title)) {
        score += 30; subtype = 'warehouse';
      } else if (/surplus|clearance|overstocked|excess stock/.test(snippet + title)) {
        score += 20; subtype = 'surplus';
      }

      // Price / MOQ signals boost relevance
      if (/\$[\d,.]+|moq|minimum order|price per|fob|cif|unit price/.test(snippet)) score += 15;
      // Product name in title
      if (title.includes(product.toLowerCase())) score += 12;

      // ── Extract the actual deal numbers out of the snippet text ────────────
      // A trader cares about price / MOQ / available quantity, not prose.
      const raw = `${r.title || ''} ${r.snippet || ''}`;
      const dealInfo = {};
      const priceM = raw.match(/(?:US?\$|USD|€|£|₹|RM|S\$)\s?([\d,]+(?:\.\d+)?)(?:\s*[-–~]\s*(?:US?\$|USD)?\s?[\d,]+(?:\.\d+)?)?\s*(?:\/|per\s*)?\s*(pc|pcs|piece|unit|kg|mt|ton|tonne|meter|m\b|yard|set|Wp|watt)?/i);
      if (priceM) dealInfo.price = priceM[0].replace(/\s+/g, ' ').trim().slice(0, 40);
      const moqM = raw.match(/(?:MOQ|minimum order(?: quantity)?)[:\s]*([\d,]+\s*(?:pcs?|pieces?|units?|kg|mt|tons?|tonnes?|sets?|yards?|meters?)?)/i);
      if (moqM) dealInfo.moq = moqM[1].trim().slice(0, 30);
      const qtyM = raw.match(/([\d,]{3,}\+?\s*(?:pcs|pieces|units|kg|mt|tons?|tonnes?|sets|yards|meters))\s*(?:in stock|available|ready|surplus)/i) ||
                   raw.match(/(?:in stock|available|stock)[:\s]*([\d,]{3,}\+?\s*(?:pcs|pieces|units|kg|mt|tons?|tonnes?|sets))/i);
      if (qtyM) dealInfo.quantity = qtyM[1].trim().slice(0, 30);
      const leadM = raw.match(/(?:ship(?:s|ping)? (?:with)?in|delivery(?: in)?|dispatch(?: in)?|lead time[:\s]*)\s*(\d+\s*[-–]?\s*\d*\s*(?:hours?|days?|weeks?|business days?))/i);
      if (leadM) dealInfo.leadTime = leadM[1].trim().slice(0, 25);

      // Results with concrete numbers outrank vague "we have stock" pages
      const dealCount = Object.keys(dealInfo).length;
      score += dealCount * 12;

      return { ...r, _score: score, subtype, dealInfo: dealCount ? dealInfo : null };
    }).sort((a, b) => b._score - a._score)
      .slice(0, 24)
      .map(r => { const { _qs, _score, ...rest } = r; return { ...rest, type: 'stock' }; });

    res.json({ product, country, count: scored.length, results: scored, demoMode: false });
  } catch (err) {
    res.status(500).json({ error: 'Stock search failed: ' + err.message });
  }
});

// ── AI Analysis ──────────────────────────────────────────────────────────────

async function callAI(prompt) {
  if (OPENAI_KEY) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 700,
        response_format: { type: 'json_object' }
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return JSON.parse(data.choices[0].message.content);
  }

  if (GEMINI_KEY) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            // gemini-2.5-flash is a thinking model: reasoning tokens count against
            // maxOutputTokens, so a small cap truncates the JSON mid-string.
            // Disable thinking (not needed for this extraction task) and force
            // native JSON output so no markdown-fence stripping is needed.
            maxOutputTokens: 4000,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 }
          }
        })
      }
    );
    const data = await res.json();
    if (data.error) {
      recordSvc('gemini', /quota|exceeded/i.test(data.error.message) ? 'quota' : 'error', data.error.message);
      throw new Error(data.error.message);
    }
    recordSvc('gemini', 'ok');
    const raw = data.candidates[0].content.parts[0].text;
    return JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
  }

  throw new Error('No AI key configured');
}

// ── Trade / Import-Export Search ─────────────────────────────────────────────
app.get('/api/trade', async (req, res) => {
  const product  = (req.query.product  || '').trim();
  const hsCode   = (req.query.hs       || '').trim();
  const country  = (req.query.country  || '').trim();
  const tradeDir = (req.query.dir      || '').trim(); // 'import', 'export', or ''

  if (!product && !hsCode) {
    return res.status(400).json({ error: 'Please provide a product or HS code to search.' });
  }

  if (!LIVE_MODE) {
    return res.json({ product, hsCode, country, tradeDir, count: 0, results: [], demoMode: true,
      message: 'Trade search requires live API keys. Add BRAVE_API_KEY to .env.' });
  }

  const term = hsCode ? `HS code ${hsCode} "${product || ''}"` : `"${product}"`;
  const dirClause = tradeDir === 'import' ? ' (importer OR "import data" OR "import records")' :
                    tradeDir === 'export' ? ' (exporter OR "export data" OR "export records")' :
                    ' (import OR export OR trade)';
  const countryClause = country ? ` "${country}"` : '';

  const q1 = `${term}${dirClause}${countryClause} (shipment OR customs OR "trade data" OR "bill of lading")`;
  const q2 = `${term} supplier${countryClause} (HS OR "tariff code" OR "customs code" OR "harmonized code")`;
  const q3 = `${term}${countryClause} (importer exporter OR "trade route" OR "global trade" OR "import export company")`;

  try {
    // braveMulti (not raw searchBrave) so these searches inherit the same
    // Google → DuckDuckGo fallback chain as product search when Brave is down.
    const [r1, r2, r3] = await braveMulti([
      { q: q1, country: country || null },
      { q: q2, country: country || null },
      { q: q3, country: country || null }
    ]);

    const results = deduplicateResults(
      [r1.map(r=>({...r,_qs:3})), r2.map(r=>({...r,_qs:2})), r3.map(r=>({...r,_qs:1}))],
      { maxPerDomain: 2, limit: 20 }
    ).map(r => {
      const text = `${r.title || ''} ${r.snippet || ''}`.toLowerCase();
      const isTradeDB = /panjiva|importgenius|datamyne|customs|shipment|bill of lading|trade data/i.test(text);
      let score = (r._qs || 1) * 10;
      if (isTradeDB) score += 20;
      if (country && text.includes(country.toLowerCase())) score += 10;
      const { _qs, ...rest } = r;
      return { ...rest, type: 'trade', _score: score };
    }).sort((a,b) => b._score - a._score).slice(0,15)
     .map(({ _score, ...r }) => r);

    res.json({ product, hsCode, country, tradeDir, count: results.length, results, demoMode: false });
  } catch(err) {
    res.status(500).json({ error: 'Trade search failed: ' + err.message });
  }
});

// ── Market / Industry Search ──────────────────────────────────────────────────
app.get('/api/market', async (req, res) => {
  const industry = (req.query.industry || '').trim();
  const country  = (req.query.country  || '').trim();
  const focus    = (req.query.focus    || '').trim(); // 'size', 'trends', 'players', ''

  if (!industry) {
    return res.status(400).json({ error: 'Please provide an industry or sector to search.' });
  }

  if (!LIVE_MODE) {
    return res.json({ industry, country, focus, count: 0, results: [], demoMode: true,
      message: 'Market search requires live API keys. Add BRAVE_API_KEY to .env.' });
  }

  const countryClause = country ? ` "${country}"` : '';
  const focusClause   = focus === 'size'    ? ' ("market size" OR "market value" OR "billion" OR "CAGR" OR "forecast")' :
                        focus === 'trends'  ? ' (trends OR "market trend" OR "industry trend" OR outlook OR forecast)' :
                        focus === 'players' ? ' ("key players" OR "major players" OR "leading companies" OR "top manufacturers")' :
                        ' ("market size" OR "key players" OR "industry outlook" OR "market share")';

  const q1 = `"${industry}" market${focusClause}${countryClause} (report OR analysis OR overview)`;
  const q2 = `"${industry}" industry${countryClause} (suppliers OR manufacturers OR "supply chain" OR "industry players")`;
  const q3 = `"${industry}" sector${countryClause} (growth OR "market share" OR competitive OR "leading companies")`;

  try {
    // braveMulti (not raw searchBrave) so these searches inherit the same
    // Google → DuckDuckGo fallback chain as product search when Brave is down.
    const [r1, r2, r3] = await braveMulti([
      { q: q1, country: country || null },
      { q: q2, country: country || null },
      { q: q3, country: country || null }
    ]);

    const results = deduplicateResults(
      [r1.map(r=>({...r,_qs:3})), r2.map(r=>({...r,_qs:2})), r3.map(r=>({...r,_qs:1}))],
      { maxPerDomain: 2, limit: 20 }
    ).map(r => {
      const text = `${r.title || ''} ${r.snippet || ''}`.toLowerCase();
      let score = (r._qs || 1) * 10;
      if (/statista|grandviewresearch|mordorintelligence|marketsandmarkets|ibisworld|precedenceresearch/i.test(r.link || '')) score += 25;
      if (text.includes('market size') || text.includes('market share')) score += 15;
      if (text.includes(industry.toLowerCase())) score += 10;
      const { _qs, ...rest } = r;
      return { ...rest, type: 'market', _score: score };
    }).sort((a,b) => b._score - a._score).slice(0,15)
     .map(({ _score, ...r }) => r);

    res.json({ industry, country, focus, count: results.length, results, demoMode: false });
  } catch(err) {
    res.status(500).json({ error: 'Market search failed: ' + err.message });
  }
});

app.post('/api/ai-analyze', async (req, res) => {
  if (!AI_PROVIDER) {
    return res.status(503).json({ error: 'No AI key configured. Add OPENAI_API_KEY or GEMINI_API_KEY to .env' });
  }

  const { query, results = [], mode = 'product' } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });

  const snippets = results.slice(0, 14).map((r, i) =>
    `[${i + 1}] ${r.title} | ${r.displayLink || ''} | ${(r.snippet || '').slice(0, 160)}`
  ).join('\n');

  const modeContext = {
    product:  'finding global manufacturers and distributors for a product',
    company:  'researching a specific company — its profile, contacts, and credibility',
    person:   'finding a business person — their role, company, and contact details',
    stock:    'finding suppliers with physical inventory ready to ship',
    image:    'identifying a product or business from an image'
  }[mode] || 'global supplier search';

  const prompt = `You are a global trade intelligence expert specializing in ${modeContext}.

Query: "${query}"
Search results:
${snippets}

Analyze these results and return a JSON object with exactly these fields:
{
  "summary": "2-3 sentence expert summary of the most relevant findings",
  "topPicks": [1, 2, 3],
  "keyInsights": ["insight 1", "insight 2", "insight 3", "insight 4"],
  "suggestions": ["refined query 1", "refined query 2", "refined query 3"],
  "warning": "optional red flag or important note, or empty string if none"
}

Rules:
- topPicks: 1-based indices of the 3 most genuinely useful results (not just popular sites)
- keyInsights: specific actionable facts (MOQ, certifications, pricing signals, market structure, etc.)
- suggestions: smarter follow-up queries that will surface better supplier leads
- Be concise and specific — no generic filler
- Return only valid JSON`;

  try {
    const analysis = await callAI(prompt);
    res.json({ analysis, provider: AI_PROVIDER });
  } catch (err) {
    res.status(500).json({ error: 'AI analysis failed: ' + err.message });
  }
});

// ── Saved suppliers (shared shortlist) ────────────────────────────────────────
// Stored server-side in data/saved.json (not per-browser localStorage) so every
// user on the LAN — you and your colleague — sees the same shortlist and notes.
const fs = require('fs');
const SAVED_FILE = path.join(__dirname, 'data', 'saved.json');

function loadSaved() {
  try { return JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8')); } catch (_) { return []; }
}
function writeSaved(list) {
  fs.mkdirSync(path.dirname(SAVED_FILE), { recursive: true });
  fs.writeFileSync(SAVED_FILE, JSON.stringify(list, null, 2));
}

app.get('/api/saved', (req, res) => {
  res.json({ saved: loadSaved() });
});

app.post('/api/saved', (req, res) => {
  const item = req.body || {};
  if (!item.link || !item.title) return res.status(400).json({ error: 'link and title are required' });
  const list = loadSaved();
  if (list.some(s => s.link === item.link)) return res.json({ saved: list, note: 'Already saved' });
  list.unshift({
    link: item.link, title: item.title, displayLink: item.displayLink || '',
    type: item.type || '', country: item.country || '', snippet: (item.snippet || '').slice(0, 300),
    phone: item.phone || null, email: item.email || null, whatsapp: item.whatsapp || null,
    address: item.address || null, notes: '', status: 'new',
    savedAt: new Date().toISOString(), statusChangedAt: new Date().toISOString()
  });
  writeSaved(list);
  res.json({ saved: list });
});

// Sourcing pipeline stages a saved supplier can be in, in workflow order.
const PIPELINE_STATUSES = ['new', 'contacted', 'quoted', 'sampled', 'ordered', 'rejected'];

app.patch('/api/saved', (req, res) => {
  const { link, notes, status } = req.body || {};
  if (!link) return res.status(400).json({ error: 'link is required' });
  const list = loadSaved();
  const item = list.find(s => s.link === link);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (typeof notes === 'string') item.notes = notes.slice(0, 2000);
  if (typeof status === 'string' && PIPELINE_STATUSES.includes(status) && status !== item.status) {
    item.status = status;
    // Timestamp the transition so the UI can flag deals going quiet
    item.statusChangedAt = new Date().toISOString();
  }
  // Deal economics (margin quick-check) — plain numbers, computed client-side
  const deal = req.body.deal;
  if (deal && typeof deal === 'object') {
    const num = v => { const n = parseFloat(v); return isNaN(n) ? null : Math.max(0, Math.min(1e9, n)); };
    item.deal = { buy: num(deal.buy), freight: num(deal.freight), duties: num(deal.duties), sell: num(deal.sell) };
  }
  // Trust verdict from the background check run at save time
  const trust = req.body.trust;
  if (trust && typeof trust === 'object') {
    item.trust = {
      score: typeof trust.score === 'number' ? trust.score : null,
      rating: String(trust.rating || '').slice(0, 40),
      checkedAt: new Date().toISOString()
    };
  }
  writeSaved(list);
  res.json({ saved: list });
});

app.delete('/api/saved', (req, res) => {
  const link = (req.query.link || '').trim();
  if (!link) return res.status(400).json({ error: 'link is required' });
  writeSaved(loadSaved().filter(s => s.link !== link));
  res.json({ saved: loadSaved() });
});

// ── Shareable product catalog ─────────────────────────────────────────────────
// A public page (/catalog.html) you can send to buyers, listing your products
// with a "request a quote" form. Managed from the dashboard.
const CATALOG_FILE = path.join(__dirname, 'data', 'catalog.json');
const QUOTES_FILE = path.join(__dirname, 'data', 'quote-requests.json');

function defaultCatalog() {
  return { company: 'Erez Impex', tagline: 'Global trading — metals & commodities', email: '', phone: '', whatsapp: '', products: [] };
}

app.get('/api/catalog', (req, res) => res.json(loadJson(CATALOG_FILE, defaultCatalog())));

app.post('/api/catalog', (req, res) => {
  const b = req.body || {};
  const cat = {
    company: String(b.company || '').slice(0, 100),
    tagline: String(b.tagline || '').slice(0, 200),
    email: String(b.email || '').slice(0, 120),
    phone: String(b.phone || '').slice(0, 60),
    whatsapp: String(b.whatsapp || '').slice(0, 60),
    products: (Array.isArray(b.products) ? b.products : []).slice(0, 40).map(p => ({
      name: String(p.name || '').slice(0, 100),
      description: String(p.description || '').slice(0, 600),
      specs: String(p.specs || '').slice(0, 300),
      origin: String(p.origin || '').slice(0, 80),
      terms: String(p.terms || '').slice(0, 120)
    })).filter(p => p.name)
  };
  writeJson(CATALOG_FILE, cat);
  res.json(cat);
});

// Public: a buyer submits a quote request from the catalog page
app.post('/api/catalog/quote', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.contact) return res.status(400).json({ error: 'name and contact are required' });
  const list = loadJson(QUOTES_FILE, []);
  list.unshift({
    at: new Date().toISOString(),
    name: String(b.name).slice(0, 100), company: String(b.company || '').slice(0, 100),
    contact: String(b.contact).slice(0, 120), country: String(b.country || '').slice(0, 60),
    product: String(b.product || '').slice(0, 100), message: String(b.message || '').slice(0, 1000),
    read: false
  });
  writeJson(QUOTES_FILE, list.slice(0, 500));
  res.json({ ok: true });
});

// Dashboard: view incoming quote requests
app.get('/api/catalog/quotes', (req, res) => {
  const list = loadJson(QUOTES_FILE, []);
  res.json({ quotes: list, unread: list.filter(q => !q.read).length });
});
app.post('/api/catalog/quotes/read', (req, res) => {
  const list = loadJson(QUOTES_FILE, []).map(q => ({ ...q, read: true }));
  writeJson(QUOTES_FILE, list);
  res.json({ ok: true });
});

// ── Company Brain ─────────────────────────────────────────────────────────────
// A permanent local record of every company the app has ever enriched or trust-
// checked. Turns one-off lookups into institutional memory: next time you search
// a company you've dealt with, the app reminds you what it already knows.
const BRAIN_FILE = path.join(__dirname, 'data', 'company-brain.json');
const brainHost = h => String(h || '').toLowerCase().replace(/^www\./, '');

function recordCompanyBrain(host, info) {
  host = brainHost(host);
  if (!host) return;
  const brain = loadJson(BRAIN_FILE, {});
  const rec = brain[host] || { host, firstSeen: new Date().toISOString(), interactions: [] };
  // Merge in any newly-learned facts (never overwrite a known value with null)
  for (const k of ['name', 'phone', 'email', 'address', 'country', 'trustRating', 'trustScore']) {
    if (info[k] != null && info[k] !== '') rec[k] = info[k];
  }
  rec.lastSeen = new Date().toISOString();
  rec.interactions = (rec.interactions || []).concat([{ at: rec.lastSeen, event: info.event || 'seen' }]).slice(-20);
  brain[host] = rec;
  // Cap the brain so it can't grow unbounded (keep the 2000 most-recently-seen)
  const keys = Object.keys(brain);
  if (keys.length > 2000) {
    keys.sort((a, b) => new Date(brain[a].lastSeen) - new Date(brain[b].lastSeen));
    keys.slice(0, keys.length - 2000).forEach(k => delete brain[k]);
  }
  writeJson(BRAIN_FILE, brain);
}

function lookupCompanyBrain(host) {
  return loadJson(BRAIN_FILE, {})[brainHost(host)] || null;
}

app.get('/api/company-brain', (req, res) => {
  const host = (req.query.host || '').trim();
  if (host) return res.json({ record: lookupCompanyBrain(host) });
  // No host: return a compact list (for a "companies we know" overview)
  const brain = loadJson(BRAIN_FILE, {});
  const list = Object.values(brain)
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))
    .slice(0, 200)
    .map(r => ({ host: r.host, name: r.name, country: r.country, trustRating: r.trustRating, lastSeen: r.lastSeen, interactions: (r.interactions || []).length }));
  res.json({ count: Object.keys(brain).length, companies: list });
});

// Bulk lookup so search results can be annotated "you know this company" in one call
app.post('/api/company-brain/lookup', (req, res) => {
  const hosts = (req.body?.hosts || []).slice(0, 120).map(brainHost);
  const brain = loadJson(BRAIN_FILE, {});
  const found = {};
  for (const h of hosts) {
    const r = brain[h];
    if (r) found[h] = {
      name: r.name, country: r.country, trustRating: r.trustRating, trustScore: r.trustScore,
      firstSeen: (r.firstSeen || '').slice(0, 10), lastSeen: (r.lastSeen || '').slice(0, 10),
      events: (r.interactions || []).slice(-5).map(i => (i.at || '').slice(0, 10) + ' ' + i.event)
    };
  }
  res.json({ found });
});

// ── Morning lead monitor ──────────────────────────────────────────────────────
// Watched searches run automatically once per day; the dashboard shows only the
// NEW results since the last run. Turns the app from search-on-demand into a
// lead feed: open it in the morning, see what appeared overnight.
const WATCHLIST_FILE = path.join(__dirname, 'data', 'watchlist.json');
const MONITOR_SEEN_FILE = path.join(__dirname, 'data', 'monitor-seen.json');
const MONITOR_REPORT_FILE = path.join(__dirname, 'data', 'monitor-report.json');

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const watchKey = w => `${w.mode}|${w.query}|${w.country || ''}`.toLowerCase();

app.get('/api/watchlist', (req, res) => res.json({ watchlist: loadJson(WATCHLIST_FILE, []) }));

app.post('/api/watchlist', (req, res) => {
  const { mode, query, country } = req.body || {};
  if (!query || !['product', 'buyers'].includes(mode)) {
    return res.status(400).json({ error: 'mode (product|buyers) and query are required' });
  }
  const list = loadJson(WATCHLIST_FILE, []);
  const w = { mode, query: String(query).slice(0, 100), country: String(country || '').slice(0, 50), addedAt: new Date().toISOString() };
  if (list.some(x => watchKey(x) === watchKey(w))) return res.json({ watchlist: list, note: 'Already watching' });
  if (list.length >= 10) return res.status(400).json({ error: 'Watchlist limit is 10 searches — remove one first.' });
  list.push(w);
  writeJson(WATCHLIST_FILE, list);
  res.json({ watchlist: list });
});

app.delete('/api/watchlist', (req, res) => {
  const key = (req.query.key || '').trim().toLowerCase();
  const list = loadJson(WATCHLIST_FILE, []).filter(w => watchKey(w) !== key);
  writeJson(WATCHLIST_FILE, list);
  res.json({ watchlist: list });
});

app.get('/api/monitor-report', (req, res) => {
  res.json(loadJson(MONITOR_REPORT_FILE, { date: null, items: [], running: monitorRunning }));
});

let monitorRunning = false;
async function runLeadMonitor(trigger = 'schedule') {
  if (monitorRunning) return;
  const watchlist = loadJson(WATCHLIST_FILE, []);
  if (!watchlist.length) return;
  monitorRunning = true;
  console.log(`[monitor] run started (${trigger}) — ${watchlist.length} watch(es)`);
  const seen = loadJson(MONITOR_SEEN_FILE, {});
  const items = [];
  try {
    for (const w of watchlist) {
      const key = watchKey(w);
      try {
        // Call our own HTTP API so every watch reuses the full search pipeline
        // (Brave -> Google -> DDG fallbacks, caching, scoring) with no duplication.
        const params = new URLSearchParams();
        if (w.mode === 'product') { params.set('q', w.query); if (w.country) params.set('country', w.country); }
        else { params.set('product', w.query); if (w.country) params.set('country', w.country); }
        const url = `http://localhost:${PORT}/api/${w.mode === 'product' ? 'search' : 'search-customers'}?${params}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
        const data = await r.json();
        const results = (data.results || []).filter(x => x.link);

        const firstRun = !seen[key];
        const seenSet = new Set(seen[key] || []);
        const fresh = firstRun ? [] : results.filter(x => !seenSet.has(x.link));
        for (const x of results) seenSet.add(x.link);
        seen[key] = [...seenSet].slice(-500);

        items.push({
          watch: w, key, firstRun,
          totalResults: results.length,
          newResults: fresh.slice(0, 10).map(x => ({
            title: x.title, link: x.link, displayLink: x.displayLink,
            type: x.type, isRFQ: !!x.isRFQ, snippet: (x.snippet || '').slice(0, 160)
          }))
        });
      } catch (err) {
        items.push({ watch: w, key, error: String(err.message).slice(0, 120), newResults: [] });
      }
      // Pace between watches — be gentle on rate limits
      await new Promise(r => setTimeout(r, 3000));
    }
    writeJson(MONITOR_SEEN_FILE, seen);
    writeJson(MONITOR_REPORT_FILE, {
      date: new Date().toISOString().slice(0, 10),
      generatedAt: new Date().toISOString(),
      trigger, items
    });
    console.log(`[monitor] run complete — ${items.reduce((n, i) => n + (i.newResults || []).length, 0)} new lead(s)`);
  } finally {
    monitorRunning = false;
  }
}

app.post('/api/monitor-run', (req, res) => {
  if (monitorRunning) return res.json({ started: false, note: 'Already running' });
  runLeadMonitor('manual'); // fire and forget — frontend polls the report
  res.json({ started: true });
});

// Internal scheduler: first check after 7am each day runs the watchlist.
// The watchdog keeps the server alive 24/7, so this fires reliably each morning.
setInterval(() => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const report = loadJson(MONITOR_REPORT_FILE, {});
  if (report.date !== today && now.getHours() >= 7) runLeadMonitor('schedule');
}, 30 * 60 * 1000);

// ── Live commodity prices ─────────────────────────────────────────────────────
// Copper/gold/silver come live from Yahoo Finance (free, no key), cached 15 min.
// Tin and antimony have no reliable free feed (minor/opaque markets), so they are
// maintained manually by the trader (stored, editable) with a clear "reference" note.
const COMMODITY_MANUAL_FILE = path.join(__dirname, 'data', 'commodity-manual.json');
const LB_PER_MT = 2204.62;
let commodityCache = { time: 0, data: null };

const LIVE_METALS = [
  { key: 'copper', name: 'Copper', symbol: 'HG=F', unit: 'USD/lb', toMT: p => p * LB_PER_MT },
  { key: 'gold',   name: 'Gold',   symbol: 'GC=F', unit: 'USD/oz' },
  { key: 'silver', name: 'Silver', symbol: 'SI=F', unit: 'USD/oz' }
];

async function fetchLiveMetal(m) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${m.symbol}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    const meta = (await r.json())?.chart?.result?.[0]?.meta;
    if (!meta || meta.regularMarketPrice == null) return null;
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose ?? meta.previousClose ?? price;
    const changePct = prev ? ((price - prev) / prev) * 100 : 0;
    return {
      key: m.key, name: m.name, price, unit: m.unit,
      pricePerMT: m.toMT ? Math.round(m.toMT(price)) : null,
      changePct: +changePct.toFixed(2), source: 'live', currency: meta.currency || 'USD'
    };
  } catch (_) { return null; }
}

app.get('/api/commodity-prices', async (req, res) => {
  const now = Date.now();
  if (commodityCache.data && now - commodityCache.time < 15 * 60 * 1000) {
    return res.json({ ...commodityCache.data, cached: true, manual: loadJson(COMMODITY_MANUAL_FILE, defaultManual()) });
  }
  const live = (await Promise.all(LIVE_METALS.map(fetchLiveMetal))).filter(Boolean);
  const payload = { live, updatedAt: new Date().toISOString() };
  if (live.length) commodityCache = { time: now, data: payload };
  res.json({ ...payload, manual: loadJson(COMMODITY_MANUAL_FILE, defaultManual()) });
});

function defaultManual() {
  return [
    { key: 'tin', name: 'Tin', price: null, unit: 'USD/MT', updatedAt: null },
    { key: 'antimony', name: 'Antimony', price: null, unit: 'USD/MT', updatedAt: null }
  ];
}

app.post('/api/commodity-manual', (req, res) => {
  const { key, price, unit } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key is required' });
  const list = loadJson(COMMODITY_MANUAL_FILE, defaultManual());
  const item = list.find(m => m.key === key);
  if (!item) return res.status(404).json({ error: 'unknown metal' });
  const n = parseFloat(price);
  item.price = isNaN(n) ? null : Math.max(0, n);
  if (unit) item.unit = String(unit).slice(0, 20);
  item.updatedAt = new Date().toISOString();
  writeJson(COMMODITY_MANUAL_FILE, list);
  res.json({ manual: list });
});

// ── Marketing Kit generator ───────────────────────────────────────────────────
// One product in -> a complete B2B marketing kit out: portal listing, LinkedIn
// post, outreach email, HS code and buyer-search keywords. Grounded on the
// details the user provides; the AI must not invent specs or certifications.
app.post('/api/marketing-kit', async (req, res) => {
  const { product, details, origin, terms } = req.body || {};
  if (!product) return res.status(400).json({ error: 'product is required' });
  if (!AI_PROVIDER) return res.status(503).json({ error: 'No AI key configured' });

  const prompt = `You are a B2B trade marketing specialist at a Singapore trading company. Create a marketing kit for this product they SELL:

PRODUCT: ${product}
${details ? 'DETAILS PROVIDED BY SELLER: ' + String(details).slice(0, 500) : ''}
${origin ? 'ORIGIN: ' + origin : ''}
${terms ? 'TRADE TERMS: ' + terms : ''}

Rules:
- Use ONLY the details provided. Where a spec is unknown, write placeholders like "[grade]" or omit — NEVER invent specs, certifications, capacities, or prices.
- listingTitle: portal-style title buyers search for (under 80 chars, keyword-rich).
- listingBody: 120-180 word B2B portal listing (TradeWheel/Alibaba style): what it is, quality/spec line, supply capability phrasing, terms, call to action. Professional trade English.
- linkedinPost: 60-100 words, professional but human, ends with a call to action. No hashtag spam — max 3 relevant hashtags.
- outreachEmail: first-contact email to a prospective buyer of this product. Under 150 words, subject under 60 chars, ends "Best regards," (sender adds name).
- hsCode: the 6-digit HS code (format XXXX.XX) for this product.
- keywords: 5-8 search terms buyers actually use for this product.

Return ONLY valid JSON:
{"listingTitle":"...","listingBody":"...","linkedinPost":"...","outreachEmail":{"subject":"...","body":"..."},"hsCode":"...","keywords":["..."]}`;

  try {
    const kit = await callAI(prompt);
    if (!kit.listingTitle || !kit.listingBody) throw new Error('AI returned incomplete kit');
    res.json({
      listingTitle: String(kit.listingTitle).slice(0, 120),
      listingBody: String(kit.listingBody).slice(0, 2000),
      linkedinPost: String(kit.linkedinPost || '').slice(0, 1200),
      outreachEmail: {
        subject: String(kit.outreachEmail?.subject || '').slice(0, 120),
        body: String(kit.outreachEmail?.body || '').slice(0, 2000)
      },
      hsCode: String(kit.hsCode || '').slice(0, 12),
      keywords: (Array.isArray(kit.keywords) ? kit.keywords : []).slice(0, 8).map(k => String(k).slice(0, 50))
    });
  } catch (err) {
    res.status(500).json({ error: 'Marketing kit failed: ' + err.message });
  }
});

// ── Outreach campaign: batch-personalized offer emails for shortlisted buyers ──
app.post('/api/campaign', async (req, res) => {
  const { links, product } = req.body || {};
  if (!product || !Array.isArray(links) || !links.length) {
    return res.status(400).json({ error: 'product and links[] are required' });
  }
  if (!AI_PROVIDER) return res.status(503).json({ error: 'No AI key configured' });

  const saved = loadSaved();
  const targets = links.slice(0, 15) // hard cap — each row is an AI call
    .map(l => saved.find(s => s.link === l)).filter(Boolean);
  if (!targets.length) return res.status(400).json({ error: 'None of the links are on the shortlist' });

  const rows = [];
  for (const t of targets) {
    try {
      const draft = await callAI(`You are a B2B sales manager at a Singapore trading company writing a first-contact sales email.

PROSPECTIVE BUYER:
- Company: ${t.title}
- Type: ${t.type || 'unknown'}
- Country: ${t.country || 'unknown'}
- What we know: ${(t.snippet || '').slice(0, 250)}
${t.notes ? '- Internal notes: ' + t.notes.slice(0, 200) : ''}

PRODUCT WE ARE SELLING: ${product}

Write a concise, personalized sales email (under 150 words) offering to supply this product.
Reference something specific about THIS buyer. Do not invent facts, prices, or certifications.
End with a clear next step. Sign off "Best regards," (sender adds their name).
Return ONLY valid JSON: {"subject":"...","body":"..."}`);
      rows.push({
        company: t.title, country: t.country || '', email: t.email || '',
        link: t.link, subject: draft.subject || '', body: draft.body || ''
      });
    } catch (err) {
      rows.push({ company: t.title, country: t.country || '', email: t.email || '', link: t.link, subject: '', body: '', error: String(err.message).slice(0, 100) });
    }
    await new Promise(r => setTimeout(r, 800)); // pace the AI calls
  }
  res.json({ product, count: rows.length, rows });
});

// ── Erez Assistant (AI copilot) ───────────────────────────────────────────────
// Agentic chat: Gemini gets the app's capabilities as callable tools and chains
// them to answer business questions ("find X, check trust, save the best") in
// one conversation. Tool results are trimmed hard to keep token usage sane.

const trimResults = (arr, n = 6) => (arr || []).slice(0, n).map(r => ({
  title: r.title, link: r.link, domain: r.displayLink, type: r.type,
  country: r.country || undefined, isRFQ: r.isRFQ || undefined,
  snippet: (r.snippet || '').slice(0, 120)
}));

const COPILOT_TOOLS = {
  search_suppliers: {
    decl: { name: 'search_suppliers', description: 'Search the web for suppliers/manufacturers of a product. Returns top results.',
      parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' }, country: { type: 'STRING', description: 'optional country filter' } }, required: ['query'] } },
    run: async (a) => {
      const p = new URLSearchParams({ q: a.query }); if (a.country) p.set('country', a.country);
      const d = await (await fetch(`http://localhost:${PORT}/api/search?${p}`, { signal: AbortSignal.timeout(90000) })).json();
      return { count: d.count, results: trimResults(d.results) };
    }
  },
  search_buyers: {
    decl: { name: 'search_buyers', description: 'Find companies that BUY a product (importers, wholesalers, active buy requests/RFQs).',
      parameters: { type: 'OBJECT', properties: { product: { type: 'STRING' }, country: { type: 'STRING' } }, required: ['product'] } },
    run: async (a) => {
      const p = new URLSearchParams({ product: a.product }); if (a.country) p.set('country', a.country);
      const d = await (await fetch(`http://localhost:${PORT}/api/search-customers?${p}`, { signal: AbortSignal.timeout(90000) })).json();
      return { count: (d.results || []).length, results: trimResults(d.results) };
    }
  },
  get_shortlist: {
    decl: { name: 'get_shortlist', description: 'Get the team shortlist (saved suppliers/buyers) with pipeline status, days in stage, notes, trust verdict, and deal margins.',
      parameters: { type: 'OBJECT', properties: {} } },
    run: async () => ({
      shortlist: loadSaved().map(s => {
        const days = Math.floor((Date.now() - new Date(s.statusChangedAt || s.savedAt).getTime()) / 86400000);
        const d = s.deal || {};
        const cost = (d.buy || 0) + (d.freight || 0) + (d.duties || 0);
        return {
          title: s.title, link: s.link, status: s.status || 'new', daysInStage: days,
          country: s.country || undefined, phone: s.phone || undefined, email: s.email || undefined,
          notes: s.notes || undefined, trust: s.trust ? `${s.trust.rating} ${s.trust.score ?? ''}` : undefined,
          margin: (d.sell != null && d.buy != null) ? +(d.sell - cost).toFixed(2) : undefined,
          marginPct: (d.sell != null && d.buy != null && cost > 0) ? +((d.sell - cost) / cost * 100).toFixed(1) : undefined
        };
      })
    })
  },
  save_supplier: {
    decl: { name: 'save_supplier', description: 'Save a company to the shared shortlist. Use link+title from a prior search result.',
      parameters: { type: 'OBJECT', properties: { link: { type: 'STRING' }, title: { type: 'STRING' }, type: { type: 'STRING' }, country: { type: 'STRING' }, snippet: { type: 'STRING' } }, required: ['link', 'title'] } },
    run: async (a) => {
      const d = await (await fetch(`http://localhost:${PORT}/api/saved`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link: a.link, title: a.title, displayLink: (a.link.match(/\/\/(?:www\.)?([^\/]+)/) || [])[1] || '', type: a.type || '', country: a.country || '', snippet: a.snippet || '' })
      })).json();
      return { saved: true, shortlistSize: (d.saved || []).length, note: d.note };
    }
  },
  update_supplier: {
    decl: { name: 'update_supplier', description: 'Update a shortlisted company: set pipeline status (new/contacted/quoted/sampled/ordered/rejected) and/or append notes.',
      parameters: { type: 'OBJECT', properties: { link: { type: 'STRING' }, status: { type: 'STRING' }, notes: { type: 'STRING' } }, required: ['link'] } },
    run: async (a) => {
      const body = { link: a.link };
      if (a.status) body.status = a.status;
      if (a.notes) {
        const cur = loadSaved().find(s => s.link === a.link);
        body.notes = ((cur && cur.notes ? cur.notes + '\n' : '') + a.notes).slice(0, 2000);
      }
      const r = await fetch(`http://localhost:${PORT}/api/saved`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { updated: r.ok };
    }
  },
  enrich_company: {
    decl: { name: 'enrich_company', description: 'Scrape a company website for contact details: phone, email, address, WhatsApp, key people, size.',
      parameters: { type: 'OBJECT', properties: { url: { type: 'STRING' }, name: { type: 'STRING' } }, required: ['url'] } },
    run: async (a) => {
      const p = new URLSearchParams({ url: a.url }); if (a.name) p.set('name', a.name);
      const d = await (await fetch(`http://localhost:${PORT}/api/enrich?${p}`, { signal: AbortSignal.timeout(60000) })).json();
      const { success, website, phone, fax, email, address, whatsapp, country, founded, employeeCount, description } = d;
      return { success, website, phone, fax, email, address, whatsapp, country, founded, employeeCount, description: (description || '').slice(0, 200) };
    }
  },
  trust_check: {
    decl: { name: 'trust_check', description: 'Run a trust/reputation check on a company website. Returns rating and score /100.',
      parameters: { type: 'OBJECT', properties: { url: { type: 'STRING' }, name: { type: 'STRING' } }, required: ['url'] } },
    run: async (a) => {
      const p = new URLSearchParams({ url: a.url }); if (a.name) p.set('name', a.name);
      const d = await (await fetch(`http://localhost:${PORT}/api/trust-check?${p}`, { signal: AbortSignal.timeout(60000) })).json();
      return { rating: d.rating, score: d.score, findings: (d.findings || []).slice(0, 4).map(f => f.text) };
    }
  },
  get_new_leads: {
    decl: { name: 'get_new_leads', description: 'Get the latest lead-monitor report: NEW suppliers/buyers/RFQs found by the watched searches since the previous run.',
      parameters: { type: 'OBJECT', properties: {} } },
    run: async () => {
      const rep = loadJson(MONITOR_REPORT_FILE, {});
      return {
        lastRun: rep.generatedAt || null,
        watches: (rep.items || []).map(i => ({
          query: i.watch.query, mode: i.watch.mode, error: i.error,
          newLeads: (i.newResults || []).map(x => ({ title: x.title, link: x.link, domain: x.displayLink, isRFQ: x.isRFQ }))
        }))
      };
    }
  },
  get_commodity_prices: {
    decl: { name: 'get_commodity_prices', description: 'Get current market prices for copper, gold, silver (live) and tin, antimony (reference). Use for pricing advice, margin checks, and buy/sell timing.',
      parameters: { type: 'OBJECT', properties: {} } },
    run: async () => {
      const live = (await Promise.all(LIVE_METALS.map(fetchLiveMetal))).filter(Boolean);
      return {
        live: live.map(m => ({ metal: m.name, price: m.price, unit: m.unit, pricePerMT: m.pricePerMT, changePct: m.changePct })),
        reference: loadJson(COMMODITY_MANUAL_FILE, defaultManual()).filter(m => m.price != null)
          .map(m => ({ metal: m.name, price: m.price, unit: m.unit, note: 'manually maintained' }))
      };
    }
  },
  recall_company: {
    decl: { name: 'recall_company', description: 'Check the Company Brain: has the app dealt with this company before? Returns remembered contacts, trust verdict, and past interactions. Pass the website domain (e.g. "acme.com").',
      parameters: { type: 'OBJECT', properties: { host: { type: 'STRING' } }, required: ['host'] } },
    run: async (a) => {
      const rec = lookupCompanyBrain(a.host);
      if (!rec) return { known: false };
      return { known: true, name: rec.name, country: rec.country, phone: rec.phone, email: rec.email,
        trust: rec.trustRating ? `${rec.trustRating} ${rec.trustScore ?? ''}` : undefined,
        firstSeen: rec.firstSeen, lastSeen: rec.lastSeen, interactionCount: (rec.interactions || []).length };
    }
  }
};

app.post('/api/copilot', async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages array required' });
  if (!GEMINI_KEY) return res.status(503).json({ error: 'Copilot requires a Gemini API key' });

  const systemText = `You are Erez Assistant, the AI assistant inside Erez Impex Pte Ltd's B2B sourcing app used by a Singapore trading company (commodities: copper, metals, and other products).
You have tools: web supplier/buyer search, the team's shared shortlist (pipeline statuses, notes, margins), contact enrichment, trust checks, and the overnight lead monitor.
Rules:
- Use tools to answer with real data; never invent companies, prices, or contact details.
- Chain tools when useful (search -> trust check -> save), but be economical: no more than needed.
- When the user asks to draft an email, write it yourself directly in the reply.
- Be concise and businesslike. Summarize what actions you took. Currency amounts: repeat them exactly as stored.
- If a tool errors or search quality is limited (e.g. quota issues), say so plainly.`;

  const contents = messages.slice(-12).map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: String(m.text || '').slice(0, 2000) }] }));
  const actions = [];

  try {
    for (let turn = 0; turn < 6; turn++) {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemText }] },
            contents,
            tools: [{ functionDeclarations: Object.values(COPILOT_TOOLS).map(t => t.decl) }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 2500 }
          }),
          signal: AbortSignal.timeout(120000)
        }
      );
      const data = await r.json();
      if (data.error) {
        recordSvc('gemini', /quota|exceeded/i.test(data.error.message) ? 'quota' : 'error', data.error.message);
        throw new Error(data.error.message);
      }
      recordSvc('gemini', 'ok');
      const parts = data.candidates?.[0]?.content?.parts || [];
      const calls = parts.filter(p => p.functionCall);

      if (!calls.length) {
        const text = parts.map(p => p.text || '').join('').trim();
        return res.json({ reply: text || 'I could not produce a reply — please rephrase.', actions });
      }

      // Execute the requested tool calls, feed results back, continue the loop
      contents.push({ role: 'model', parts: calls.map(c => ({ functionCall: c.functionCall })) });
      const responses = [];
      for (const c of calls) {
        const { name, args } = c.functionCall;
        const tool = COPILOT_TOOLS[name];
        let result;
        try {
          result = tool ? await tool.run(args || {}) : { error: 'unknown tool' };
        } catch (err) {
          result = { error: String(err.message).slice(0, 150) };
        }
        actions.push({ tool: name, args: args || {}, ok: !result.error });
        responses.push({ functionResponse: { name, response: { result } } });
      }
      contents.push({ role: 'user', parts: responses });
    }
    res.json({ reply: 'I ran out of steps for this request — try breaking it into smaller questions.', actions });
  } catch (err) {
    res.status(500).json({ error: 'Copilot failed: ' + err.message, actions });
  }
});

// ── AI-drafted inquiry email ──────────────────────────────────────────────────
// Personalizes the RFQ using whatever we know about the supplier (type, country,
// snippet, scraped contact info). Falls back to the static template client-side
// if this errors or no AI key is configured.
app.post('/api/ai-inquiry', async (req, res) => {
  const { supplier, product } = req.body || {};
  if (!supplier || !supplier.title) return res.status(400).json({ error: 'supplier is required' });
  if (!AI_PROVIDER) return res.status(503).json({ error: 'No AI key configured' });

  const prompt = `You are a professional B2B sourcing manager writing a first-contact inquiry email.

SUPPLIER INFO:
- Company: ${supplier.title}
- Type: ${supplier.type || 'unknown'}
- Country: ${supplier.country || 'unknown'}
- About: ${(supplier.snippet || '').slice(0, 300)}

PRODUCT WE ARE SOURCING: ${product || 'their products'}

Write a concise, professional inquiry email (under 180 words) requesting a quotation.
Personalize it: reference something specific about THIS supplier (their specialty,
country, or type) so it doesn't read like a mass template. Ask for: specs/grades,
pricing (FOB/CIF), MOQ, lead time, and certifications — phrased naturally, not as
a numbered checklist unless it flows well. Do not invent facts not in SUPPLIER INFO.
Sign off with "Best regards," and nothing after it (the sender adds their name).

Return ONLY valid JSON: {"subject": "...", "body": "..."}`;

  try {
    const draft = await callAI(prompt);
    if (!draft.subject || !draft.body) throw new Error('AI returned incomplete draft');
    res.json({ subject: draft.subject, body: draft.body });
  } catch (err) {
    res.status(500).json({ error: 'AI draft failed: ' + err.message });
  }
});

// ── Product identification from a photo (Gemini Vision) ──────────────────────
// Takes a base64 image, returns what product it shows plus search-ready
// keywords — the frontend then feeds those straight into a supplier search.
app.post('/api/identify-image', async (req, res) => {
  const { image, mimeType } = req.body || {};
  if (!image) return res.status(400).json({ error: 'image (base64) is required' });
  if (!GEMINI_KEY) return res.status(503).json({ error: 'Image identification requires a Gemini API key' });

  const prompt = `Identify the PRODUCT shown in this image for B2B sourcing purposes.

Rules:
- Name the product as a buyer would search for it (e.g. "copper cathode", "400W monocrystalline solar panel", "HDPE plastic bottle 500ml")
- Include material, type, and key spec if visible
- keywords: 2-4 word search phrase for finding suppliers of this exact product
- If it shows a brand/logo prominently, note the brand but keep keywords generic (buyers source the product type, not the brand)
- If you cannot identify a sellable product, set product to empty string and explain in description

Return ONLY valid JSON: {"product":"...","keywords":"...","description":"one sentence about what is visible","brand":"brand name or empty string","confidence":"high|medium|low"}`;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType || 'image/jpeg', data: image } }
          ] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2000,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 }
          }
        })
      }
    );
    const data = await r.json();
    if (data.error) {
      recordSvc('gemini', /quota|exceeded/i.test(data.error.message) ? 'quota' : 'error', data.error.message);
      throw new Error(data.error.message);
    }
    recordSvc('gemini', 'ok');
    const result = JSON.parse(data.candidates[0].content.parts[0].text);
    res.json({
      product: String(result.product || '').slice(0, 120),
      keywords: String(result.keywords || result.product || '').slice(0, 80),
      description: String(result.description || '').slice(0, 300),
      brand: String(result.brand || '').slice(0, 60),
      confidence: ['high','medium','low'].includes(result.confidence) ? result.confidence : 'medium'
    });
  } catch (err) {
    res.status(500).json({ error: 'Image identification failed: ' + err.message });
  }
});

// ── AI-drafted sales offer (mirror of ai-inquiry, seller side) ────────────────
// Drafts a pitch TO a prospective buyer, personalized to what we know about them.
app.post('/api/ai-offer', async (req, res) => {
  const { buyer, product } = req.body || {};
  if (!buyer || !buyer.title) return res.status(400).json({ error: 'buyer is required' });
  if (!AI_PROVIDER) return res.status(503).json({ error: 'No AI key configured' });

  const prompt = `You are a professional B2B sales manager at a trading company writing a first-contact sales email.

PROSPECTIVE BUYER:
- Company: ${buyer.title}
- Buyer type: ${buyer.type || 'unknown'}
- Country: ${buyer.country || 'unknown'}
- About: ${(buyer.snippet || '').slice(0, 300)}
${buyer.isRFQ ? '- NOTE: This buyer appears to have POSTED AN ACTIVE BUY REQUEST for this product — respond to their request directly.' : ''}

PRODUCT WE ARE SELLING: ${product || 'our products'}

Write a concise, professional sales email (under 170 words) offering to supply this product.
Personalize it: reference something specific about THIS buyer (their type, market, country,
or their buy request if noted). Mention we can provide specifications, competitive FOB/CIF
pricing, and samples on request. Do not invent facts, prices, or certifications.
End with a clear next step (e.g. asking for their target specs/quantity).
Sign off with "Best regards," and nothing after it (the sender adds their name).

Return ONLY valid JSON: {"subject": "...", "body": "..."}`;

  try {
    const draft = await callAI(prompt);
    if (!draft.subject || !draft.body) throw new Error('AI returned incomplete draft');
    res.json({ subject: draft.subject, body: draft.body });
  } catch (err) {
    res.status(500).json({ error: 'AI offer failed: ' + err.message });
  }
});

// ── AI person profile summary ─────────────────────────────────────────────────
// Synthesizes raw person-search results (LinkedIn/directory/news links) into a
// structured mini-profile. Strictly grounded: only facts present in the
// provided snippets, so the model can't invent a biography.
app.post('/api/ai-person-summary', async (req, res) => {
  const { person, results } = req.body || {};
  if (!person || !Array.isArray(results) || !results.length) {
    return res.status(400).json({ error: 'person and results are required' });
  }
  if (!AI_PROVIDER) return res.status(503).json({ error: 'No AI key configured' });

  const evidence = results.slice(0, 12).map((r, i) =>
    `[${i + 1}] ${r.title || ''} — ${(r.snippet || '').slice(0, 200)} (${r.displayLink || ''})`).join('\n');

  const prompt = `You are building a professional profile of a person from search results.

PERSON SEARCHED: ${person}

SEARCH RESULTS:
${evidence}

Rules:
- Use ONLY facts stated in the search results above. Never invent roles, companies, or dates.
- If results appear to describe DIFFERENT people with the same name, say so in the summary.
- companies: list company names this person is linked to (with their role there if stated).
- Keep the summary 2-3 sentences, professional tone.
- confidence: "high" if multiple results agree, "medium" if single-source, "low" if results are thin or conflicting.

Return ONLY valid JSON:
{"summary":"...","currentRole":"... or empty string","companies":[{"name":"...","role":"..."}],"confidence":"high|medium|low"}`;

  try {
    const profile = await callAI(prompt);
    if (!profile.summary) throw new Error('AI returned no summary');
    res.json({
      summary: String(profile.summary).slice(0, 600),
      currentRole: String(profile.currentRole || '').slice(0, 120),
      companies: (Array.isArray(profile.companies) ? profile.companies : []).slice(0, 6)
        .map(c => ({ name: String(c.name || '').slice(0, 80), role: String(c.role || '').slice(0, 80) })),
      confidence: ['high','medium','low'].includes(profile.confidence) ? profile.confidence : 'medium'
    });
  } catch (err) {
    res.status(500).json({ error: 'Person summary failed: ' + err.message });
  }
});

// ── AI market brief ───────────────────────────────────────────────────────────
// Synthesizes market-search results into a structured brief. Grounded: only
// figures/claims present in the provided snippets, with a confidence tag.
app.post('/api/ai-market-brief', async (req, res) => {
  const { industry, country, results } = req.body || {};
  if (!industry || !Array.isArray(results) || !results.length) {
    return res.status(400).json({ error: 'industry and results are required' });
  }
  if (!AI_PROVIDER) return res.status(503).json({ error: 'No AI key configured' });

  const evidence = results.slice(0, 12).map((r, i) =>
    `[${i + 1}] ${r.title || ''} — ${(r.snippet || '').slice(0, 220)} (${r.displayLink || ''})`).join('\n');

  const prompt = `You are a market analyst summarizing search results about an industry.

INDUSTRY: ${industry}${country ? ' — focus market: ' + country : ''}

SEARCH RESULTS:
${evidence}

Rules:
- Use ONLY facts and figures stated in the search results. Never invent market sizes, growth rates, or company names.
- If different sources give conflicting figures, mention the range.
- keyPlayers: only companies explicitly named in the results.
- If the results contain no real data for a field, use an empty string / empty array for it.
- confidence: "high" if multiple substantive sources, "medium" if thin, "low" if results are mostly irrelevant.

Return ONLY valid JSON:
{"overview":"2-3 sentence market summary","marketSize":"... or empty","growth":"... or empty","keyPlayers":["..."],"trends":["..."],"confidence":"high|medium|low"}`;

  try {
    const brief = await callAI(prompt);
    if (!brief.overview) throw new Error('AI returned no overview');
    res.json({
      overview: String(brief.overview).slice(0, 700),
      marketSize: String(brief.marketSize || '').slice(0, 200),
      growth: String(brief.growth || '').slice(0, 200),
      keyPlayers: (Array.isArray(brief.keyPlayers) ? brief.keyPlayers : []).slice(0, 8).map(p => String(p).slice(0, 80)),
      trends: (Array.isArray(brief.trends) ? brief.trends : []).slice(0, 6).map(t => String(t).slice(0, 160)),
      confidence: ['high','medium','low'].includes(brief.confidence) ? brief.confidence : 'medium'
    });
  } catch (err) {
    res.status(500).json({ error: 'Market brief failed: ' + err.message });
  }
});

// ── Best Price Finder ─────────────────────────────────────────────────────────
// Searches retailers for a specific product model, extracts prices from the
// results, and (when AI is available) adds a grounded buying verdict.
// Region-specific retailer targeting: consumers buy from local stores.
const PRICE_REGIONS = {
  'Singapore':      { code: 'SG', currency: /S\$|SGD/i, sites: ['lazada.sg','shopee.sg','amazon.sg','courts.com.sg','challenger.sg','harveynorman.com.sg','qoo10.sg'] },
  'Israel':         { code: 'IL', currency: /₪|ILS|NIS/i, sites: ['ksp.co.il','ivory.co.il','bug.co.il','zap.co.il','lastprice.co.il'] },
  'USA':            { code: 'US', currency: /\$|USD/i, sites: ['amazon.com','bestbuy.com','walmart.com','newegg.com','bhphotovideo.com','target.com'] },
  'Europe':         { code: 'DE', currency: /€|EUR/i, sites: ['amazon.de','mediamarkt.de','otto.de','fnac.com','bol.com','idealo.de'] },
  'United Kingdom': { code: 'GB', currency: /£|GBP/i, sites: ['amazon.co.uk','currys.co.uk','argos.co.uk','johnlewis.com','very.co.uk'] },
  'Global':         { code: null, currency: /\$|€|£|USD/i, sites: ['amazon.com','ebay.com','aliexpress.com'] }
};

function extractPrice(text) {
  // Match "S$1,299", "$1,199.00", "€1.299,00", "₪4,590", "1,299 USD", "USD 1299"
  const m = text.match(/(?:S\$|US?\$|\$|USD|€|£|₪|SGD|EUR|GBP|ILS|NIS)\s?([\d.,]{2,10})|([\d.,]{2,10})\s?(?:USD|SGD|EUR|GBP|ILS|NIS)/i);
  if (!m) return null;
  const raw = m[0].trim();
  const numStr = (m[1] || m[2] || '').replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.');
  const value = parseFloat(numStr);
  if (isNaN(value) || value < 1) return null;
  return { display: raw.replace(/\s+/g, ''), value };
}

app.get('/api/price-search', async (req, res) => {
  const product = (req.query.product || '').trim();
  const region  = (req.query.region  || 'Global').trim();
  if (!product) return res.status(400).json({ error: 'Please provide a product model to search.' });

  const reg = PRICE_REGIONS[region] || PRICE_REGIONS['Global'];
  const siteClause = reg.sites.map(s => 'site:' + s).join(' OR ');

  // q1: regional retailers; q2: price/buy intent broad; q3: deals & coupons;
  // q4/q5: simple queries last for the DuckDuckGo fallback.
  const q1 = `"${product}" price (${siteClause})`;
  const q2 = `"${product}" (price OR buy OR "in stock") (shop OR store OR retailer)`;
  const q3 = `"${product}" (deal OR discount OR promo OR coupon OR sale OR offer)`;
  const q4 = `${product} price ${region === 'Global' ? '' : region}`.trim();
  const q5 = `${product} buy`;

  try {
    const braveCountry = reg.code ? Object.keys(COUNTRY_TLD).find(c => COUNTRY_TLD[c] === reg.code.toLowerCase()) : null;
    const [r1, r2, r3, r4, r5] = await braveMulti([
      { q: q1 }, { q: q2, country: braveCountry }, { q: q3, country: braveCountry },
      { q: q4, country: braveCountry }, { q: q5, country: braveCountry }
    ]);

    const seen = new Set(); const seenDom = new Map();
    const offers = [];
    for (const r of [r1, r2, r3, r4, r5].flat()) {
      const link = r.link || '';
      if (!link || seen.has(link)) continue;
      seen.add(link);
      const dom = (r.displayLink || '').toLowerCase().replace(/^www\./, '');
      if (NOISE_DOMAINS.some(d => dom.includes(d))) continue;
      const dc = seenDom.get(dom) || 0;
      if (dc >= 2) continue;
      const text = `${r.title || ''} ${r.snippet || ''}`;
      const price = extractPrice(text);
      const isRegional = reg.sites.some(s => dom === s || dom.endsWith('.' + s));
      const refurb = /refurbish|renewed|pre-?owned|second.?hand|used\b/i.test(text);
      const deal = /deal|discount|promo|coupon|% off|sale\b|clearance/i.test(text);
      // Relevance: model words should appear in the text
      const words = product.toLowerCase().split(/\s+/).filter(w => w.length > 1);
      const hits = words.filter(w => text.toLowerCase().includes(w)).length;
      if (hits < Math.ceil(words.length * 0.5)) continue;
      seenDom.set(dom, dc + 1);
      offers.push({
        store: dom, title: r.title, link, snippet: (r.snippet || '').slice(0, 220),
        price: price ? price.display : null, priceValue: price ? price.value : null,
        isRegional, refurb, deal
      });
      if (offers.length >= 30) break;
    }

    // Sort: priced offers first (ascending), regional stores preferred on ties
    offers.sort((a, b) => {
      if (a.priceValue != null && b.priceValue != null) return a.priceValue - b.priceValue;
      if (a.priceValue != null) return -1;
      if (b.priceValue != null) return 1;
      return (b.isRegional ? 1 : 0) - (a.isRegional ? 1 : 0);
    });

    // AI buying verdict, grounded on the extracted offers
    let verdict = null;
    if (AI_PROVIDER && offers.length) {
      try {
        const evidence = offers.slice(0, 12).map((o, i) =>
          `[${i + 1}] ${o.store} — ${o.price || 'no price shown'} — ${o.title} — ${o.snippet.slice(0, 120)}`).join('\n');
        verdict = await callAI(`You are a price-comparison analyst. A shopper wants to buy: "${product}" (region: ${region}).

OFFERS FOUND:
${evidence}

Rules:
- Use ONLY the offers above. Never invent prices, stores, or warranty terms.
- bestValue: the offer number [n] that looks like the best deal from a TRUSTWORTHY retailer (prefer known stores over unknown ones even at slightly higher price). null if no priced offers.
- priceAssessment: is the visible price range reasonable for this product? Note if prices vary a lot, if anything looks too-good-to-be-true, or if listings are refurbished.
- advice: 1-2 sentences: buy now vs wait, what to verify (warranty, authorized dealer, shipping) before ordering.

Return ONLY valid JSON: {"bestValue": n or null, "priceRange":"e.g. $1,199–$1,349 or empty", "priceAssessment":"...", "advice":"..."}`);
      } catch (_) { /* AI unavailable — table still useful on its own */ }
    }

    res.json({ product, region, count: offers.length, offers, verdict, demoMode: false });
  } catch (err) {
    res.status(500).json({ error: 'Price search failed: ' + err.message });
  }
});

// ── HS code lookup ────────────────────────────────────────────────────────────
// Suggests the Harmonized System code for a product description. HS codes are a
// stable international standard (the first 6 digits are universal), which is
// exactly the kind of well-established knowledge an LLM answers reliably.
const hsCodeCache = new Map();

app.get('/api/hs-code', async (req, res) => {
  const product = (req.query.product || '').trim();
  if (!product) return res.status(400).json({ error: 'product is required' });
  if (!AI_PROVIDER) return res.status(503).json({ error: 'No AI key configured' });

  const cacheKey = product.toLowerCase();
  if (hsCodeCache.has(cacheKey)) return res.json({ ...hsCodeCache.get(cacheKey), cached: true });

  const prompt = `What is the Harmonized System (HS) code for this product: "${product}"

Rules:
- Give the most specific 6-digit HS code (format: XXXX.XX)
- If the product is ambiguous, pick the most common commercial interpretation
- Include a one-line official-style description of that heading
- If you also know a common alternative code, include it

Return ONLY valid JSON: {"code": "XXXX.XX", "description": "...", "alternative": "XXXX.XX or empty string"}`;

  try {
    const result = await callAI(prompt);
    if (!result.code) throw new Error('AI returned no code');
    const payload = {
      code: String(result.code).slice(0, 12),
      description: String(result.description || '').slice(0, 200),
      alternative: String(result.alternative || '').slice(0, 12)
    };
    hsCodeCache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: 'HS code lookup failed: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Product Source Search Engine running at http://localhost:${PORT}`);
  const liveEngine = BRAVE_API_KEY ? 'Brave Search' : (GOOGLE_API_KEY && GOOGLE_CX) ? 'Google Custom Search' : null;
  console.log(LIVE_MODE ? `Mode: LIVE (${liveEngine})` : 'Mode: DEMO (no API key configured — using bundled sample data)');
});
