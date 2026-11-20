import { newId } from "./lib.js";

// File・blob URL・업로드 키와 id는 popup 메모리에만 둔다.
export class ImageDraft {
  items = [];
  add(files) {
    const errors = [];
    for (const file of files) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { errors.push(`${file.name}: PNG, JPEG, WebP만 첨부할 수 있습니다.`); continue; }
      if (!file.size || file.size > 5 * 1024 * 1024) { errors.push(`${file.name}: 한 장은 5MiB 이하여야 합니다.`); continue; }
      if (this.items.length >= 6) { errors.push(`${file.name}: 이미지는 최대 6장까지 첨부할 수 있습니다.`); continue; }
      this.items.push({ file, url: URL.createObjectURL(file), key: newId() });
    }
    return errors;
  }
  // 접수 여부를 모르는 메시지가 이미지를 사용했을 수 있으므로 편집하면 모든 File을 새 키로 다시 올린다.
  reset() { for (const a of this.items) { a.key = newId(); delete a.id; } }
  remove(i) { URL.revokeObjectURL(this.items[i].url); this.items.splice(i, 1); }
  clear() { while (this.items.length) this.remove(0); }
}
