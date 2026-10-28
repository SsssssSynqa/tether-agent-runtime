'use strict';

// Telegram's existing downloader accepts 10 MiB per image. A ten-photo album
// needs those ten image parts plus the one text part added by the bridge.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PARTS = 11;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_TOTAL_IMAGE_BASE64_CHARS = 24 * 1024 * 1024;

function capacityError(message) {
  const error = new Error(message);
  error.code = 'SYNER_INPUT_CAPACITY_EXCEEDED';
  // Re-downloading unchanged input cannot satisfy a deterministic size limit.
  error.manualRetryOnly = true;
  return error;
}

function validateParts(parts, label = 'parts') {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error(`${label} 必须是非空数组`);
  if (parts.length > MAX_PARTS) throw capacityError(`${label} 超过 ${MAX_PARTS} 项（文字加最多 10 张图）`);
  let totalImageChars = 0;
  return parts.map((part) => {
    if (part?.type === 'text') {
      const text = String(part.text || '');
      if (text.length > 64 * 1024) throw capacityError('文本 part 超过 64KB 上限');
      return { type: 'text', text };
    }
    if (part?.type === 'image') {
      const data = String(part.data || '');
      const mimeType = String(part.mimeType || 'image/jpeg').toLowerCase();
      if (!/^image\/(?:jpeg|png|webp|gif)$/.test(mimeType)) throw new Error(`不支持的图片 MIME: ${mimeType}`);
      if (data.length > MAX_IMAGE_BASE64_CHARS) throw capacityError('图片 part 超过 10MiB 原字节上限');
      if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('图片 part 不是合法 base64');
      if (Buffer.byteLength(data, 'base64') > MAX_IMAGE_BYTES) throw capacityError('图片 part 超过 10MiB 原字节上限');
      totalImageChars += data.length;
      if (totalImageChars > MAX_TOTAL_IMAGE_BASE64_CHARS) throw capacityError('图片 parts 合计超过既有 24MiB base64 上限');
      return { type: 'image', data, mimeType };
    }
    throw new Error(`不支持的 part 类型: ${part?.type || '（缺失）'}`);
  });
}

module.exports = { MAX_IMAGE_BYTES, MAX_PARTS, MAX_IMAGE_BASE64_CHARS, MAX_TOTAL_IMAGE_BASE64_CHARS, validateParts };
