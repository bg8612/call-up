import { describe, expect, it } from 'vitest';
import { getVideoGridLayout } from './video-grid-layout';

describe('getVideoGridLayout', () => {
  it('returns a large single-column layout for one participant', () => {
    expect(getVideoGridLayout(1)).toEqual({
      gridClassName: 'grid-cols-1 grid-rows-1',
      tileClassName: 'h-full min-h-0 sm:aspect-[1.35/1] sm:min-h-[340px]'
    });
  });

  it('returns a balanced 2x2-like layout for four participants', () => {
    expect(getVideoGridLayout(4)).toEqual({
      gridClassName: 'grid-cols-2 grid-rows-2 sm:grid-cols-2 sm:grid-rows-2',
      tileClassName: 'h-full min-h-0 sm:aspect-square sm:min-h-[206px]'
    });
  });

  it('returns a denser multi-column layout for eight participants', () => {
    expect(getVideoGridLayout(8)).toEqual({
      gridClassName: 'grid-cols-2 grid-rows-4 sm:grid-cols-2 sm:grid-rows-4 lg:grid-cols-3 lg:grid-rows-3 xl:grid-cols-4 xl:grid-rows-2',
      tileClassName: 'h-full min-h-0 sm:aspect-square sm:min-h-[154px]'
    });
  });

  it('returns compact tiles for condensed stage mode with six participants', () => {
    expect(getVideoGridLayout(6, { condensed: true })).toEqual({
      gridClassName: 'grid-cols-2 grid-rows-3 sm:grid-cols-2 sm:grid-rows-3 lg:grid-cols-3 lg:grid-rows-2 xl:grid-cols-4 xl:grid-rows-2',
      tileClassName: 'h-full min-h-0 sm:aspect-[1.12/1] sm:min-h-[130px]'
    });
  });
});
