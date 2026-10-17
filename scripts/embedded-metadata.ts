// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Exported design files can carry a signed provenance manifest (C2PA, stored as
// a JUMBF box) or an XMP packet. Neither shows up in a text diff and both can
// name the program that produced the file. This module finds them in SVG, PNG
// and JPEG files and removes them without touching anything that renders:
// PNG chunks and JPEG segments that are kept are copied byte for byte, nothing
// is decoded, recompressed or recomputed.
//
// Anything that cannot be decoded is reported rather than skipped, since
// nothing can be said about what it hides. Every scan is linear in the size of
// the file, so a crafted file cannot stall the check.

import { extname } from 'node:path';
import { crc32, inflateSync } from 'node:zlib';

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

const C2PA_REASON = 'C2PA JUMBF manifest box';
const BASE64_C2PA_REASON = 'base64 encoded C2PA JUMBF manifest box';
const XMP_REASON = 'XMP packet';

/**
 * The base64 text that encodes the C2PA description box at each of the three
 * byte alignments, keeping only the characters that do not depend on the
 * bytes around it.
 */
export function c2paJumbfBase64Needles(): string[] {
  const needle = Buffer.from(C2PA_JUMBF, 'latin1');
  return [0, 1, 2].map((offset) => {
    const encoded = Buffer.concat([Buffer.alloc(offset), needle]).toString('base64');
    const whole = Math.floor((offset + needle.length) / 3) * 4;
    const skip = [0, 2, 3][offset] ?? 0;
    return encoded.slice(skip, whole);
  });
}

const BASE64_NEEDLES = c2paJumbfBase64Needles();

const GENERIC_NEEDLES: readonly [string, string][] = [
  [C2PA_JUMBF, C2PA_REASON],
  [XMP_PACKET_START, XMP_REASON],
  [XMP_META_ELEMENT, XMP_REASON],
  [XMP_PACKET_ID, XMP_REASON],
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_MAX_CHUNK_LENGTH = 0x7fffffff;
// Compressed text chunks are inflated up to this size; anything larger is
// reported instead of read, so a small chunk cannot exhaust memory.
const PNG_MAX_INFLATED = 16 * 1024 * 1024;
const PNG_EXTENSIONS = new Set(['.png']);

const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
const JPEG_APP1 = 0xe1;
const JPEG_APP11 = 0xeb;
// JPEG markers that stand alone, without a length field.
const JPEG_STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg', '.jpe', '.jfif']);
// The JPEG XT common identifier that starts every APP11 JUMBF segment.
const JPEG_JUMBF_ID = 'JP';

// Text inside SVG <metadata> that means it holds a manifest or XMP rather than
// a plain description.
const SVG_MANIFEST_CONTENT = /c2pa|xmpmeta|xpacket|rdf:RDF/i;
// One leading whitespace character only, so a long run of whitespace is not
// rescanned from every position. `[^"<]` and `[^'<]` stop an unclosed value at
// the next tag.
const SVG_NAMESPACE_DECLARATION = /\sxmlns(?::([\w.-]+))?\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/gi;
const SVG_C2PA_OPEN_TAG = /<c2pa:/i;
const SVG_SNIFF = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg\b/i;

export class MalformedFileError extends Error {
  override name = 'MalformedFileError';
}

// Fatal decoding, so an SVG in UTF-16 or any other encoding is reported
// rather than read with replacement characters that hide what it holds.
function decodeUtf8(data: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new MalformedFileError('SVG is not valid UTF-8');
  }
}

function looksLikeSvg(data: Buffer): boolean {
  const head = data.subarray(0, 4096);
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) {
    const label = head[0] === 0xff ? 'utf-16le' : 'utf-16be';
    return SVG_SNIFF.test(new TextDecoder(label).decode(head.subarray(2)));
  }
  return SVG_SNIFF.test(head.toString('utf8').replace(/^\uFEFF/, ''));
}

/**
 * The format a file claims to be. Magic bytes win, then the extension, so a
 * `.png` or `.jpg` file that does not start like one is parsed as that format
 * and reported as not valid rather than passed as unknown bytes.
 */
export function detectFormat(path: string, data: Buffer): Format {
  if (data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'png';
  if (data[0] === 0xff && data[1] === JPEG_SOI && data[2] === 0xff) return 'jpeg';
  const extension = extname(path).toLowerCase();
  if (PNG_EXTENSIONS.has(extension)) return 'png';
  if (JPEG_EXTENSIONS.has(extension)) return 'jpeg';
  if (extension === '.svg' || looksLikeSvg(data)) return 'svg';
  return 'other';
}

function genericFindings(data: Buffer): string[] {
  const found: string[] = [];
  for (const [needle, reason] of GENERIC_NEEDLES) {
    if (data.includes(needle, 0, 'latin1') && !found.includes(reason)) found.push(reason);
  }
  // Base64 may be wrapped over lines, so whitespace is dropped first.
  const compact = data.toString('latin1').replace(/\s+/g, '');
  if (BASE64_NEEDLES.some((needle) => compact.includes(needle))) found.push(BASE64_C2PA_REASON);
  return found;
}

function hasBase64Manifest(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  return BASE64_NEEDLES.some((needle) => compact.includes(needle));
}

function decodeCharacterReferences(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (reference, code: string) => {
    const point =
      code.startsWith('x') || code.startsWith('X')
        ? parseInt(code.slice(1), 16)
        : parseInt(code, 10);
    return point <= 0x10ffff ? String.fromCodePoint(point) : reference;
  });
}

function isC2paNamespace(prefix: string | undefined, uri: string): boolean {
  return prefix?.toLowerCase() === 'c2pa' || /c2pa/i.test(decodeCharacterReferences(uri));
}

interface Block {
  start: number;
  end: number;
  content: string;
}

interface Blocks {
  blocks: Block[];
  // The name of an element opened and never closed, if any.
  unclosed: string | undefined;
}

/**
 * Finds non-overlapping blocks that start at `open` and end at the first
 * `close` after them. Matching resumes after each block and stops at the
 * first open without a close, so every character is scanned a bounded number
 * of times however the input is built. `close` receives the open match so it
 * can require the same element name.
 */
function findBlocks(
  text: string,
  open: RegExp,
  close: (opened: RegExpExecArray) => RegExp,
  selfClosing: (opened: RegExpExecArray) => boolean = () => false,
): Blocks {
  const blocks: Block[] = [];
  open.lastIndex = 0;
  for (;;) {
    const opened = open.exec(text);
    if (!opened) return { blocks, unclosed: undefined };
    if (selfClosing(opened)) {
      blocks.push({ start: opened.index, end: open.lastIndex, content: '' });
      continue;
    }
    const closer = close(opened);
    closer.lastIndex = open.lastIndex;
    const closed = closer.exec(text);
    if (!closed) return { blocks, unclosed: opened[1] ?? opened[0] };
    blocks.push({
      start: opened.index,
      end: closer.lastIndex,
      content: text.slice(open.lastIndex, closed.index),
    });
    open.lastIndex = closer.lastIndex;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `[^<>]*` keeps an unclosed tag from scanning past the next tag.
function elementBlocks(text: string, name: string): Blocks {
  return findBlocks(
    text,
    new RegExp(`<(${name})(?=[\\s/>])[^<>]*>`, 'gi'),
    (opened) => new RegExp(`</${escapeRegExp(opened[1] ?? '')}\\s*>`, 'gi'),
    (opened) => opened[0].endsWith('/>'),
  );
}

function metadataBlocks(text: string): Blocks {
  const found = elementBlocks(text, '(?:[\\w.-]+:)?metadata');
  return {
    blocks: found.blocks.filter(
      (block) => SVG_MANIFEST_CONTENT.test(block.content) || hasBase64Manifest(block.content),
    ),
    unclosed: found.unclosed,
  };
}

function c2paBlocks(text: string): Blocks {
  return elementBlocks(text, 'c2pa:[\\w.-]+');
}

function xmpBlocks(text: string): Blocks {
  const packets = findBlocks(text, /<\?(xpacket)\s+begin\b/g, () => /<\?xpacket\s+end[^<>]*>/g);
  const elements = elementBlocks(text, '(?:[\\w.-]+:)?xmpmeta');
  return {
    blocks: [...packets.blocks, ...elements.blocks],
    unclosed: packets.unclosed ?? elements.unclosed,
  };
}

function svgFindings(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(SVG_NAMESPACE_DECLARATION)) {
    const prefix = match[1];
    if (isC2paNamespace(prefix, match[2] ?? match[3] ?? '')) {
      found.push(`SVG declares the C2PA namespace (xmlns${prefix ? `:${prefix}` : ''})`);
    }
  }
  const metadata = metadataBlocks(text);
  const xmp = xmpBlocks(text);
  if (metadata.blocks.length > 0) found.push('SVG <metadata> holds a C2PA or XMP manifest');
  if (SVG_C2PA_OPEN_TAG.test(text)) found.push('SVG contains a c2pa element');
  if (xmp.blocks.length > 0) found.push('SVG contains an XMP packet');
  if (hasBase64Manifest(text)) found.push(`SVG holds a ${BASE64_C2PA_REASON}`);
  // Content after an unclosed element cannot be told apart from the element,
  // so it is reported rather than guessed at.
  for (const unclosed of [metadata.unclosed, c2paBlocks(text).unclosed, xmp.unclosed]) {
    if (unclosed !== undefined) found.push(`SVG has an unclosed ${unclosed} element`);
  }
  return [...new Set(found)];
}

// Removes blocks found by `find`, which must return non-overlapping blocks.
function removeBlocks(text: string, find: (text: string) => Blocks): string {
  const blocks = find(text).blocks.sort((a, b) => a.start - b.start);
  let result = '';
  let at = 0;
  for (const block of blocks) {
    if (block.start < at) continue;
    result += text.slice(at, block.start);
    at = block.end;
  }
  return result + text.slice(at);
}

function stripSvg(text: string): string {
  let result = removeBlocks(text, metadataBlocks);
  result = removeBlocks(result, c2paBlocks);
  result = removeBlocks(result, xmpBlocks);
  return result.replace(
    SVG_NAMESPACE_DECLARATION,
    (
      declaration,
      prefix: string | undefined,
      double: string | undefined,
      single: string | undefined,
    ) => (isC2paNamespace(prefix, double ?? single ?? '') ? '' : declaration),
  );
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

function inflateText(chunk: PngChunk, compressed: Buffer): Buffer {
  try {
    return inflateSync(compressed, { maxOutputLength: PNG_MAX_INFLATED });
  } catch {
    throw new MalformedFileError(
      `${chunk.type} chunk at byte ${String(chunk.start)} does not inflate within ${String(PNG_MAX_INFLATED)} bytes`,
    );
  }
}

interface PngText {
  keyword: string;
  text: Buffer;
}

// The keyword and the text of a tEXt, zTXt or iTXt chunk, inflated when it is
// compressed. Undefined for any other chunk.
function pngText(chunk: PngChunk): PngText | undefined {
  if (chunk.type !== 'tEXt' && chunk.type !== 'zTXt' && chunk.type !== 'iTXt') return undefined;
  const at = `${chunk.type} chunk at byte ${String(chunk.start)}`;
  const nul = chunk.data.indexOf(0);
  if (nul === -1) throw new MalformedFileError(`${at} has no end to its keyword`);
  const keyword = chunk.data.toString('latin1', 0, nul);
  const rest = chunk.data.subarray(nul + 1);
  if (chunk.type === 'tEXt') return { keyword, text: rest };
  if (chunk.type === 'zTXt') {
    if (rest[0] !== 0) throw new MalformedFileError(`${at} has an unknown compression method`);
    return { keyword, text: inflateText(chunk, rest.subarray(1)) };
  }
  // iTXt: compression flag, method, language tag, translated keyword, text.
  const language = rest.indexOf(0, 2);
  const translated = language === -1 ? -1 : rest.indexOf(0, language + 1);
  if (rest.length < 2 || translated === -1) throw new MalformedFileError(`${at} is cut short`);
  const text = rest.subarray(translated + 1);
  if (rest[0] === 0) return { keyword, text };
  if (rest[1] !== 0) throw new MalformedFileError(`${at} has an unknown compression method`);
  return { keyword, text: inflateText(chunk, text) };
}

// Some converters store profiles as `Raw profile type <name>` text: a name
// line, a length line, then the profile in hex.
function decodeRawProfile(keyword: string, text: Buffer): Buffer | undefined {
  if (!/^Raw profile type /i.test(keyword)) return undefined;
  const match = /^\s*\S+\s*\n\s*\d+\s*\n([0-9a-f\s]*)$/i.exec(text.toString('latin1'));
  if (!match) return undefined;
  const hex = (match[1] ?? '').replace(/\s+/g, '');
  return hex.length % 2 === 0 ? Buffer.from(hex, 'hex') : undefined;
}

// Why a PNG chunk must go, or undefined when it is kept.
function pngChunkFinding(chunk: PngChunk): string | undefined {
  if (chunk.type.toLowerCase() === 'cabx') return `PNG ${chunk.type} chunk (C2PA manifest)`;
  const text = pngText(chunk);
  if (!text) return undefined;
  if (text.keyword === PNG_XMP_KEYWORD) return `PNG ${chunk.type} chunk holds an XMP packet`;
  const decoded = decodeRawProfile(text.keyword, text.text);
  const reasons = [...genericFindings(text.text), ...(decoded ? genericFindings(decoded) : [])];
  if (reasons.includes(XMP_REASON)) return `PNG ${chunk.type} chunk holds an XMP packet`;
  if (reasons.length > 0) return `PNG ${chunk.type} chunk holds a C2PA manifest`;
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

interface JpegPiece {
  // The marker, or undefined for entropy coded scan data.
  marker: number | undefined;
  start: number;
  end: number;
  payload: Buffer;
}

interface ParsedJpeg {
  // Every marker segment and every run of scan data after SOI, in order.
  pieces: JpegPiece[];
  // Offset just past EOI; anything after it is trailing data.
  end: number;
}

// Offset of the marker that ends the scan data starting at `from`. Inside a
// scan, 0xFF is followed by a stuffed 0x00 or a restart marker; anything else
// is the next marker.
function scanEnd(data: Buffer, from: number): number {
  let at = from;
  for (;;) {
    const ff = data.indexOf(0xff, at);
    if (ff === -1 || ff + 1 >= data.length) throw new MalformedFileError('no EOI after the scan');
    const next = data[ff + 1] ?? 0;
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
      at = ff + 2;
      continue;
    }
    return ff;
  }
}

/**
 * Walks every segment of a JPEG, including the ones between progressive
 * scans, through to EOI.
 */
export function parseJpeg(data: Buffer): ParsedJpeg {
  if (data[0] !== 0xff || data[1] !== JPEG_SOI) throw new MalformedFileError('missing JPEG SOI');
  const pieces: JpegPiece[] = [];
  let offset = 2;
  for (;;) {
    if (offset >= data.length) throw new MalformedFileError('truncated before EOI');
    if (data[offset] !== 0xff) {
      throw new MalformedFileError(`expected a marker at byte ${String(offset)}`);
    }
    let markerAt = offset;
    // Any number of 0xFF fill bytes may precede a marker.
    while (data[markerAt + 1] === 0xff) markerAt += 1;
    const marker = data[markerAt + 1];
    if (marker === undefined) throw new MalformedFileError('truncated before EOI');
    if (marker === JPEG_EOI) {
      pieces.push({ marker, start: offset, end: markerAt + 2, payload: Buffer.alloc(0) });
      return { pieces, end: markerAt + 2 };
    }
    if (JPEG_STANDALONE.has(marker)) {
      pieces.push({ marker, start: offset, end: markerAt + 2, payload: Buffer.alloc(0) });
      offset = markerAt + 2;
      continue;
    }
    if (markerAt + 4 > data.length) {
      throw new MalformedFileError(`truncated segment at byte ${String(offset)}`);
    }
    const length = data.readUInt16BE(markerAt + 2);
    if (length < 2) {
      throw new MalformedFileError(`segment at byte ${String(offset)} has a length below 2`);
    }
    const end = markerAt + 2 + length;
    if (end > data.length) {
      throw new MalformedFileError(`segment at byte ${String(offset)} runs past the end`);
    }
    pieces.push({ marker, start: offset, end, payload: data.subarray(markerAt + 4, end) });
    offset = end;
    if (marker === JPEG_SOS) {
      const stop = scanEnd(data, end);
      pieces.push({ marker: undefined, start: end, end: stop, payload: data.subarray(end, stop) });
      offset = stop;
    }
  }
}

function startsWith(payload: Buffer, prefix: string): boolean {
  return payload.subarray(0, prefix.length).equals(Buffer.from(prefix, 'latin1'));
}

// Box instance number of an APP11 JUMBF segment, which ties the segments of one
// box together. Only the first segment of a box carries its description box.
function jumbfInstance(piece: JpegPiece): number | undefined {
  if (piece.marker !== JPEG_APP11 || piece.payload.length < 4) return undefined;
  if (!startsWith(piece.payload, JPEG_JUMBF_ID)) return undefined;
  return piece.payload.readUInt16BE(2);
}

// Why each JPEG piece must go, or undefined when it is kept. APP11 segments
// are dropped only when their box is a C2PA manifest, since other JPEG XT
// boxes in APP11 carry image data that renders.
function jpegPieceFindings(pieces: JpegPiece[]): (string | undefined)[] {
  const manifests = new Set<number>();
  for (const piece of pieces) {
    const instance = jumbfInstance(piece);
    if (instance !== undefined && piece.payload.includes(C2PA_JUMBF, 0, 'latin1')) {
      manifests.add(instance);
    }
  }
  return pieces.map((piece) => {
    if (piece.marker === JPEG_APP11) {
      const instance = jumbfInstance(piece);
      const c2pa =
        instance === undefined
          ? piece.payload.includes(C2PA_JUMBF, 0, 'latin1')
          : manifests.has(instance);
      return c2pa ? 'JPEG APP11 JUMBF segment (C2PA manifest)' : undefined;
    }
    if (
      piece.marker === JPEG_APP1 &&
      (startsWith(piece.payload, JPEG_XMP_NAMESPACE) ||
        startsWith(piece.payload, JPEG_XMP_EXTENSION_NAMESPACE))
    ) {
      return 'JPEG APP1 segment holds an XMP packet';
    }
    return undefined;
  });
}

function jpegFindings(data: Buffer): string[] {
  const { pieces, end } = parseJpeg(data);
  const found: string[] = [];
  for (const finding of jpegPieceFindings(pieces)) {
    if (finding && !found.includes(finding)) found.push(finding);
  }
  if (end < data.length) found.push(`JPEG has ${String(data.length - end)} bytes after EOI`);
  return found;
}

function stripJpeg(data: Buffer): Buffer {
  const { pieces } = parseJpeg(data);
  const findings = jpegPieceFindings(pieces);
  const kept = pieces
    .filter((_piece, index) => findings[index] === undefined)
    .map((piece) => data.subarray(piece.start, piece.end));
  return Buffer.concat([data.subarray(0, 2), ...kept]);
}

/**
 * Every reason the file carries embedded provenance metadata. Empty means
 * clean. A file that cannot be parsed as the format it claims is reported.
 */
export function findEmbeddedMetadata(path: string, data: Buffer): string[] {
  const format = detectFormat(path, data);
  let found: string[];
  try {
    if (format === 'png') found = pngFindings(data);
    else if (format === 'jpeg') found = jpegFindings(data);
    else if (format === 'svg') found = svgFindings(decodeUtf8(data));
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

// C0 and C1 control characters, plus the quote and backslash used to escape.
function isUnsafeInName(character: string): boolean {
  const point = character.codePointAt(0) ?? 0;
  return (
    point < 0x20 || (point >= 0x7f && point <= 0x9f) || character === '"' || character === '\\'
  );
}

/**
 * A file name safe to print in a log. Names that are valid UTF-8 without
 * control characters are shown as they are; anything else is quoted with
 * every unsafe byte escaped, so a name cannot start a new log line or forge a
 * CI workflow command.
 */
export function showPath(name: Buffer): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(name);
    if (!Array.from(text).some(isUnsafeInName)) return text;
  } catch {
    // Not UTF-8: escaped below.
  }
  let shown = '';
  for (const byte of name) {
    const safe = byte >= 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c;
    shown += safe ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return `"${shown}"`;
}
