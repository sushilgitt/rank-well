/* Rank Well storefront script: link prefetching, image lazy-loading and the
   404 reporter. Plain ES2018, no dependencies, ~2 KB. */
(function () {
  "use strict";
  var config = window.RankLift || {};
  var speed = config.speed || {};

  // ---- 404 reporter ------------------------------------------------------
  if (config.notFound) {
    try {
      fetch(config.proxy + "/404", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: location.pathname + location.search, referrer: document.referrer || null }),
        credentials: "same-origin",
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (answer) {
          if (answer && answer.redirect && answer.redirect !== location.pathname) location.replace(answer.redirect);
        })
        .catch(function () {});
    } catch (e) { /* never break the page */ }
  }

  // ---- Lazy images -------------------------------------------------------
  // Images the theme left eager that sit below the first screen.
  if (speed.lazyImages && "loading" in HTMLImageElement.prototype) {
    var fold = window.innerHeight * 1.5;
    var images = document.querySelectorAll("img:not([loading])");
    for (var i = 0; i < images.length; i++) {
      var rect = images[i].getBoundingClientRect();
      if (rect.top > fold) images[i].setAttribute("loading", "lazy");
      if (!images[i].hasAttribute("decoding")) images[i].setAttribute("decoding", "async");
    }
  }

  // ---- Prefetch ----------------------------------------------------------
  if (!speed.prefetch) return;
  var connection = navigator.connection;
  if (connection && (connection.saveData || /2g/.test(connection.effectiveType || ""))) return;

  var level = speed.level || "basic";
  var skip = /\/(cart|checkout|checkouts|account|apps|admin|services|password)(\/|$)|\/cart\/(add|change|clear)/;

  function eligible(a) {
    if (!a || !a.href || a.target === "_blank" || a.hasAttribute("download")) return false;
    if (a.origin !== location.origin) return false;
    if (a.pathname === location.pathname && a.search === location.search) return false;
    return !skip.test(a.pathname);
  }

  // Turbo: let the browser prerender likely next pages (Speculation Rules).
  if (level === "turbo" && HTMLScriptElement.supports && HTMLScriptElement.supports("speculationrules")) {
    var rules = document.createElement("script");
    rules.type = "speculationrules";
    rules.textContent = JSON.stringify({
      prerender: [{
        where: {
          and: [
            { href_matches: "/*" },
            { not: { href_matches: ["/cart*", "/checkout*", "/account*", "/apps/*", "/admin*", "/services/*", "/password*"] } },
            { not: { selector_matches: "[target=_blank], [download], [data-no-prerender]" } },
          ],
        },
        eagerness: "moderate",
      }],
    });
    document.head.appendChild(rules);
    return;
  }

  var done = {};
  function prefetch(url) {
    if (done[url]) return;
    done[url] = true;
    var link = document.createElement("link");
    link.rel = "prefetch";
    link.href = url;
    link.as = "document";
    document.head.appendChild(link);
  }

  var timer = null;
  // Rocket waits less on hover; basic only prefetches on touch/mousedown.
  var delay = level === "rocket" ? 65 : null;

  function anchor(event) {
    return event.target && event.target.closest ? event.target.closest("a") : null;
  }

  if (delay !== null) {
    document.addEventListener("mouseover", function (event) {
      var a = anchor(event);
      if (!eligible(a)) return;
      clearTimeout(timer);
      timer = setTimeout(function () { prefetch(a.href); }, delay);
    }, { passive: true });
    document.addEventListener("mouseout", function () { clearTimeout(timer); }, { passive: true });
  }
  ["touchstart", "mousedown"].forEach(function (type) {
    document.addEventListener(type, function (event) {
      var a = anchor(event);
      if (eligible(a)) prefetch(a.href);
    }, { passive: true, capture: true });
  });
})();
