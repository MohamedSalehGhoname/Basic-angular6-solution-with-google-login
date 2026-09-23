import type { Attachment } from './secrets-store';

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.72;
/** Reject attachments whose encoded size would bloat the encrypted blob. */
const MAX_ATTACHMENT_BYTES = 1_400_000;

/**
 * Reads an image File, downscales it to at most MAX_DIMENSION on its longer
 * edge, and re-encodes it as a compressed data URL so it stays small enough to
 * live inside the (encrypted) secret. Non-images and oversized results reject.
 */
export async function fileToAttachment(file: File): Promise<Attachment> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Only images can be attached.');
  }
  const dataUrl = await downscale(file);
  if (dataUrl.length > MAX_ATTACHMENT_BYTES) {
    throw new Error('Image is too large even after compression.');
  }
  return { name: file.name, type: 'image/jpeg', data: dataUrl };
}

function downscale(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
      const width = Math.round(img.width * scale);
      const height = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not process the image.'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the image.'));
    };
    img.src = url;
  });
}
