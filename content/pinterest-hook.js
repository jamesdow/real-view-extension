// Runs in the page's MAIN world (not the isolated content-script world) so it can see
// Pinterest's own network calls. Pinterest routes every thumbnail through pinimg.com
// regardless of where the image actually came from, but the JSON responses that populate
// the infinite-scroll grid carry each pin's real destination in `link`/`domain` fields.
// Both fetch and XHR are patched — Pinterest's resource layer turned out to use XHR, not
// fetch, for its paginated /resource/*Resource/get/ calls. Neither patch alters what
// Pinterest's own code receives; each only reads a copy of the response on the side.
(function () {
  function collectPins(obj, out, depth) {
    if (depth > 10 || !obj || typeof obj !== "object") return;
    if (typeof obj.id !== "undefined" && typeof obj.link === "string" && obj.images) {
      out[obj.id] = { link: obj.link, domain: obj.domain || null };
      return;
    }
    for (const key in obj) {
      const val = obj[key];
      if (val && typeof val === "object") collectPins(val, out, depth + 1);
    }
  }

  function handleResponseText(text) {
    if (!text || (text[0] !== "{" && text[0] !== "[")) return;
    let json;
    try { json = JSON.parse(text); } catch { return; }
    const found = {};
    collectPins(json, found, 0);
    if (Object.keys(found).length) {
      window.postMessage({ source: "realview-pinterest-pins", pins: found }, window.location.origin);
    }
  }

  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = nativeFetch.apply(this, args);
    promise.then((response) => {
      response.clone().text().then(handleResponseText).catch(() => {});
    }).catch(() => {});
    return promise;
  };

  // Pinterest's own resource layer turned out to use XHR, not fetch, for its paginated calls.
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try { handleResponseText(this.responseText); } catch {}
    });
    return nativeSend.apply(this, args);
  };
})();
