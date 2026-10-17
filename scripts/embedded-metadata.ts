// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Exported design files can carry a signed provenance manifest (C2PA, stored as
// a JUMBF box) or an XMP packet. Neither shows up in a text diff and both can
// name the program that produced the file. This module finds them in SVG, PNG
// and JPEG files and removes them without touching anything that renders:
// PNG chunks and JPEG segments that are kept are copied byte for byte, nothing
// is decoded, recompressed or recomputed.

import { extname } from 'node:path';
import { crc32 } from 'node:zlib';

export type Format = 'svg' | 'png' | 'jpeg' | 'other';

// The byte strings below are assembled at runtime so this file, which the
// check also scans, does not contain them literally.

// A JUMBF description box whose UUID starts with "c2pa": the start of every
// C2PA manifest store, wherever it is embedded.
export const C2PA_JUMBF = ['jumd', 'c2pa'].join('');
export const XMP_PACKET_START = ['<?', 'xpacket'].join('');
export const XMP_META_ELEMENT = ['<x', 'xmpmeta'].join(':');
// The fixed packet id every XMP writer emits.
export const XMP_PACKET_ID = ['W5M0MpCehi', 'HzreSzNTczkc9d'].join('');
// Keyword of the PNG text chunk that holds an XMP packet.
export const PNG_XMP_KEYWORD = ['XML:com', 'adobe', 'xmp'].join('.');
// Namespace prefixes that open a JPEG APP1 segment holding XMP.
export const JPEG_XMP_NAMESPACE = ['http://ns', 'adobe', 'com/xap/1.0/\0'].join('.');
export const JPEG_XMP_EXTENSION_NAMESPACE = ['http://ns', 'adobe', 'com/xmp/extension/\0'].join(
  '.',
);

const GENERIC_NEEDLES: readonly [string, string][] = [
  [C2PA_JUMBF, 'C2PA JUMBF manifest box'],
  [XMP_PACKET_START, 'XMP packet'],
  [XMP_META_ELEMENT, 'XMP packet'],
  [XMP_PACKET_ID, 'XMP packet'],
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_TEXT_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt']);
const PNG_MAX_CHUNK_LENGTH = 0x7fffffff;

const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
const JPEG_APP1 = 0xe1;
const JPEG_APP11 = 0xeb;
// JPEG markers that stand alone, without a length field.
const JPEG_STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

// Markers inside SVG <metadata> that mean it holds a manifest or XMP rather
// than a plain description.
const SVG_MANIFEST_CONTENT = /c2pa|xmpmeta|xpacket|rdf:RDF/i;
const SVG_METADATA_ELEMENT = /<((?:[\w.-]+:)?metadata)\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1\s*>)/gi;
const SVG_NAMESPACE_DECLARATION = /\s+xmlns(?::([\w.-]+))?\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const SVG_C2PA_ELEMENT = /<(c2pa:[\w.-]+)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1\s*>)/gi;
const SVG_C2PA_OPEN_TAG = /<c2pa:/i;
const SVG_XMP_PACKET = /<\?xpacket\s+begin[\s\S]*?<\?xpacket\s+end[^>]*>/g;
const SVG_XMP_META = /<((?:[\w.-]+:)?xmpmeta)\b[\s\S]*?<\/\1\s*>/gi;

export class MalformedFileError extends Error {
  override name = 'MalformedFileError';
}

export function detectFormat(path: string, data: Buffer): Format {
  if (data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'png';
  if (data[0] === 0xff && data[1] === JPEG_SOI && data[2] === 0xff) return 'jpeg';
  if (extname(path).toLowerCase() === '.svg') return 'svg';
  const head = data
    .subarray(0, 4096)
    .toString('utf8')
    .replace(/^\uFEFF/, '');
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg\b/i.test(head)) {
    return 'svg';
  }
  return 'other';
}

function genericFindings(data: Buffer): string[] {
  const found: string[] = [];
  for (const [needle, reason] of GENERIC_NEEDLES) {
    if (data.includes(needle, 0, 'latin1') && !found.includes(reason)) found.push(reason);
  }
  return found;
}

function isC2paNamespace(prefix: string | undefined, uri: string): boolean {
  return prefix?.toLowerCase() === 'c2pa' || /c2pa/i.test(uri);
}

function svgFindings(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(SVG_NAMESPACE_DECLARATION)) {
    const prefix = match[1];
    const uri = match[2] ?? match[3] ?? '';
    if (isC2paNamespace(prefix, uri)) {
      found.push(`SVG declares the C2PA namespace (xmlns${prefix ? `:${prefix}` : ''})`);
    }
  }
  for (const match of text.matchAll(SVG_METADATA_ELEMENT)) {
    if (SVG_MANIFEST_CONTENT.test(match[2] ?? '')) {
      found.push('SVG <metadata> holds a C2PA or XMP manifest');
    }
  }
  if (SVG_C2PA_OPEN_TAG.test(text)) found.push('SVG contains a c2pa element');
  if (
    new RegExp(SVG_XMP_PACKET.source).test(text) ||
    new RegExp(SVG_XMP_META.source, 'i').test(text)
  ) {
    found.push('SVG contains an XMP packet');
  }
  return [...new Set(found)];
}

function stripSvg(text: string): string {
  return text
    .replace(SVG_METADATA_ELEMENT, (element, _name, content: string | undefined) =>
      SVG_MANIFEST_CONTENT.test(content ?? '') ? '' : element,
    )
    .replace(SVG_C2PA_ELEMENT, '')
    .replace(SVG_XMP_PACKET, '')
    .replace(SVG_XMP_META, '')
    .replace(
      SVG_NAMESPACE_DECLARATION,
      (
        declaration,
        prefix: string | undefined,
        double: string | undefined,
        single: string | undefined,
      ) => (isC2paNamespace(prefix, double ?? single ?? '') ? '' : declaration),
    );
}

// Fatal decoding, so an SVG that is not valid UTF-8 is refused rather than
// written back with replacement characters.
function decodeUtf8(data: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new MalformedFileError('SVG is not valid UTF-8');
  }
}

interface PngChunk {
  type: string;
  start: number;
  end: number;
  data: Buffer;
}

interface ParsedPng {
  chunks: PngChunk[];
  // Offset just past the IEND chunk; anything after it is trailing data.
  end: number;
}

export function parsePng(data: Buffer): ParsedPng {
  if (!data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new MalformedFileError('missing PNG signature');
  }
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  for (;;) {
    if (offset + 12 > data.length) {
      throw new MalformedFileError(`truncated chunk at byte ${String(offset)}`);
    }
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    if (length > PNG_MAX_CHUNK_LENGTH || offset + 12 + length > data.length) {
      throw new MalformedFileError(`chunk ${type} at byte ${String(offset)} runs past the end`);
    }
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw new MalformedFileError(`invalid chunk type at byte ${String(offset)}`);
    }
    if (chunks.length === 0 && type !== 'IHDR') {
      throw new MalformedFileError('first chunk is not IHDR');
    }
    const body = data.subarray(offset + 8, offset + 8 + length);
    const crc = data.readUInt32BE(offset + 8 + length);
    if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== crc) {
      throw new MalformedFileError(`chunk ${type} at byte ${String(offset)} has a bad CRC`);
    }
    const end = offset + 12 + length;
    chunks.push({ type, start: offset, end, data: body });
    offset = end;
    if (type === 'IEND') return { chunks, end };
  }
}

// Why a PNG chunk must go, or undefined when it is kept.
function pngChunkFinding(chunk: PngChunk): string | undefined {
  if (chunk.type.toLowerCase() === 'cabx') return `PNG ${chunk.type} chunk (C2PA manifest)`;
  if (PNG_TEXT_CHUNKS.has(chunk.type)) {
    const nul = chunk.data.indexOf(0);
    const keyword = chunk.data.toString('latin1', 0, nul === -1 ? chunk.data.length : nul);
    if (keyword === PNG_XMP_KEYWORD) return `PNG ${chunk.type} chunk holds an XMP packet`;
  }
  return undefined;
}

function pngFindings(data: Buffer): string[] {
  const { chunks, end } = parsePng(data);
  const found: string[] = [];
  for (const chunk of chunks) {
    const finding = pngChunkFinding(chunk);
    if (finding && !found.includes(finding)) found.push(finding);
  }
  if (end < data.length) found.push(`PNG has ${String(data.length - end)} bytes after IEND`);
  return found;
}

function stripPng(data: Buffer): Buffer {
  const { chunks } = parsePng(data);
  const kept = chunks
    .filter((chunk) => pngChunkFinding(chunk) === undefined)
    .map((chunk) => data.subarray(chunk.start, chunk.end));
  return Buffer.concat([PNG_SIGNATURE, ...kept]);
}

interface JpegSegment {
  marker: number;
  start: number;
  end: number;
  payload: Buffer;
}

interface ParsedJpeg {
  segments: JpegSegment[];
  // Offset of the first scan (SOS) or EOI marker. Everything from here on is
  // image data and is never inspected or changed.
  scanStart: number;
}

export function parseJpeg(data: Buffer): ParsedJpeg {
  if (data[0] !== 0xff || data[1] !== JPEG_SOI) throw new MalformedFileError('missing JPEG SOI');
  const segments: JpegSegment[] = [];
  let offset = 2;
  for (;;) {
    if (data[offset] !== 0xff) {
      throw new MalformedFileError(`expected a marker at byte ${String(offset)}`);
    }
    let markerAt = offset;
    // Any number of 0xFF fill bytes may precede a marker.
    while (data[markerAt + 1] === 0xff) markerAt += 1;
    const marker = data[markerAt + 1];
    if (marker === undefined) throw new MalformedFileError('truncated before the first scan');
    if (marker === JPEG_SOS || marker === JPEG_EOI) return { segments, scanStart: offset };
    if (JPEG_STANDALONE.has(marker)) {
      segments.push({ marker, start: offset, end: markerAt + 2, payload: Buffer.alloc(0) });
      offset = markerAt + 2;
      continue;
    }
    if (markerAt + 4 > data.length) {
      throw new MalformedFileError(`truncated segment at byte ${String(offset)}`);
    }
    const length = data.readUInt16BE(markerAt + 2);
    const end = markerAt + 2 + length;
    if (length < 2 || end > data.length) {
      throw new MalformedFileError(`segment at byte ${String(offset)} runs past the end`);
    }
    segments.push({ marker, start: offset, end, payload: data.subarray(markerAt + 4, end) });
    offset = end;
  }
}

function startsWith(payload: Buffer, prefix: string): boolean {
  return payload.subarray(0, prefix.length).equals(Buffer.from(prefix, 'latin1'));
}

// Why a JPEG segment must go, or undefined when it is kept.
function jpegSegmentFinding(segment: JpegSegment): string | undefined {
  if (
    segment.marker === JPEG_APP11 &&
    (startsWith(segment.payload, 'JP') || segment.payload.includes('jumb', 0, 'latin1'))
  ) {
    return 'JPEG APP11 JUMBF segment (C2PA manifest)';
  }
  if (
    segment.marker === JPEG_APP1 &&
    (startsWith(segment.payload, JPEG_XMP_NAMESPACE) ||
      startsWith(segment.payload, JPEG_XMP_EXTENSION_NAMESPACE))
  ) {
    return 'JPEG APP1 segment holds an XMP packet';
  }
  return undefined;
}

function jpegFindings(data: Buffer): string[] {
  const found: string[] = [];
  for (const segment of parseJpeg(data).segments) {
    const finding = jpegSegmentFinding(segment);
    if (finding && !found.includes(finding)) found.push(finding);
  }
  return found;
}

function stripJpeg(data: Buffer): Buffer {
  const { segments, scanStart } = parseJpeg(data);
  const kept = segments
    .filter((segment) => jpegSegmentFinding(segment) === undefined)
    .map((segment) => data.subarray(segment.start, segment.end));
  return Buffer.concat([data.subarray(0, 2), ...kept, data.subarray(scanStart)]);
}

/**
 * Every reason the file carries embedded provenance metadata. Empty means
 * clean. A PNG or JPEG that cannot be parsed is reported, since nothing can be
 * said about what it hides.
 */
export function findEmbeddedMetadata(path: string, data: Buffer): string[] {
  const format = detectFormat(path, data);
  let found: string[];
  try {
    if (format === 'png') found = pngFindings(data);
    else if (format === 'jpeg') found = jpegFindings(data);
    else if (format === 'svg') found = svgFindings(data.toString('utf8'));
    else return genericFindings(data);
  } catch (error) {
    if (error instanceof MalformedFileError) return [`not a valid ${format}: ${error.message}`];
    throw error;
  }
  // A known format with nothing in the usual places can still hide a manifest
  // somewhere else, such as a private PNG chunk.
  return found.length > 0 ? found : genericFindings(data);
}

/**
 * Returns the file with every embedded manifest and XMP packet removed.
 * Throws when the format is not supported, the file cannot be parsed, or
 * something is still found after stripping, so a caller never writes a file
 * that would still fail the check.
 */
export function stripEmbeddedMetadata(path: string, data: Buffer): Buffer {
  const format = detectFormat(path, data);
  let stripped: Buffer;
  if (format === 'png') stripped = stripPng(data);
  else if (format === 'jpeg') stripped = stripJpeg(data);
  else if (format === 'svg') stripped = Buffer.from(stripSvg(decodeUtf8(data)), 'utf8');
  else if (findEmbeddedMetadata(path, data).length === 0) return data;
  else throw new Error('only SVG, PNG and JPEG files can be stripped');
  const left = findEmbeddedMetadata(path, stripped);
  if (left.length > 0) throw new Error(`still found after stripping: ${left.join('; ')}`);
  return stripped;
}
