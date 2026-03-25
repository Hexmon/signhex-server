import { describe, it, expect } from 'vitest';
import {
  buildObjectKey,
  MAX_ORIGINAL_FILENAME_LENGTH,
  normalizeOriginalFilename,
  sanitizeFilenameHint,
} from './object-key';

describe('object key utilities', () => {
  it('normalizes path traversal in original filenames', () => {
    expect(normalizeOriginalFilename('../evil.png')).toBe('evil.png');
  });

  it('keeps a safe display name for Unicode filenames', () => {
    expect(normalizeOriginalFilename('Résumé 2026#.pdf')).toBe('Résumé 2026#.pdf');
  });

  it('sanitizes hints and preserves extensions', () => {
    const { hint, ext } = sanitizeFilenameHint('my file.pdf');
    expect(hint).toBe('my-file');
    expect(ext).toBe('pdf');
  });

  it('sanitizes Unicode and emoji into safe hints', () => {
    const resume = sanitizeFilenameHint('Résumé 2026#.pdf');
    expect(resume.hint).toBe('resume-2026');
    expect(resume.ext).toBe('pdf');

    const camera = sanitizeFilenameHint('📷 photo.png');
    expect(camera.hint).toBe('photo');
    expect(camera.ext).toBe('png');
  });

  it('builds stable object keys with date prefix and uuid', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const now = new Date('2026-01-13T12:00:00Z');
    const result = buildObjectKey({
      originalFilename: 'my file.pdf',
      mimeType: 'application/pdf',
      id,
      now,
    });
    expect(result.objectKey).toBe(`uploads/2026/01/13/${id}_my-file.pdf`);
  });

  it('infers extension from mime type when missing', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const now = new Date('2026-01-13T12:00:00Z');
    const result = buildObjectKey({
      originalFilename: 'file',
      mimeType: 'image/png',
      id,
      now,
    });
    expect(result.objectKey.endsWith('.png')).toBe(true);
  });

  it('falls back to .bin when extension is unsafe or unknown', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const now = new Date('2026-01-13T12:00:00Z');
    const result = buildObjectKey({
      originalFilename: 'file',
      mimeType: 'application/unknown',
      id,
      now,
    });
    expect(result.objectKey.endsWith('.bin')).toBe(true);
  });

  it('truncates overly long original filenames safely', () => {
    const longBase = 'a'.repeat(MAX_ORIGINAL_FILENAME_LENGTH + 20);
    const normalized = normalizeOriginalFilename(`${longBase}.png`);
    expect(normalized.length).toBeLessThanOrEqual(MAX_ORIGINAL_FILENAME_LENGTH);
    expect(normalized.endsWith('.png')).toBe(true);
  });
});
