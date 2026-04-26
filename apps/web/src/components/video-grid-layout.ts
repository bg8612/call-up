type VideoGridLayoutOptions = {
  condensed?: boolean;
};

export const getVideoGridLayout = (count: number, options: VideoGridLayoutOptions = {}) => {
  if (options.condensed) {
    if (count <= 2) {
      return {
        gridClassName: 'grid-cols-2 sm:grid-cols-2',
        tileClassName: 'h-full min-h-0 sm:aspect-[1.25/1] sm:min-h-[150px]'
      };
    }

    if (count <= 3) {
      return {
        gridClassName: 'grid-cols-2 grid-rows-2 sm:grid-cols-2 sm:grid-rows-2 lg:grid-cols-3 lg:grid-rows-1',
        tileClassName: 'h-full min-h-0 sm:aspect-[1.16/1] sm:min-h-[136px]'
      };
    }

    if (count <= 6) {
      return {
        gridClassName: 'grid-cols-2 grid-rows-3 sm:grid-cols-2 sm:grid-rows-3 lg:grid-cols-3 lg:grid-rows-2 xl:grid-cols-4 xl:grid-rows-2',
        tileClassName: 'h-full min-h-0 sm:aspect-[1.12/1] sm:min-h-[130px]'
      };
    }

    if (count <= 8) {
      return {
        gridClassName: 'grid-cols-2 grid-rows-4 sm:grid-cols-2 sm:grid-rows-4 lg:grid-cols-3 lg:grid-rows-3 xl:grid-cols-4 xl:grid-rows-2',
        tileClassName: 'h-full min-h-0 sm:aspect-[1.05/1] sm:min-h-[116px]'
      };
    }

    return {
      gridClassName: 'grid-cols-2 grid-rows-4 sm:grid-cols-2 sm:grid-rows-4 lg:grid-cols-3 lg:grid-rows-3 xl:grid-cols-4 xl:grid-rows-3 2xl:grid-cols-5 2xl:grid-rows-2',
      tileClassName: 'h-full min-h-0 sm:aspect-square sm:min-h-[108px]'
    };
  }

  if (count <= 1) {
    return {
      gridClassName: 'grid-cols-1 grid-rows-1',
      tileClassName: 'h-full min-h-0 sm:aspect-[1.35/1] sm:min-h-[340px]'
    };
  }

  if (count === 2) {
    return {
      gridClassName: 'grid-cols-1 grid-rows-2 sm:grid-cols-2 sm:grid-rows-1',
      tileClassName: 'h-full min-h-0 sm:aspect-[1.18/1] sm:min-h-[250px]'
    };
  }

  if (count === 3) {
    return {
      gridClassName: 'grid-cols-2 grid-rows-2 sm:grid-cols-2 sm:grid-rows-2 xl:grid-cols-3 xl:grid-rows-1',
      tileClassName: 'h-full min-h-0 sm:aspect-[1.05/1] sm:min-h-[210px]'
    };
  }

  if (count === 4) {
    return {
      gridClassName: 'grid-cols-2 grid-rows-2 sm:grid-cols-2 sm:grid-rows-2',
      tileClassName: 'h-full min-h-0 sm:aspect-square sm:min-h-[206px]'
    };
  }

  if (count <= 6) {
    return {
      gridClassName: 'grid-cols-2 grid-rows-3 sm:grid-cols-2 sm:grid-rows-3 lg:grid-cols-3 lg:grid-rows-2',
      tileClassName: 'h-full min-h-0 sm:aspect-[1.04/1] sm:min-h-[174px]'
    };
  }

  if (count <= 8) {
    return {
      gridClassName: 'grid-cols-2 grid-rows-4 sm:grid-cols-2 sm:grid-rows-4 lg:grid-cols-3 lg:grid-rows-3 xl:grid-cols-4 xl:grid-rows-2',
      tileClassName: 'h-full min-h-0 sm:aspect-square sm:min-h-[154px]'
    };
  }

  return {
    gridClassName: 'grid-cols-2 grid-rows-4 sm:grid-cols-2 sm:grid-rows-4 lg:grid-cols-3 lg:grid-rows-3 xl:grid-cols-4 xl:grid-rows-3 2xl:grid-cols-5 2xl:grid-rows-2',
    tileClassName: 'h-full min-h-0 sm:aspect-square sm:min-h-[140px]'
  };
};
