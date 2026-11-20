import assert from "node:assert/strict";
import { test } from "node:test";
import { imageHelp } from "./help.js";

class Element extends EventTarget {
  style = {};
  attributes = {};
  open = false;
  contains(target) { return target === this; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getBoundingClientRect() { return { left: 120, top: 200, bottom: 228, width: 320, height: 96 }; }
  matches() { return this.open; }
  focus() { document.activeElement = this; this.dispatchEvent(new Event("focus")); }
  showPopover() { if (!this.open) this.toggle("open"); }
  hidePopover() { if (this.open) this.toggle("closed"); }
  toggle(newState) {
    this.dispatchEvent(Object.assign(new Event("beforetoggle"), { newState }));
    this.open = newState === "open";
  }
}

test("안내: hover에서 클릭 고정, 다시 누르기·바깥 누르기·Escape 닫기와 초점 복귀", async () => {
  const saved = Object.fromEntries(["document", "window", "innerWidth", "innerHeight"].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const button = new Element(), hint = new Element();
  globalThis.document = new EventTarget();
  globalThis.window = new EventTarget();
  globalThis.innerWidth = 380; globalThis.innerHeight = 480;
  try {
    imageHelp(button, hint);
    assert.equal(hint.open, false);
    button.dispatchEvent(new Event("mouseenter"));
    assert.equal(button.attributes["aria-expanded"], "true");
    button.dispatchEvent(new Event("click"));
    button.dispatchEvent(new Event("mouseleave"));
    await new Promise(r => setTimeout(r, 210));
    assert.equal(hint.open, true);
    button.dispatchEvent(new Event("click"));
    assert.equal(hint.open, false);
    button.focus();
    assert.equal(hint.open, true);
    document.activeElement = hint;
    const escape = () => Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
    const openEscape = escape();
    document.dispatchEvent(openEscape);
    assert.equal(openEscape.defaultPrevented, true);
    assert.equal(document.activeElement, button);
    assert.equal(hint.open, false);
    assert.equal(button.attributes["aria-expanded"], "false");
    const closedEscape = escape();
    document.dispatchEvent(closedEscape);
    assert.equal(closedEscape.defaultPrevented, false);
    assert.equal(hint.open, false);
    // 트리거가 viewport 밖으로 나가더라도 안내 좌표는 위아래 경계 안으로 제한한다.
    button.getBoundingClientRect = () => ({ left: 120, top: 700, bottom: 728 });
    button.dispatchEvent(new Event("mouseenter"));
    assert.ok(Number.parseFloat(hint.style.top) + hint.getBoundingClientRect().height <= innerHeight - 12);
    button.getBoundingClientRect = () => ({ left: 120, top: -300, bottom: -272 });
    window.dispatchEvent(new Event("scroll"));
    assert.ok(Number.parseFloat(hint.style.top) >= 12);
    hint.hidePopover();
    button.dispatchEvent(new Event("click"));
    document.dispatchEvent(new Event("pointerdown"));
    assert.equal(hint.open, false);
    document.activeElement = null;
    button.dispatchEvent(new Event("mouseenter"));
    button.dispatchEvent(new Event("mouseleave"));
    hint.dispatchEvent(new Event("mouseenter"));
    await new Promise(r => setTimeout(r, 210));
    assert.equal(hint.open, true);
    hint.dispatchEvent(new Event("mouseleave"));
    await new Promise(r => setTimeout(r, 210));
    assert.equal(hint.open, false);
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
