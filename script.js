/* ============================================================
   ARCHITECT OF LEARNING — interactions
   Vanilla JS · no dependencies
   ============================================================ */
(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer = window.matchMedia("(pointer: fine)").matches;

  /* ---- current year ---- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---- nav: scrolled state + mobile toggle ---- */
  var nav = document.getElementById("nav");
  var toggle = document.getElementById("navToggle");

  function onScroll() {
    if (window.scrollY > 24) nav.classList.add("scrolled");
    else nav.classList.remove("scrolled");
  }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  if (toggle) {
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }
  // close mobile menu on link click
  document.querySelectorAll(".nav__links a").forEach(function (a) {
    a.addEventListener("click", function () {
      nav.classList.remove("open");
      if (toggle) toggle.setAttribute("aria-expanded", "false");
    });
  });

  /* ---- reveal on scroll ---- */
  var reveals = document.querySelectorAll(".reveal");
  if (reduced || !("IntersectionObserver" in window)) {
    reveals.forEach(function (el) { el.classList.add("in"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.16, rootMargin: "0px 0px -8% 0px" });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* ---- count-up numbers ---- */
  function animateCount(el) {
    var target = parseFloat(el.getAttribute("data-count"));
    var prefix = el.getAttribute("data-prefix") || "";
    var suffix = el.getAttribute("data-suffix") || "";
    if (isNaN(target)) return;
    if (reduced) { el.textContent = prefix + target + suffix; return; }

    var dur = 1500;
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      var val = Math.round(target * eased);
      el.textContent = prefix + val + suffix;
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  var counters = document.querySelectorAll("[data-count]");
  if (!("IntersectionObserver" in window)) {
    counters.forEach(animateCount);
  } else {
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          animateCount(e.target);
          cio.unobserve(e.target);
        }
      });
    }, { threshold: 0.6 });
    counters.forEach(function (el) { cio.observe(el); });
  }

  /* ---- magnetic buttons ---- */
  if (finePointer && !reduced) {
    document.querySelectorAll("[data-magnetic]").forEach(function (btn) {
      btn.addEventListener("mousemove", function (ev) {
        var r = btn.getBoundingClientRect();
        var mx = ev.clientX - (r.left + r.width / 2);
        var my = ev.clientY - (r.top + r.height / 2);
        btn.style.transform = "translate(" + mx * 0.18 + "px," + my * 0.28 + "px)";
      });
      btn.addEventListener("mouseleave", function () {
        btn.style.transform = "";
      });
    });
  }

  /* ---- card cursor spotlight ---- */
  if (finePointer) {
    document.querySelectorAll(".card").forEach(function (card) {
      card.addEventListener("mousemove", function (ev) {
        var r = card.getBoundingClientRect();
        card.style.setProperty("--mx", (ev.clientX - r.left) + "px");
        card.style.setProperty("--my", (ev.clientY - r.top) + "px");
      });
    });
  }

  /* ---- ambient glow parallax ---- */
  if (finePointer && !reduced) {
    var glow = document.querySelector(".bp-glow");
    if (glow) {
      window.addEventListener("mousemove", function (ev) {
        var x = (ev.clientX / window.innerWidth - 0.5) * 40;
        var y = (ev.clientY / window.innerHeight - 0.5) * 40;
        glow.style.transform = "translate(" + x + "px," + y + "px)";
      }, { passive: true });
    }
  }

  /* ---- scroll-reactive canvas image sequence ---- */
  (function sequenceBackground() {
    var canvas = document.getElementById("seqbg");
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext("2d");

    var FRAME_COUNT = 150;
    var PATH = "assets/frames/", PREFIX = "frame_", EXT = ".webp";
    function src(i) {
      var n = "" + i;
      while (n.length < 3) n = "0" + n;
      return PATH + PREFIX + n + EXT;
    }

    var frames = new Array(FRAME_COUNT); // index 0 === frame_001
    var current = 0, ticking = false;

    function nearestLoaded(idx) {
      for (var off = 1; off < FRAME_COUNT; off++) {
        var lo = frames[idx - off], hi = frames[idx + off];
        if (lo && lo.complete && lo.naturalWidth) return lo;
        if (hi && hi.complete && hi.naturalWidth) return hi;
      }
      return null;
    }

    function draw(idx) {
      var img = (frames[idx] && frames[idx].complete && frames[idx].naturalWidth) ? frames[idx] : nearestLoaded(idx);
      if (!img) return;
      var cw = canvas.width, ch = canvas.height, iw = img.naturalWidth, ih = img.naturalHeight;
      var scale = Math.max(cw / iw, ch / ih);
      var dw = iw * scale, dh = ih * scale;
      ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    }

    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      draw(current);
    }

    function frameFromScroll() {
      var doc = document.documentElement;
      var max = doc.scrollHeight - doc.clientHeight;
      var p = max > 0 ? Math.min(Math.max(doc.scrollTop / max, 0), 1) : 0;
      return Math.round(p * (FRAME_COUNT - 1));
    }

    // rAF-throttled scroll → draw happens inside the frame, never in the listener
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        current = frameFromScroll();
        draw(current);
        ticking = false;
      });
    }

    // 1) draw frame_001 immediately for instant first paint
    var first = new Image();
    first.onload = function () {
      frames[0] = first;
      document.body.classList.add("seq-active");
      resize();
      if (reduced) return; // a11y: keep frame_001 static, no scroll binding

      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", resize, { passive: true });

      // 2) lazy-preload frames 002–150 only AFTER full load (never blocks render)
      function preloadRest() {
        for (var i = 2; i <= FRAME_COUNT; i++) {
          (function (idx) {
            var im = new Image();
            im.onload = function () { frames[idx - 1] = im; };
            im.src = src(idx);
          })(i);
        }
      }
      if (document.readyState === "complete") preloadRest();
      else window.addEventListener("load", preloadRest);
    };
    first.onerror = function () {
      // sequence missing → keep the CSS background fallback, page never breaks
      console.warn("[seqbg] frame sequence unavailable; using CSS background fallback.");
    };
    first.src = src(1);
  })();
})();
