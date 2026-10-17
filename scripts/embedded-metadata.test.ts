// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The committed fixtures are clean. Each test adds a synthesized manifest with
// placeholder content to a copy in a temporary folder, so the repository never
// holds a file that fails the check, and stripping must give back the clean
// fixture byte for byte.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import {
  C2PA_JUMBF,
  JPEG_XMP_EXTENSION_NAMESPACE,
  JPEG_XMP_NAMESPACE,
  PNG_XMP_KEYWORD,
  XMP_META_ELEMENT,
  XMP_PACKET_ID,
  XMP_PACKET_START,
  detectFormat,
  findEmbeddedMetadata,
  parseJpeg,
  parsePng,
  stripEmbeddedMetadata,
} from './embedded-metadata.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures/embedded-metadata');
const CHECK = join(import.meta.dirname, 'check-embedded-metadata.ts');
const STRIP = join(import.meta.dirname, 'strip-embedded-metadata.ts');
const CLEAN_SVG = readFileSync(join(FIXTURES, 'clean.svg'));
const CLEAN_PNG = readFileSync(join(FIXTURES, 'clean.png'));
const CLEAN_JPEG = readFileSync(join(FIXTURES, 'clean.jpg'));

const scratch = mkdtempSync(join(tmpdir(), 'embedded-metadata-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function write(name: string, data: Buffer | string): string {
  const path = join(scratch, name);
  writeFileSync(path, data);
  return path;
}

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

// ISO BMFF style box: 32 bit size, 4 character type, payload.
function box(type: string, payload: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + payload.length);
  return Buffer.concat([size, Buffer.from(type, 'latin1'), payload]);
}

// A minimal C2PA shaped JUMBF superbox: a description box carrying the c2pa
// UUID and label, then a JSON box with placeholder content.
function manifest(): Buffer {
  const uuid = Buffer.concat([
    Buffer.from('c2pa', 'latin1'),
    Buffer.from('00110010800000aa00389b71', 'hex'),
  ]);
  const description = box(
    'jumd',
    Buffer.concat([uuid, Buffer.from([0x03]), Buffer.from('c2pa\0')]),
  );
  const content = box('json', Buffer.from('{"claim":"placeholder","signer":"example"}'));
  return box('jumb', Buffer.concat([description, content]));
}

function xmpPacket(): string {
  return [
    `${XMP_PACKET_START} begin="" id="${XMP_PACKET_ID}"?>`,
    `${XMP_META_ELEMENT} xmlns:x="urn:example:meta"><rdf:RDF/></x:xmpmeta>`,
    `${XMP_PACKET_START} end="w"?>`,
  ].join('');
}

function svgWithManifest(): Buffer {
  const text = CLEAN_SVG.toString('utf8');
  const open = text.indexOf('>') + 1;
  const withAttribute = `${text.slice(0, open - 1)} xmlns:c2pa="http://c2pa.org/manifest">`;
  const block = `<metadata><c2pa:manifest>${manifest().toString('base64')}</c2pa:manifest></metadata>`;
  return Buffer.from(withAttribute + block + text.slice(open), 'utf8');
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// Inserts chunks right after IHDR, where exporters put them.
function pngWith(...chunks: Buffer[]): Buffer {
  const afterIhdr = 8 + 12 + 13;
  return Buffer.concat([
    CLEAN_PNG.subarray(0, afterIhdr),
    ...chunks,
    CLEAN_PNG.subarray(afterIhdr),
  ]);
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

// Inserts segments right after APP0, where exporters put them.
function jpegWith(...segments: Buffer[]): Buffer {
  const afterApp0 = 2 + 2 + CLEAN_JPEG.readUInt16BE(4);
  return Buffer.concat([
    CLEAN_JPEG.subarray(0, afterApp0),
    ...segments,
    CLEAN_JPEG.subarray(afterApp0),
  ]);
}

function app11(): Buffer {
  // Common identifier "JP", box instance, packet sequence, then the JUMBF box.
  return jpegSegment(
    0xeb,
    Buffer.concat([Buffer.from('JP', 'latin1'), Buffer.from([0, 1, 0, 0, 0, 1]), manifest()]),
  );
}

describe('clean fixtures', () => {
  it.each([
    ['clean.svg', CLEAN_SVG, 'svg'],
    ['clean.png', CLEAN_PNG, 'png'],
    ['clean.jpg', CLEAN_JPEG, 'jpeg'],
  ])('%s has no findings and strips to itself', (name, data, format) => {
    expect(detectFormat(name, data)).toBe(format);
    expect(findEmbeddedMetadata(name, data)).toEqual([]);
    expect(stripEmbeddedMetadata(name, data).equals(data)).toBe(true);
  });

  it('parse the PNG and JPEG fixtures into their real structure', () => {
    expect(parsePng(CLEAN_PNG).chunks.map((chunk) => chunk.type)).toEqual([
      'IHDR',
      'tEXt',
      'IDAT',
      'IEND',
    ]);
    expect(parseJpeg(CLEAN_JPEG).segments.length).toBeGreaterThan(0);
  });
});

describe('SVG', () => {
  it('reports the namespace, the metadata manifest and the c2pa element', () => {
    expect(findEmbeddedMetadata('icon.svg', svgWithManifest())).toEqual([
      'SVG declares the C2PA namespace (xmlns:c2pa)',
      'SVG <metadata> holds a C2PA or XMP manifest',
      'SVG contains a c2pa element',
    ]);
  });

  it('strips back to the clean fixture and keeps plain metadata', () => {
    const stripped = stripEmbeddedMetadata('icon.svg', svgWithManifest());
    expect(stripped.equals(CLEAN_SVG)).toBe(true);
    expect(stripped.toString('utf8')).toContain(
      '<metadata>fixture icon, plain text only</metadata>',
    );
  });

  it('reports and strips an XMP packet inside metadata', () => {
    const text = CLEAN_SVG.toString('utf8').replace(
      '<title>',
      `<metadata>${xmpPacket()}</metadata><title>`,
    );
    expect(findEmbeddedMetadata('icon.svg', Buffer.from(text))).toContain(
      'SVG <metadata> holds a C2PA or XMP manifest',
    );
    expect(stripEmbeddedMetadata('icon.svg', Buffer.from(text)).equals(CLEAN_SVG)).toBe(true);
  });

  it('reports and strips an XMP packet and a C2PA namespace under another prefix', () => {
    const text = CLEAN_SVG.toString('utf8')
      .replace('viewBox', `xmlns:p='http://c2pa.org/manifest' viewBox`)
      .replace('<title>', `${xmpPacket()}<title>`);
    expect(findEmbeddedMetadata('icon.svg', Buffer.from(text))).toEqual([
      'SVG declares the C2PA namespace (xmlns:p)',
      'SVG contains an XMP packet',
    ]);
    expect(stripEmbeddedMetadata('icon.svg', Buffer.from(text)).equals(CLEAN_SVG)).toBe(true);
  });

  it('recognises an SVG by content when the extension is missing', () => {
    expect(detectFormat('icon', Buffer.from('\uFEFF<?xml version="1.0"?>\n<!-- x --><svg/>'))).toBe(
      'svg',
    );
  });

  it('refuses to strip an SVG that is not valid UTF-8', () => {
    const data = Buffer.concat([svgWithManifest(), Buffer.from([0xc3, 0x28])]);
    expect(() => stripEmbeddedMetadata('icon.svg', data)).toThrow('SVG is not valid UTF-8');
  });
});

describe('PNG', () => {
  it('reports a caBX chunk and strips it without touching other chunks', () => {
    const dirty = pngWith(pngChunk('caBX', manifest()));
    expect(findEmbeddedMetadata('icon.png', dirty)).toEqual(['PNG caBX chunk (C2PA manifest)']);
    expect(stripEmbeddedMetadata('icon.png', dirty).equals(CLEAN_PNG)).toBe(true);
  });

  it('reports XMP in iTXt, zTXt and tEXt chunks and strips them', () => {
    const keyword = Buffer.from(`${PNG_XMP_KEYWORD}\0`, 'latin1');
    const dirty = pngWith(
      pngChunk(
        'iTXt',
        Buffer.concat([keyword, Buffer.from([0, 0, 0, 0]), Buffer.from(xmpPacket())]),
      ),
      pngChunk('zTXt', Buffer.concat([keyword, Buffer.from([0])])),
      pngChunk('tEXt', Buffer.concat([keyword, Buffer.from(xmpPacket())])),
    );
    expect(findEmbeddedMetadata('icon.png', dirty)).toEqual([
      'PNG iTXt chunk holds an XMP packet',
      'PNG zTXt chunk holds an XMP packet',
      'PNG tEXt chunk holds an XMP packet',
    ]);
    expect(stripEmbeddedMetadata('icon.png', dirty).equals(CLEAN_PNG)).toBe(true);
  });

  it('reports and drops data after IEND', () => {
    const dirty = Buffer.concat([CLEAN_PNG, Buffer.from('trailing')]);
    expect(findEmbeddedMetadata('icon.png', dirty)).toEqual(['PNG has 8 bytes after IEND']);
    expect(stripEmbeddedMetadata('icon.png', dirty).equals(CLEAN_PNG)).toBe(true);
  });

  it('falls back to a raw scan for a manifest in a private chunk, and refuses to strip it', () => {
    const dirty = pngWith(pngChunk('prVt', manifest()));
    expect(findEmbeddedMetadata('icon.png', dirty)).toEqual(['C2PA JUMBF manifest box']);
    expect(() => stripEmbeddedMetadata('icon.png', dirty)).toThrow('still found after stripping');
  });

  it.each([
    [
      'a bad CRC',
      Buffer.concat([CLEAN_PNG.subarray(0, 29), Buffer.from([0]), CLEAN_PNG.subarray(30)]),
      'bad CRC',
    ],
    ['a truncated file', CLEAN_PNG.subarray(0, 50), 'runs past the end'],
    ['no IEND', CLEAN_PNG.subarray(0, CLEAN_PNG.length - 12), 'truncated chunk'],
    [
      'a chunk before IHDR',
      Buffer.concat([CLEAN_PNG.subarray(0, 8), pngChunk('tEXt', Buffer.from('a\0b'))]),
      'first chunk is not IHDR',
    ],
    [
      'an invalid chunk type',
      Buffer.concat([CLEAN_PNG.subarray(0, 8), pngChunk('1HDR', Buffer.alloc(0))]),
      'invalid chunk type',
    ],
  ])('reports a PNG with %s as not valid and refuses to strip it', (_name, data, message) => {
    expect(findEmbeddedMetadata('icon.png', data)).toEqual([
      expect.stringContaining(`not a valid png: `),
    ]);
    expect(findEmbeddedMetadata('icon.png', data)[0]).toContain(message);
    expect(() => stripEmbeddedMetadata('icon.png', data)).toThrow(message);
  });

  it('rejects a buffer without the signature', () => {
    expect(() => parsePng(Buffer.from('not a png'))).toThrow('missing PNG signature');
  });
});

describe('JPEG', () => {
  it('reports APP11 JUMBF and APP1 XMP segments and strips them', () => {
    const dirty = jpegWith(
      app11(),
      jpegSegment(
        0xe1,
        Buffer.concat([Buffer.from(JPEG_XMP_NAMESPACE, 'latin1'), Buffer.from(xmpPacket())]),
      ),
      jpegSegment(
        0xe1,
        Buffer.concat([Buffer.from(JPEG_XMP_EXTENSION_NAMESPACE, 'latin1'), Buffer.from('x')]),
      ),
    );
    expect(findEmbeddedMetadata('photo.jpg', dirty)).toEqual([
      'JPEG APP11 JUMBF segment (C2PA manifest)',
      'JPEG APP1 segment holds an XMP packet',
    ]);
    expect(stripEmbeddedMetadata('photo.jpg', dirty).equals(CLEAN_JPEG)).toBe(true);
  });

  it('keeps fill bytes, standalone markers and unrelated APP segments', () => {
    const extra = Buffer.concat([
      Buffer.from([0xff, 0xff, 0xd0]),
      jpegSegment(0xe1, Buffer.from('Exif\0\0', 'latin1')),
      jpegSegment(0xeb, Buffer.from('unrelated', 'latin1')),
    ]);
    const data = jpegWith(extra);
    expect(findEmbeddedMetadata('photo.jpg', data)).toEqual([]);
    expect(stripEmbeddedMetadata('photo.jpg', data).equals(data)).toBe(true);
  });

  it('stops at EOI when there is no scan', () => {
    expect(parseJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9])).scanStart).toBe(2);
  });

  it.each([
    ['no SOI', Buffer.from([0xff, 0x00, 0xff]), 'missing JPEG SOI'],
    ['garbage where a marker belongs', Buffer.from([0xff, 0xd8, 0x00]), 'expected a marker'],
    [
      'a file that ends in fill bytes',
      Buffer.from([0xff, 0xd8, 0xff, 0xff]),
      'truncated before the first scan',
    ],
    ['a truncated length', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'truncated segment'],
    [
      'a length past the end',
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      'runs past the end',
    ],
  ])('rejects a JPEG with %s', (_name, data, message) => {
    expect(() => parseJpeg(data)).toThrow(message);
  });

  it('reports an unparsable JPEG as not valid', () => {
    expect(findEmbeddedMetadata('photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toEqual([
      'not a valid jpeg: truncated segment at byte 2',
    ]);
  });
});

describe('other files', () => {
  it('finds raw manifests and XMP packets in any file', () => {
    const data = Buffer.concat([Buffer.from('RIFF....WEBP'), manifest(), Buffer.from(xmpPacket())]);
    expect(findEmbeddedMetadata('image.webp', data)).toEqual([
      'C2PA JUMBF manifest box',
      'XMP packet',
    ]);
    expect(() => stripEmbeddedMetadata('image.webp', data)).toThrow('only SVG, PNG and JPEG');
  });

  it('leaves clean files alone', () => {
    const data = Buffer.from('plain text mentioning c2pa and metadata');
    expect(findEmbeddedMetadata('notes.txt', data)).toEqual([]);
    expect(stripEmbeddedMetadata('notes.txt', data)).toBe(data);
  });

  it('does not match its own needles in this repository', () => {
    expect(readFileSync(join(import.meta.dirname, 'embedded-metadata.ts'), 'latin1')).not.toContain(
      C2PA_JUMBF,
    );
  });
});

describe('command line', () => {
  it('fails on manifests naming each file, and passes after the strip script', () => {
    const svg = write('dirty.svg', svgWithManifest());
    const png = write('dirty.png', pngWith(pngChunk('caBX', manifest())));
    const jpeg = write('dirty.jpg', jpegWith(app11()));

    const before = run(CHECK, [svg, png, jpeg]);
    expect(before.status).toBe(1);
    expect(before.stderr).toContain('dirty.svg: SVG declares the C2PA namespace (xmlns:c2pa)');
    expect(before.stderr).toContain('dirty.png: PNG caBX chunk (C2PA manifest)');
    expect(before.stderr).toContain('dirty.jpg: JPEG APP11 JUMBF segment (C2PA manifest)');

    const strip = run(STRIP, [svg, png, jpeg]);
    expect(strip.status).toBe(0);
    expect(strip.stdout).toContain('dirty.png: stripped PNG caBX chunk (C2PA manifest)');

    const after = run(CHECK, [svg, png, jpeg]);
    expect(after.status).toBe(0);
    expect(after.stdout).toBe('Embedded metadata check passed: 3 files scanned.\n');
    expect(readFileSync(svg).equals(CLEAN_SVG)).toBe(true);
    expect(readFileSync(png).equals(CLEAN_PNG)).toBe(true);
    expect(readFileSync(jpeg).equals(CLEAN_JPEG)).toBe(true);

    expect(run(STRIP, [png]).stdout).toContain('dirty.png: clean');
  });

  it('strip reports files it cannot fix and leaves them unchanged', () => {
    const webp = write('dirty.webp', manifest());
    const result = run(STRIP, [webp, join(scratch, 'missing.png')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dirty.webp: only SVG, PNG and JPEG files can be stripped');
    expect(result.stderr).toContain('missing.png: ENOENT');
    expect(readFileSync(webp).equals(manifest())).toBe(true);
  });

  it('strip without arguments prints usage', () => {
    const result = run(STRIP, []);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });

  it('check reports a missing file given as an argument', () => {
    const result = run(CHECK, [join(scratch, 'missing.svg')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing.svg: no such file');
  });

  it('passes on every tracked file in the repository', () => {
    const result = run(CHECK, []);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Embedded metadata check passed: \d+ files scanned\.\n$/);
  });
});
