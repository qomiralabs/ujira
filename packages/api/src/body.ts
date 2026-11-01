// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

import { ApiError } from './errors.js';

/**
 * Reads a JSON request body, stopping as soon as it passes the limit. A
 * Content-Length is not trusted on its own: a chunked body has none, and a
 * body longer than its header still stops at the limit.
 */
export async function readJsonBody(request: Request, limitBytes: number): Promise<unknown> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limitBytes) throw new ApiError('PAYLOAD_TOO_LARGE');
  if (request.body === null) throw new ApiError('INVALID_REQUEST', { detail: 'The body is empty' });

  // Fetch types a body as a stream of any; it is bytes.
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limitBytes) {
      await reader.cancel();
      throw new ApiError('PAYLOAD_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError('INVALID_REQUEST', { detail: 'The body is not UTF-8' });
  }
  if (text.trim() === '') throw new ApiError('INVALID_REQUEST', { detail: 'The body is empty' });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // The parser's message quotes the body, so it is not passed on.
    throw new ApiError('INVALID_REQUEST', { detail: 'The body is not valid JSON' });
  }
}
