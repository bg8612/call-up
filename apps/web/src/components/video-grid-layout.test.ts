import { describe, expect, it } from 'vitest';
import { getVideoGridLayout } from './video-grid-layout';

describe('getVideoGridLayout', () => {
  it('returns a compact single-column layout for one participant', () => {
    expect(getVideoGridLayout(1)).toEqual({
      gridClassName: 'lg:grid-cols-1',
      isCompact: false
    });
  });

  it('returns a denser layout for four or more participants', () => {
    expect(getVideoGridLayout(4)).toEqual({
      gridClassName: 'lg:grid-cols-2 2xl:grid-cols-3',
      isCompact: true
    });
  });
});
