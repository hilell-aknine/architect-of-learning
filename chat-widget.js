/* ============================================================
   העוזר של הלל — ווידג'ט צ'אט (Vanilla JS, RTL)
   מדבר עם ה-Worker (Claude Sonnet 4.6), אוסף ליד, דוחף לשיחת ייעוץ חינם.
   ============================================================ */
(function () {
  "use strict";

  // פונקציית ה-Chat ב-Supabase (פרויקט expert-clone-bot). מפתח anon ציבורי, בטוח בדף.
  var ENDPOINT = window.HAK_CHAT_ENDPOINT || "https://lgixufkqkwdbksbohnxu.supabase.co/functions/v1/chat";
  var SUPA_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxnaXh1Zmtxa3dkYmtzYm9obnh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwMjUxNzYsImV4cCI6MjA5NzYwMTE3Nn0.ig176ITZQfuodxSfktIHEqOxpb4a_dFEt1KsvWr823g";

  var OPENER =
    "היי 👋 אני העוזר של הלל. רוצה שאסביר בקצרה איך הוא גורם ללקוחות של בעלי קורסים באמת לסיים וליישם את הקורס, במקום שייעלם אחרי שיעור? ספר לי מה הקורס או העסק שלך.";

  var WA_FALLBACK = "https://wa.me/972549116092?text=" +
    encodeURIComponent("היי, ראיתי את האתר ואשמח לשיחת ייעוץ קצרה לגבי מערכת למידה לקורס שלי");

  var state = { open: false, busy: false, msgs: [] };

  // ---- שחזור שיחה מהפעלת הדפדפן ----
  try {
    var saved = sessionStorage.getItem("hak_chat");
    if (saved) state.msgs = JSON.parse(saved) || [];
  } catch (e) {}
  if (!state.msgs.length) state.msgs = [{ role: "assistant", content: OPENER }];

  function persist() {
    try { sessionStorage.setItem("hak_chat", JSON.stringify(state.msgs.slice(-30))); } catch (e) {}
  }

  // ---------- בניית DOM ----------
  var launch = el("button", "hak-launch", { "aria-label": "פתיחת שיחה עם העוזר של הלל" });
  launch.innerHTML =
    '<span class="hak-launch__ico" aria-hidden="true">' +
    '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 8.7 8.7 0 0 1-3.8-.9L3 20.5l1.5-5.6a8.4 8.4 0 0 1-1-4A8.4 8.4 0 0 1 12.5 2.6 8.4 8.4 0 0 1 21 11.5z"/></svg>' +
    "</span><span>דברו עם העוזר</span>";

  var panel = el("section", "hak-panel", { id: "hak-chat", role: "dialog", "aria-label": "שיחה עם העוזר של הלל", hidden: "" });
  panel.innerHTML =
    '<header class="hak-head">' +
      '<div class="hak-head__avatar" aria-hidden="true">ה</div>' +
      '<div class="hak-head__t"><strong>העוזר של הלל</strong><span>בונה מערכות למידה חכמות</span></div>' +
      '<button class="hak-head__close" aria-label="סגירה">&times;</button>' +
    "</header>" +
    '<div class="hak-msgs" id="hak-msgs" aria-live="polite"></div>' +
    '<form class="hak-form" id="hak-form">' +
      '<textarea class="hak-input" id="hak-input" rows="1" placeholder="כתוב כאן..." autocomplete="off"></textarea>' +
      '<button class="hak-send" type="submit" aria-label="שליחה">' +
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>' +
      "</button>" +
    "</form>" +
    '<div class="hak-foot">נבנה ע"י הלל אקנין</div>';

  document.body.appendChild(launch);
  document.body.appendChild(panel);

  var msgsEl = panel.querySelector("#hak-msgs");
  var inputEl = panel.querySelector("#hak-input");
  var formEl = panel.querySelector("#hak-form");

  // ---------- אירועים ----------
  launch.addEventListener("click", openPanel);
  // חשיפה גלובלית כדי שכפתורים בדף (כמו "הדגמת מורה AI") יוכלו לפתוח את הצ'אט
  window.HAK_openChat = openPanel;
  panel.querySelector(".hak-head__close").addEventListener("click", closePanel);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && state.open) closePanel(); });

  formEl.addEventListener("submit", function (e) { e.preventDefault(); send(); });
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener("input", function () {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 110) + "px";
  });

  function openPanel() {
    state.open = true;
    launch.hidden = true;
    panel.hidden = false;
    renderAll();
    setTimeout(function () { inputEl.focus(); }, 60);
  }
  function closePanel() {
    state.open = false;
    panel.hidden = true;
    launch.hidden = false;
  }

  // ---------- שליחה ----------
  function send() {
    var text = inputEl.value.trim();
    if (!text || state.busy) return;
    inputEl.value = "";
    inputEl.style.height = "auto";

    state.msgs.push({ role: "user", content: text });
    addBubble("user", text);
    persist();
    askServer();
  }

  function askServer() {
    state.busy = true;
    var typing = showTyping();

    fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPA_ANON,
        "Authorization": "Bearer " + SUPA_ANON,
      },
      body: JSON.stringify({ messages: state.msgs.slice(-14) }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        typing.remove();
        var reply = (data && data.reply) ||
          "סליחה, הייתה תקלה רגעית. אפשר לכתוב להלל ישירות בוואטסאפ ונחזור אליך מיד.";
        state.msgs.push({ role: "assistant", content: reply });
        addBubble("assistant", reply);
        persist();
      })
      .catch(function () {
        typing.remove();
        addBubble("assistant",
          "סליחה, אין כרגע חיבור. אפשר לכתוב להלל ישירות בוואטסאפ: " + WA_FALLBACK);
      })
      .finally(function () { state.busy = false; inputEl.focus(); });
  }

  // ---------- רינדור ----------
  function renderAll() {
    msgsEl.innerHTML = "";
    state.msgs.forEach(function (m) { addBubble(m.role, m.content, true); });
    scrollDown();
  }

  function addBubble(role, text, noScroll) {
    var b = el("div", "hak-bubble " + (role === "user" ? "hak-bubble--me" : "hak-bubble--bot"));
    linkify(b, text);
    msgsEl.appendChild(b);
    if (!noScroll) scrollDown();
  }

  function showTyping() {
    var t = el("div", "hak-typing");
    t.innerHTML = "<span></span><span></span><span></span>";
    msgsEl.appendChild(t);
    scrollDown();
    return t;
  }

  function scrollDown() { msgsEl.scrollTop = msgsEl.scrollHeight; }

  // הופך כתובות URL לקישורים, השאר כטקסט בטוח
  function linkify(node, text) {
    var re = /(https?:\/\/[^\s]+)/g;
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = el("a", "", { href: m[0], target: "_blank", rel: "noopener" });
      a.textContent = m[0];
      node.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
  }

  function el(tag, cls, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
})();
