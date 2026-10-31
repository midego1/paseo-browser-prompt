// Drawn over the app while recording: a pointer (headless Chromium has none) and the bottom caption.
// Injected as an init script, outside the app's React tree. Adapted from midego1/kite's demo-overlay.ts.

const ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#9fb4ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z"/></svg>`;
const POINTER = `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M4.5 2.8 L4.5 19.6 L9 15.4 L12.1 21.7 L15 20.3 L11.9 14.1 L18 14.1 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

export const OVERLAY_SCRIPT = `(() => {
  const CSS = \`
    #demo-pointer { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; transform: translate(-60px, -60px); filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
    #demo-pointer::after { content: ""; position: absolute; left: -11px; top: -11px; width: 30px; height: 30px; border-radius: 50%; background: rgba(46,125,82,.45); transform: scale(0); opacity: 0; transition: transform .25s ease-out, opacity .35s ease-out; }
    #demo-pointer.down::after { transform: scale(1); opacity: 1; transition: none; }
    #demo-caption { position: fixed; left: 50%; bottom: 26px; z-index: 2147483646; pointer-events: none; display: flex; align-items: center; gap: 10px;
      padding: 11px 22px 11px 16px; border-radius: 999px; background: rgba(18,18,24,.86); color: #fff; box-shadow: 0 10px 34px rgba(0,0,0,.28), 0 0 0 1px rgba(255,255,255,.08) inset;
      -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); font: 600 19px/1.2 var(--demo-font, system-ui), system-ui, sans-serif; letter-spacing: -.01em; white-space: nowrap;
      opacity: 0; transform: translate(-50%, 14px) scale(.98); transition: opacity .38s ease, transform .45s cubic-bezier(.2,.8,.2,1); }
    #demo-caption.shown { opacity: 1; transform: translate(-50%, 0) scale(1); }
  \`;
  let pointer, caption;
  const install = () => {
    if (document.getElementById("demo-pointer")) return;
    const style = document.createElement("style");
    style.textContent = CSS;
    pointer = document.createElement("div");
    pointer.id = "demo-pointer";
    pointer.innerHTML = ${JSON.stringify(POINTER)};
    caption = document.createElement("div");
    caption.id = "demo-caption";
    document.documentElement.append(style, pointer, caption);
    const last = sessionStorage.getItem("demo-pointer");
    if (last) pointer.style.transform = "translate(" + last + ")";
  };
  const show = (text) => {
    caption.innerHTML = ${JSON.stringify(ICON)} + "<span></span>";
    caption.lastChild.textContent = text;
    const font = document.body && getComputedStyle(document.body).fontFamily;
    if (font) caption.style.setProperty("--demo-font", font);
    caption.classList.add("shown");
  };
  window.__demoCaption = (text) => {
    install();
    if (!text) { caption.classList.remove("shown"); return; }
    if (caption.classList.contains("shown")) { caption.classList.remove("shown"); setTimeout(() => show(text), 260); }
    else show(text);
  };
  addEventListener("mousemove", (event) => {
    install();
    const at = event.clientX + "px, " + event.clientY + "px";
    pointer.style.transform = "translate(" + at + ")";
    sessionStorage.setItem("demo-pointer", at);
  }, true);
  addEventListener("mousedown", () => pointer && pointer.classList.add("down"), true);
  addEventListener("mouseup", () => pointer && pointer.classList.remove("down"), true);
  if (document.documentElement) install(); else addEventListener("DOMContentLoaded", install);
})();`;
