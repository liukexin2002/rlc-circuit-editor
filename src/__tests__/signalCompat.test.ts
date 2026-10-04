import { describe, it, expect } from 'vitest';
import { areSignalPairsCompatible } from '../connectorTypes';

describe('areSignalPairsCompatible', () => {
  it('accepts SLink with each protocol it auto-senses, in either order', () => {
    for (const other of ['dsnake', 'dx5', 'gigaace'] as const) {
      expect(areSignalPairsCompatible('slink', other)).toBe(true);
      expect(areSignalPairsCompatible(other, 'slink')).toBe(true);
    }
  });

  it('rejects SLink against unrelated signals', () => {
    expect(areSignalPairsCompatible('slink', 'dante')).toBe(false);
    expect(areSignalPairsCompatible('slink', 'aes50')).toBe(false);
  });

  it('does not chain non-SLink protocols to each other', () => {
    expect(areSignalPairsCompatible('dsnake', 'gigaace')).toBe(false);
    expect(areSignalPairsCompatible('dsnake', 'dx5')).toBe(false);
  });

  it('is not a general escape hatch for equal or arbitrary signals', () => {
    expect(areSignalPairsCompatible('dante', 'aes67')).toBe(false);
    expect(areSignalPairsCompatible('hdmi', 'sdi')).toBe(false);
  });
});
