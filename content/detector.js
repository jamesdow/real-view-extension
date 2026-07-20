// Metadata/domain detection: costs nothing, runs entirely client-side.
// Signals: (1) a small curated list of AI-generator / known-real-source hosts,
// (2) laylavish's bundled "Huge AI Blocklist" snapshot (see ai-domains-data.js),
// optionally topped up by a live-refreshed copy and the user's own custom list,
// (3) embedded file metadata that AI tools commonly leave behind.

const AI_HOST_FRAGMENTS = [
  "midjourney.com", "cdn.midjourney.com",
  "oaidalleapiprodscus.blob.core.windows.net", "labs.openai.com",
  "civitai.com", "image.civitai.com",
  "leonardo.ai", "cdn.leonardo.ai",
  "playgroundai.com", "playground.com",
  "lexica.art",
  "ideogram.ai",
  "pika.art",
  "replicate.delivery", "replicate.com",
  "stability.ai",
  "nightcafe.studio",
  "starryai.com",
  "dreamstudio.ai",
  "artbreeder.com",
  "getimg.ai",
  "runwayml.com",
  "krea.ai",
  "flux-1.ai",
  "higgsfield.ai",
];

const REAL_HOST_FRAGMENTS = [
  "images.unsplash.com",
  "cdn.pixabay.com",
  "images.pexels.com",
  "live.staticflickr.com",
  "upload.wikimedia.org",
  "media.gettyimages.com",
  "images.apimages.com",
  "reuters.com",
  "static01.nyt.com",
  "images.hearstapps.com",
  "media.npr.org",
];

const AI_SOFTWARE_MARKERS = [
  "midjourney", "dall-e", "dall·e", "dalle",
  "stable diffusion", "stablediffusion", "comfyui",
  "automatic1111", "invokeai", "adobe firefly", "firefly",
  "nightcafe", "leonardo.ai", "leonardo ai", "playground ai",
  "ideogram", "bing image creator", "designer", "google imagen",
  "imagen", "flux.1", "recraft",
];

// IPTC's standardized "digital source type" vocabulary — written into XMP (and mirrored
// inside C2PA manifests) by Adobe Firefly, Bing Image Creator/Designer, Google, and others.
// It's a plain-text controlled value, not a cryptographic claim, so this doesn't need to
// verify the C2PA signature at all — just read the declared value. Full spec:
// https://cv.iptc.org/newscodes/digitalsourcetype/
const AI_DIGITAL_SOURCE_TYPES = [
  "digitalsourcetype/trainedalgorithmicmedia",
  "digitalsourcetype/compositewithtrainedalgorithmicmedia",
];
const REAL_DIGITAL_SOURCE_TYPES = [
  "digitalsourcetype/digitalcapture",
  "digitalsourcetype/negativefilm",
  "digitalsourcetype/positivefilm",
  "digitalsourcetype/print",
];

function checkDigitalSourceType(text) {
  if (AI_DIGITAL_SOURCE_TYPES.some(t => text.includes(t))) {
    return { verdict: "ai", reason: "Content Credentials declare this AI-generated (IPTC digital source type)" };
  }
  if (REAL_DIGITAL_SOURCE_TYPES.some(t => text.includes(t))) {
    return { verdict: "real", reason: "Content Credentials declare this a real camera capture (IPTC digital source type)" };
  }
  return null;
}

let customAiDomains = [];
let refreshedAiDomains = [];

function setCustomAiDomains(list) {
  customAiDomains = Array.isArray(list) ? list.map(d => d.trim().toLowerCase()).filter(Boolean) : [];
}

function setRefreshedAiDomains(list) {
  refreshedAiDomains = Array.isArray(list) ? list : [];
}

// Matching against the full URL (not just hostname) so path-scoped entries like
// "adobe.com/products/firefly" work — some AI blocklist entries only cover one
// section of an otherwise-legitimate domain.
function urlMatches(url, fragments) {
  const lower = url.toLowerCase();
  return fragments.some(f => lower.includes(f));
}

// Mixed-content sites (Vecteezy, Pixabay, Freepik...) host both real and AI work, so they
// can't go on a domain blocklist without over-blocking — but individual AI assets there
// often self-label it in the URL slug/filename. High-precision phrases only.
const AI_SELF_LABEL_MARKERS = [
  "ai-generated", "ai_generated", "aigenerated", "generated-by-ai", "generated_by_ai",
  "stable-diffusion", "stablediffusion", "dall-e", "dalle-image", "text-to-image", "txt2img",
];

function classifyByDomain(url) {
  if (!url) return null;
  if (urlMatches(url, AI_HOST_FRAGMENTS)) return { verdict: "ai", reason: "Hosted on a known AI-image platform" };
  if (urlMatches(url, customAiDomains)) return { verdict: "ai", reason: "Hosted on a custom-listed AI-image source" };
  if (urlMatches(url, refreshedAiDomains)) return { verdict: "ai", reason: "Matches the AI blocklist (refreshed)" };
  if (urlMatches(url, AI_BLOCKLIST_SNAPSHOT)) return { verdict: "ai", reason: "Matches the bundled AI blocklist" };
  if (urlMatches(url, AI_SELF_LABEL_MARKERS)) return { verdict: "ai", reason: "URL says the asset is AI-generated" };
  if (urlMatches(url, REAL_HOST_FRAGMENTS)) return { verdict: "real", reason: "Hosted on a known photo/press source" };
  return null;
}

function readAsciiRun(bytes, start, maxLen) {
  let out = "";
  for (let i = start; i < start + maxLen && i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

// PNG: scan tEXt/iTXt/zTXt chunks for keys generators write ("parameters", "prompt", "Software", "workflow")
function scanPng(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;

  let pos = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const dataStart = pos + 8;
    if (["tEXt", "iTXt", "zTXt"].includes(type)) {
      const chunkText = readAsciiRun(bytes, dataStart, Math.min(len, 16384)).toLowerCase();
      const sourceType = checkDigitalSourceType(chunkText);
      if (sourceType) return sourceType;
      if (/^(parameters|prompt|workflow|dream|sd-metadata)/.test(chunkText) ||
          AI_SOFTWARE_MARKERS.some(m => chunkText.includes(m))) {
        return { verdict: "ai", reason: "PNG metadata contains AI generation parameters" };
      }
    }
    pos = dataStart + len + 4; // data + CRC
    if (type === "IEND") break;
  }
  return null;
}

// JPEG: walk markers, look at EXIF (APP1) Software/ImageDescription tag, and note APP11 (C2PA/JUMBF) presence.
function scanJpeg(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let pos = 2;
  let hasC2pa = false;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) break;
    const marker = bytes[pos + 1];
    if (marker === 0xd8 || marker === 0xd9) { pos += 2; continue; }
    if (marker >= 0xd0 && marker <= 0xd7) { pos += 2; continue; }
    const segLen = (bytes[pos + 2] << 8) | bytes[pos + 3];
    const segStart = pos + 4;

    if (marker === 0xe1) { // APP1 — EXIF or XMP (a JPEG can carry one of each, as separate segments)
      const ascii = readAsciiRun(bytes, segStart, Math.min(segLen, 16384)).toLowerCase();
      const sourceType = checkDigitalSourceType(ascii);
      if (sourceType) return { ...sourceType, hasC2pa };
      if (AI_SOFTWARE_MARKERS.some(m => ascii.includes(m))) {
        return { verdict: "ai", reason: "EXIF/XMP metadata names an AI generator", hasC2pa };
      }
    }
    if (marker === 0xeb) hasC2pa = true; // APP11 JUMBF box — C2PA content credentials present

    if (marker === 0xda) break; // start of scan — stop, no more markers before entropy data
    pos = segStart + segLen - 2;
  }
  if (hasC2pa) return { verdict: "unknown", reason: "Carries Content Credentials (C2PA) — inspect manually", hasC2pa: true };
  return null;
}

function scanBytes(bytes) {
  return scanPng(bytes) || scanJpeg(bytes) || null;
}

const RealViewDetector = { classifyByDomain, scanBytes, setCustomAiDomains, setRefreshedAiDomains };
