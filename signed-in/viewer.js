// browser-prompt: keyboard fixes for neko's web client in the owner's viewer (iPad, iPhone, Safari).
// Loaded from neko's index.html (a classic script at the end of <head>, so it runs before neko's
// deferred module bundle). neko takes keys only from the hidden <textarea> over the video (after a
// <canvas>). On touch devices neko never focuses it: its tap handler cancels the touch (so the tap
// does not focus it either) and it focuses on hover only without touch, so after "Request
// controls" a hardware keyboard (an iPad's Magic Keyboard) typed into nothing; only neko's keyboard
// button focused it, and that opens the on-screen keyboard.
//   - Touch devices: every tap or click on the video focuses the textarea with inputmode="none" (keys
//     from a hardware keyboard, no on-screen keyboard); when control arrives, it is focused too
//     unless something else (the chat) has focus. neko's keyboard button switches it to
//     inputmode="text" (and re-focuses it) so the on-screen keyboard opens as before.
//   - No autocorrect, autocapitalize, spell check or writing suggestions on it: iOS must not alter
//     what is typed (passwords).
//   - Capitals and shifted symbols: neko sends the character's keysym without Shift when the browser
//     reports none (the on-screen keyboard's text input, dictation, Safari's insertText), and the
//     remote desktop then types the unshifted key ("T" became "t"). bpKeyDown, called from neko's
//     onKeyDown (patched in the Dockerfile), holds Shift around such a key unless Shift, Caps Lock
//     (for letters), Ctrl, Alt or Meta is down already, or neko's key state cannot be read. Known
//     limit: neko never reports the remote desktop's Caps Lock (it only sends the local one when a
//     mouse enters the video), so with the remote Caps Lock on, a capital from the on-screen keyboard
//     comes out lowercase.
(() => {
  "use strict";
  const SHIFT_L = 0xffe1;
  const SHIFT_R = 0xffe2;
  // Characters on a shifted key of the US layout (the remote desktop's layout).
  const SHIFTED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ~!@#$%^&*()_+{}|:"<>?';
  const touch = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
  // Caps Lock and Ctrl/Alt/Meta as the last key event reported them.
  let capsLock = false;
  let otherModifier = false;
  // Keysyms that make a key a shortcut: Control, Meta, Alt, Super (left and right), AltGr, Mode_switch.
  const SHORTCUT_MODIFIERS = [0xffe3, 0xffe4, 0xffe7, 0xffe8, 0xffe9, 0xffea, 0xffeb, 0xffec, 0xfe03, 0xff7e];

  /** neko's key-capture textarea (the one right after the overlay canvas), or null. */
  const capture = () => document.querySelector("canvas + textarea");

  function prepare(input) {
    if (input.dataset.bpKeyboard) return;
    input.dataset.bpKeyboard = "1";
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("writingsuggestions", "false");
    input.spellcheck = false;
    if (touch) input.inputMode = "none";
    // Back to "no on-screen keyboard" once it closes (neko's button, or iOS hiding it).
    input.addEventListener("blur", () => {
      if (touch) input.inputMode = "none";
    });
  }

  function focusSilently(input) {
    if (document.activeElement === input) return;
    if (touch && input.inputMode !== "text") input.inputMode = "none";
    input.focus({ preventScroll: true });
  }

  // A tap or click on the video: capture phase, before neko's handler (which stops the event).
  const onPointer = (event) => {
    const input = capture();
    if (!touch || !input || event.target !== input) return;
    prepare(input);
    focusSilently(input);
  };
  window.addEventListener("touchend", onPointer, true);
  window.addEventListener("pointerup", onPointer, true);

  // neko's keyboard button: open the on-screen keyboard even when a tap focused the textarea
  // silently (re-focus with inputmode="text"; neko's click handler then focuses it).
  const onKeyboardButton = (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-testid=keyboard-toggle]") : null;
    const input = capture();
    if (!button || !input || input.inputMode === "text") return;
    prepare(input);
    if (document.activeElement === input) input.blur();
    input.inputMode = "text";
  };
  window.addEventListener("pointerdown", onKeyboardButton, true);
  window.addEventListener("touchstart", onKeyboardButton, true);
  window.addEventListener("mousedown", onKeyboardButton, true);

  // Caps Lock (and Ctrl/Alt/Meta) as the hardware keyboard reports it.
  const onKey = (event) => {
    if (typeof event.getModifierState === "function") capsLock = event.getModifierState("CapsLock");
    otherModifier = !!(event.ctrlKey || event.altKey || event.metaKey);
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);

  // The textarea appears when neko attaches its overlay; the keyboard button appears (on touch
  // devices) when the owner gets control: focus the textarea then, so keys work without a tap.
  let hadControl = false;
  new MutationObserver(() => {
    const input = capture();
    if (input) prepare(input);
    if (!touch) return;
    const control = !!document.querySelector("[data-testid=keyboard-toggle]");
    if (control && !hadControl && input) {
      const active = document.activeElement;
      const busy = active && active !== input && (active.matches("input, textarea, select, [contenteditable]") || active.isContentEditable);
      if (!busy) focusSilently(input);
    }
    hadControl = control;
  }).observe(document.documentElement, { childList: true, subtree: true });

  /** Called by neko's onKeyDown instead of client.input.key(keysym, true). */
  window.bpKeyDown = (overlay, keysym) => {
    const input = overlay.client.input;
    // neko's Guacamole keyboard (overlay.keyboard, `pressed`: keysym -> true while down). Without it
    // the Shift state is unknown: send the key as neko would.
    const pressed = overlay.keyboard?.pressed;
    const known = pressed !== null && typeof pressed === "object";
    const char = keysym > 0x20 && keysym < 0x7f ? String.fromCharCode(keysym) : "";
    const letter = char >= "A" && char <= "Z";
    const shift =
      known &&
      char !== "" &&
      SHIFTED.includes(char) &&
      !pressed[SHIFT_L] &&
      !pressed[SHIFT_R] &&
      !(letter && capsLock) &&
      !otherModifier &&
      !SHORTCUT_MODIFIERS.some((modifier) => pressed[modifier]);
    if (!shift) return input.key(keysym, true);
    input.key(SHIFT_L, true);
    try {
      input.key(keysym, true);
    } finally {
      input.key(SHIFT_L, false);
    }
  };
})();
