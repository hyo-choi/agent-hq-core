import assert from "node:assert/strict";
import { test } from "node:test";
import { ImageDraft } from "./images.js";
import * as L from "./lib.js";

const png = () => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "image.png", { type: "image/png" });

test("이미지 초안: 잘못된 파일만 거절하고 장당 5MiB·6장 한도를 지킨다", () => {
  const images = new ImageDraft();
  try {
    const bad = [new File(["<svg/>"], "bad.svg", { type: "image/svg+xml" }), new File([], "empty.png", { type: "image/png" }), new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" })];
    assert.equal(images.add([...bad, png()]).length, 3);
    assert.equal(images.items.length, 1);
    assert.equal(images.add(Array.from({ length: 6 }, png)).length, 1);
    assert.equal(images.items.length, 6);
    images.remove(0);
    assert.equal(images.add([new File([new Uint8Array(5 * 1024 * 1024)], "max.webp", { type: "image/webp" })]).length, 0);
  } finally { images.clear(); }
});

test("이미지 재시도: 그대로 보내면 같은 키와 id, 편집하면 같은 File에 새 키와 id", () => {
  const images = new ImageDraft(), file = png();
  images.add([file]);
  try {
    const image = images.items[0], key = image.key, url = image.url;
    image.id = "a".repeat(32);
    const target = { kind: "general", itemId: null };
    const first = { ...L.nextAttempt(null, target, "", false), attachments: [image.id] };
    assert.deepEqual(L.messageBody(L.nextAttempt(first, target, "", true)).attachments, [image.id]);
    assert.equal(L.nextAttempt(first, target, "", false).messageId, first.messageId);
    assert.equal(images.items[0].key, key);
    images.reset();
    assert.notEqual(image.key, key);
    assert.equal(image.id, undefined);
    assert.equal(image.file, file);
    assert.equal(image.url, url);
    assert.notEqual(L.nextAttempt(null, target, "", false).messageId, first.messageId);
    images.remove(0);
    assert.equal(images.items.length, 0);
  } finally { images.clear(); }
});
