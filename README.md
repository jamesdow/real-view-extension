# Real View — AI Image Toggle

A Chrome extension with one switch: **AI Images**. Flip it on and any image
the extension believes is AI-generated gets blurred (or hidden) on the page
you're viewing — useful when you're hunting for real reference photos and
don't want AI content mixed into the results.

**Switch semantics:** ON (coloured) = actively hiding/blurring flagged AI
images. OFF = showing everything normally.

## How detection works

Free, client-side signals, no account or API key required:

1. **Domain list** — instantly flags images served from known AI-generation
   platforms, and tags images from known real-photo sources (Unsplash,
   Pexels, Getty, Wikimedia, press wires) so you can see it's confident
   either way. Three layers, checked in order:
   - A small curated list (`content/detector.js`)
   - A bundled snapshot of laylavish's **[Huge AI Blocklist](https://github.com/laylavish/uBlockOrigin-HUGE-AI-Blocklist)**
     (CC0, ~1,650 entries) in `content/ai-domains-data.js`
   - Your own custom entries from the options page
   - Optionally, a freshly re-fetched copy of the same list cached in
     `chrome.storage.local` (see "Keeping the blocklist current" below)

   Matching is against the **full URL**, not just the hostname, because some
   blocklist entries are path-scoped (e.g. `adobe.com/products/firefly`,
   which blocks only Adobe's Firefly section, not all of adobe.com).

2. **Google Images source detection** — Google Images routes every thumbnail
   through its own `gstatic.com` proxy, so the `<img src>` never reveals the
   real host. Google embeds the true source page in a `data-lpage` attribute
   on each result tile; `content/content.js` reads that and classifies against
   it, falling back to the thumbnail URL only if no `data-lpage` is present.
   Verified live: this is what makes filtering work on Google Images searches,
   not just dedicated AI-art sites.

3. **Pinterest source detection** — same dead-end problem as Google Images
   (every thumbnail is `pinimg.com` regardless of origin), and Pinterest doesn't
   expose an equivalent of Google's `data-lpage` in the grid DOM. Instead,
   `content/pinterest-hook.js` runs in the page's own JS world (a `"world": "MAIN"`
   content script, needed because an isolated-world content script gets its own
   separate `window.fetch`/`XMLHttpRequest` and can't see the page's real ones)
   and passively reads the JSON responses Pinterest's own code receives —
   both `fetch` and `XHR` are patched, since Pinterest turned out to use XHR
   for its paginated `/resource/*Resource/get/` calls, not fetch. Each pin
   object in those responses carries a `link`/`domain` field with the real
   destination. Found ones are posted back to the normal content script via
   `window.postMessage` and matched to grid tiles by pin ID (parsed from each
   tile's `/pin/<id>/` link). Neither patch alters what Pinterest's own code
   receives — each only reads a cloned copy on the side. Verified live: went
   from 0 detections on a Pinterest AI-art search to correctly resolving and
   classifying real pin destinations.

   The passive listener only learns a pin's destination if a *fresh* request
   for it happens to fire while the hook is watching — pins Pinterest serves
   from its own client-side cache (e.g. something you scrolled past earlier
   in the session) never trigger a new request, so they'd sit unresolved
   forever. `background/background.js`'s `resolvePinterestPin()` closes that
   gap: for any pin tile still unresolved after the passive path, it fetches
   the pin's own public detail page (the same page a user would see clicking
   it — no special API, no auth) and reads the same embedded data. Capped at
   3 concurrent requests and deduped so each pin is only ever resolved once.

   Caveat specific to Pinterest: a lot of pin destinations are generic
   platforms (Instagram, personal blogs, portfolio sites) rather than a
   dedicated AI tool or a URL that self-labels the content — those resolve
   correctly to a real domain but that domain isn't itself AI-flaggable. This
   is the same mixed-content gap described below, not a Pinterest-specific
   shortfall.
4. **Bing Images / DuckDuckGo Images source detection** — same proxy problem,
   two different fixes:
   - Bing embeds a JSON blob (`{"purl": "...", "murl": "..."}` — page URL and
     full-res image URL) directly on each result's `<a class="iusc">` wrapper.
     No lookup needed, just `JSON.parse` on an attribute that's already there.
   - DuckDuckGo proxies every thumbnail through `external-content.duckduckgo.com`,
     but the *original* image URL is sitting in that proxy URL's own `?u=`
     query parameter — simpler than Google/Bing, just needs decoding.
   Verified live: Bing flagged 31/399 images, DuckDuckGo 25/212, on the same
   "ai art" search, both with zero console errors.

5. **Embedded metadata** — fetches the first ~128KB of the image (via the
   background service worker, which can reach cross-origin images that a
   content script's `fetch` would be blocked from by CORS) and reads:
   - PNG `tEXt`/`iTXt` chunks for the generation parameters that Stable
     Diffusion, ComfyUI, and Automatic1111 embed by default.
   - JPEG EXIF/XMP `Software` tags naming a known generator.
   - The IPTC **digital source type** declaration
     ([cv.iptc.org/newscodes/digitalsourcetype](https://cv.iptc.org/newscodes/digitalsourcetype/)) —
     a standardized plaintext value written into XMP (and mirrored inside
     C2PA manifests) by Adobe Firefly, Bing Image Creator/Designer, and
     Google. Reading it directly gives a real verdict — `trainedAlgorithmicMedia`
     means AI-generated, `digitalCapture` means an actual camera — without
     needing to verify the C2PA manifest's cryptographic signature at all.
     A C2PA box with no digital-source-type declaration still falls back to
     "carries Content Credentials — inspect manually," since C2PA alone
     covers ordinary camera/Photoshop provenance too, not just AI.

6. **Your own flags** — right-click any image → "Real View: Flag this image
   as AI-generated" (or "Mark this image as a real photo") to correct a miss
   or false positive by exact URL. Stored in `chrome.storage.local` via
   `background.js`'s context-menu handler, applied by `content.js` ahead of
   every other signal so your own correction always wins. This is a personal
   list today — the natural next step is a shared/crowdsourced version, but
   that needs real backend infrastructure this repo doesn't have yet.

7. **On-device visual AI classifier** (opt-in, Options → "Visual AI
   Detection") — the last-resort fallback for images every signal above left
   unresolved: a real neural network looks at the actual pixels, entirely on
   your device, no upload. This is what catches an AI-generated illustration
   hosted on a legitimate news site or stock-photo platform — a case no
   domain list or URL heuristic can ever solve, since the same domain also
   hosts genuinely real content.

   Model: **[haywoodsloan/ai-image-detector-deploy](https://huggingface.co/haywoodsloan/ai-image-detector-deploy)**
   (SwinV2-base), via its ONNX conversion
   **[LPX55/detection-model-1-ONNX](https://huggingface.co/LPX55/detection-model-1-ONNX)**,
   `uint8` variant (322MB). Chosen after empirically testing three candidates
   against a 25-image hand-built set (13 AI images across
   photorealistic/fantasy/portrait styles, 12 diverse real photos):

   | Model | License | Accuracy on test set |
   |---|---|---|
   | Organika/sdxl-detector (Swin-base) | CC-BY-NC-3.0 | 68% (5/12 real photos false-flagged) |
   | **haywoodsloan/ai-image-detector-deploy (SwinV2-base)** | none listed | **84%** — best balance |
   | Community Forensics ViT-Small (UW, CVPR 2025) | MIT | 60% (weak AI-recall, 5/13 caught) |

   A 3-model ensemble (majority vote 76%, averaged probability 80%) scored
   *worse* than the best model alone — the weaker two drag down the strong
   one's correct calls rather than reinforcing them, so ensembling was
   rejected. No license is listed on the chosen model or its ONNX conversion;
   credited above regardless, and the options page labels the feature
   "experimental, community-sourced" rather than a guarantee.

   **Architecture**: runs in `offscreen/offscreen.js`, inside a
   [Chrome offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen) —
   not the background service worker, which gets killed after ~30s idle
   (incompatible with holding a 300MB+ model loaded across a browsing
   session), and not a content script, since only the background/extension
   pages can create an offscreen document. `background/background.js`'s
   `ensureOffscreenDocument()` creates it on demand and relays messages to
   it; `content/content.js` only ever queues an image for this signal if
   every earlier signal came back inconclusive, and only for images actually
   visible in the viewport (`IntersectionObserver`-gated, its own small
   concurrency cap) — never a page's whole off-screen backlog, since
   inference is far more CPU-costly per image than a metadata fetch.

   Runs on **raw `onnxruntime-web`, not transformers.js** — transformers.js's
   model registry has no Swin/SwinV2 architecture support at all (confirmed
   against 4.2.0, the latest published version at build time), so its
   `pipeline()` abstraction can't run this model. Preprocessing (256×256
   resize, ImageNet normalization) and postprocessing (softmax, confidence
   threshold) are hand-rolled in `offscreen.js` from the values in the
   model's `preprocessor_config.json`, validated against a Python
   `onnxruntime` reference implementation during model selection.

   (An earlier attempt tried transformers.js's own bundle before discovering
   the SwinV2 gap — its bare-module imports for `onnxruntime-web/webgpu` and
   `onnxruntime-common` can't be resolved via an import map at all inside
   this extension's CSP, since `script-src 'self'` blocks import maps from
   taking effect reliably here. Moot once the switch to raw `onnxruntime-web`
   happened, but worth knowing if `transformers.js` ever gets Swin/SwinV2
   support and this gets revisited.)

   Model weights are fetched once from the Hugging Face Hub CDN and cached
   via the Cache Storage API (`fetchModelBytes()` in `offscreen.js`) — the
   extension package itself only bundles the ~36MB WASM runtime
   (`lib/transformers/ort*.wasm`/`.mjs`), not the model itself, matching
   Chrome Web Store policy (no remotely-hosted *executable code*; fetching
   model *data* at runtime is the sanctioned exception).

   Verified live end-to-end: a real Lexica AI image classified "ai" at 99%
   confidence, a real Unsplash photo classified "real" at 93%, and on a live
   Google Images "ai art" search, 30 images — hosted on Adobe, NBC News,
   Smithsonian, and similar general-purpose sites no domain list would ever
   flag — correctly classified by the model alone.

Anything that doesn't match any signal is left alone and shown normally —
Real View only hides what it's actually confident about.

### Keeping the blocklist current

The Huge AI Blocklist's own header says it "expires" in about a day — it's a
fast-moving, community-curated list. The bundled copy is a snapshot (dated in
`ai-domains-data.js`), so Options has a **"Refresh AI blocklist now"** button
that re-fetches the live list and caches it in `chrome.storage.local` (too
large for the 100KB `storage.sync` quota). Refreshed entries are merged with
the bundled snapshot, not a replacement for it.

### Known limitation

Metadata scanning only works when the source image still has it — screenshots,
re-saves, and social-media re-uploads (Pinterest, etc.) strip it, and domain
matching won't help if the reposting site itself isn't on any list. The
on-device visual classifier (opt-in) closes a real chunk of that gap since it
doesn't need metadata or a recognizable domain at all — but it's one model
with real, measured error rates (see the accuracy table above), not a
guarantee, and academic benchmarks show even the best open detectors are
weak against the newest generators (Flux, Midjourney v7, Firefly v4). Treat
it as a strong extra signal, not a verdict.

## Credits

- Domain blocklist: laylavish's **[Huge AI Blocklist](https://github.com/laylavish/uBlockOrigin-HUGE-AI-Blocklist)** (CC0)
- On-device visual classifier: **[haywoodsloan/ai-image-detector-deploy](https://huggingface.co/haywoodsloan/ai-image-detector-deploy)**, via its ONNX conversion **[LPX55/detection-model-1-ONNX](https://huggingface.co/LPX55/detection-model-1-ONNX)** — no license is listed on either repo, a real gap noted above; credited here regardless since it's their model doing the work
- Inference runtime: **[ONNX Runtime Web](https://github.com/microsoft/onnxruntime)** (MIT), vendored in `lib/transformers/`

## License

MIT — see [LICENSE](LICENSE). Covers this repo's own code; the vendored ONNX
Runtime Web build and the third-party blocklist/model above keep their own
licenses as credited.

## Load it in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**, select this `real-view-extension` folder
4. Pin the extension, click it, and flip **AI Images** on on any page with
   images (try Google Images, Lexica.art, or an AI-art community site)
5. Optional: Options → **Visual AI Detection** to turn on the on-device
   classifier (downloads the ~320MB model on first use)

## Files

```
manifest.json               MV3 manifest
content/ai-domains-data.js   Bundled Huge AI Blocklist snapshot (CC0)
content/detector.js          Domain-list matching + PNG/JPEG metadata parsers (pure functions)
content/content.js           Scans page images, applies verdicts, watches for new/changed images
content/content.css          Blur/hide/tag styles
content/pinterest-hook.js    MAIN-world hook intercepting Pinterest's own fetch/XHR responses
background/background.js     Cross-origin metadata fetch, blocklist refresh, badge count,
                              offscreen-document lifecycle, model update checks
offscreen/offscreen.js       On-device visual classifier — owns the onnxruntime-web session
lib/transformers/            Vendored WASM runtime (ort.wasm.min.mjs + .wasm binaries) — not
                              fetched at runtime; only the model weights are
popup/                       Toolbar popup — per-site pause + the AI Images switch
options/                     Settings — deep-scan toggle, visual detection, custom domains,
                              blocklist refresh, flagged-images management
icons/                       Brand mark icons (teal magnifying glass + sparkle), matching the website
```
