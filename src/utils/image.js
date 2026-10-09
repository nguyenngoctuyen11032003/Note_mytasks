// Browser-only image helpers (canvas). Used for avatar uploads.

const ACCEPTED = /^image\/(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i;
export const MAX_SOURCE_BYTES = 15 * 1024 * 1024; // 15 MB phone photos are fine; bigger is a mistake

/** Checks the picked file before decoding it; returns an error message or null. */
export function checkImageFile(file) {
  if (!file) return 'Chưa chọn tệp.';
  if (!ACCEPTED.test(file.type || '')) return 'Chỉ nhận ảnh PNG, JPG, WebP, GIF hoặc HEIC.';
  if (file.size > MAX_SOURCE_BYTES) return 'Ảnh quá lớn (tối đa 15 MB).';
  return null;
}

function decode(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Không đọc được ảnh này.')); };
    img.src = url;
  });
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Centre-crops the image to a square and scales it to `size` px.
 * Returns { blob, type, ext } — WebP when the browser can encode it, else JPEG.
 * Re-encoding also strips EXIF (GPS, camera) from phone photos.
 */
export async function squareThumbnail(file, size = 256) {
  const img = await decode(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new Error('Không đọc được ảnh này.');
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  const out = Math.min(size, side);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);

  const webp = await toBlob(canvas, 'image/webp', 0.85);
  if (webp && webp.type === 'image/webp') return { blob: webp, type: 'image/webp', ext: 'webp' };
  const jpeg = await toBlob(canvas, 'image/jpeg', 0.88);
  if (!jpeg) throw new Error('Trình duyệt không nén được ảnh.');
  return { blob: jpeg, type: 'image/jpeg', ext: 'jpg' };
}
