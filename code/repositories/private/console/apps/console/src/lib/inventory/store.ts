import { create } from "zustand";
import type { CatalogDirection, CatalogFilters, CatalogSort } from "./filter-catalog";

type CatalogFilterState = CatalogFilters & {
  setKeyword: (keyword: string) => void;
  setExcludeKeyword: (excludeKeyword: string) => void;
  setShopName: (shopName: string) => void;
  setStatus: (status: string) => void;
  setMinPrice: (minPrice: string) => void;
  setMaxPrice: (maxPrice: string) => void;
  setSort: (sort: CatalogSort) => void;
  setDirection: (direction: CatalogDirection) => void;
  setShowDuplicates: (showDuplicates: boolean) => void;
  toggleGroup: (groupId: string) => void;
  reset: () => void;
};

const initialCatalogFilters: CatalogFilters = {
  keyword: "",
  excludeKeyword: "",
  shopName: "",
  status: "active",
  minPrice: "",
  maxPrice: "",
  sort: "price",
  direction: "asc",
  showDuplicates: false,
  expandedGroups: [],
};

export const useCatalogFilter = create<CatalogFilterState>((set) => ({
  ...initialCatalogFilters,
  setKeyword: (keyword) => set({ keyword }),
  setExcludeKeyword: (excludeKeyword) => set({ excludeKeyword }),
  setShopName: (shopName) => set({ shopName }),
  setStatus: (status) => set({ status }),
  setMinPrice: (minPrice) => set({ minPrice }),
  setMaxPrice: (maxPrice) => set({ maxPrice }),
  setSort: (sort) => set({ sort }),
  setDirection: (direction) => set({ direction }),
  setShowDuplicates: (showDuplicates) => set({ showDuplicates }),
  toggleGroup: (groupId) =>
    set((state) => ({
      expandedGroups: state.expandedGroups.includes(groupId)
        ? state.expandedGroups.filter((id) => id !== groupId)
        : [...state.expandedGroups, groupId],
    })),
  reset: () => set(initialCatalogFilters),
}));

type WorkspaceFormState = {
  plan: string;
  quantity: number;
  maxUnitPriceCents: number | null;
  orderStatus: string;
  orderQuery: string;
  setPlan: (plan: string) => void;
  setQuantity: (quantity: number) => void;
  setMaxUnitPriceYuan: (value: string) => void;
  setOrderStatus: (status: string) => void;
  setOrderQuery: (query: string) => void;
};

export const useWorkspaceForm = create<WorkspaceFormState>((set) => ({
  plan: "Plus",
  quantity: 1,
  maxUnitPriceCents: 1600,
  orderStatus: "all",
  orderQuery: "",
  setPlan: (plan) => set({ plan }),
  setQuantity: (quantity) => set({ quantity: Math.max(1, Math.min(500, quantity)) }),
  setMaxUnitPriceYuan: (value) =>
    set({
      maxUnitPriceCents: value.trim() ? Math.round(Number(value) * 100) : null,
    }),
  setOrderStatus: (status) => set({ orderStatus: status }),
  setOrderQuery: (query) => set({ orderQuery: query }),
}));
