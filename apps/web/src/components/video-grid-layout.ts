export const getVideoGridLayout = (count: number) => {
  if (count <= 1) {
    return {
      gridClassName: 'lg:grid-cols-1',
      isCompact: false
    };
  }

  if (count <= 3) {
    return {
      gridClassName: 'lg:grid-cols-2',
      isCompact: false
    };
  }

  return {
    gridClassName: 'lg:grid-cols-2 2xl:grid-cols-3',
    isCompact: true
  };
};
