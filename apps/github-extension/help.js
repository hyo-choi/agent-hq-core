// popup의 안내는 하나다. manual로 제어해 트리거 재클릭 때 native light dismiss와 클릭 처리가 충돌하지 않게 한다.
export function imageHelp(button, hint) {
  let pinned = false, timer, restoring = false;
  const cancel = () => clearTimeout(timer);
  const close = () => { cancel(); pinned = false; hint.hidePopover(); };
  const place = () => {
    const rect = button.getBoundingClientRect(), margin = 12;
    hint.style.width = `${Math.min(320, innerWidth - margin * 2)}px`;
    hint.style.maxHeight = `${innerHeight - margin * 2}px`;
    hint.style.left = `${Math.max(margin, Math.min(rect.left, innerWidth - hint.getBoundingClientRect().width - margin))}px`;
    const height = hint.getBoundingClientRect().height;
    const top = rect.bottom + height <= innerHeight - margin ? rect.bottom : rect.top - height;
    hint.style.top = `${Math.max(margin, Math.min(top, innerHeight - height - margin))}px`;
  };
  const show = () => { cancel(); hint.showPopover(); place(); };
  const leave = () => {
    cancel();
    // 아이콘과 안내 사이를 건너는 동안 닫히지 않게 하고, 안내에 진입하면 취소한다.
    if (!pinned && document.activeElement !== button) timer = setTimeout(close, 180);
  };
  button.addEventListener("mouseenter", show);
  button.addEventListener("mouseleave", leave);
  button.addEventListener("focus", () => { if (!restoring) show(); });
  button.addEventListener("blur", () => { if (!pinned) close(); });
  button.addEventListener("click", () => {
    if (pinned) close();
    else { pinned = true; show(); }
  });
  hint.addEventListener("mouseenter", cancel);
  hint.addEventListener("mouseleave", leave);
  hint.addEventListener("beforetoggle", (ev) => {
    button.setAttribute("aria-expanded", String(ev.newState === "open"));
    if (ev.newState === "closed") { cancel(); pinned = false; }
  });
  document.addEventListener("pointerdown", (ev) => {
    if (!button.contains(ev.target) && !hint.contains(ev.target)) close();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || ev.isComposing || !hint.matches(":popover-open")) return;
    ev.preventDefault(); ev.stopPropagation(); close();
    // 초점 복귀가 안내를 즉시 다시 여는 focus 이벤트로 해석되지 않게 한다.
    restoring = true; button.focus({ preventScroll: true }); restoring = false;
  }, true);
  for (const event of ["resize", "scroll"]) window.addEventListener(event, () => {
    if (hint.matches(":popover-open")) place();
  }, true);
}
