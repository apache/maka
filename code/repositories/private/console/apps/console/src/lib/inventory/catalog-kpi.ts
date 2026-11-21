type CatalogTotalState = {
  isPending: boolean;
  isError: boolean;
  totalProducts?: number;
};

export function catalogTotalLabel(state: CatalogTotalState): string {
  if (state.isError) {
    return "加载失败";
  }
  if (state.isPending || state.totalProducts === undefined) {
    return "加载中";
  }
  return String(state.totalProducts);
}
