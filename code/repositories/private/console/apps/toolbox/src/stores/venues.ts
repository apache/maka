import { create } from "zustand";
import {
  favoriteResponseSchema,
  venueListResponseSchema,
  type Venue,
  type VenueCategory,
} from "@/schemas/venue";

interface VenuesState {
  venues: Venue[];
  total: number;
  loading: boolean;
  category?: VenueCategory;
  scene?: string;
  onlyFavorite: boolean;
  setCategory: (category?: VenueCategory) => void;
  setScene: (scene?: string) => void;
  toggleOnlyFavorite: () => void;
  fetchVenues: () => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
}

export const useVenuesStore = create<VenuesState>((set, get) => ({
  venues: [],
  total: 0,
  loading: false,
  category: undefined,
  scene: undefined,
  onlyFavorite: false,

  setCategory: (category) => {
    set({ category });
    void get().fetchVenues();
  },
  setScene: (scene) => {
    set({ scene });
    void get().fetchVenues();
  },
  toggleOnlyFavorite: () => {
    set({ onlyFavorite: !get().onlyFavorite });
    void get().fetchVenues();
  },

  fetchVenues: async () => {
    set({ loading: true });
    const { category, scene, onlyFavorite } = get();
    const sp = new URLSearchParams();
    if (category) sp.set("category", category);
    if (scene) sp.set("scene", scene);
    if (onlyFavorite) sp.set("favorite", "1");
    const res = await fetch(`/api/venues?${sp.toString()}`);
    if (!res.ok) {
      set({ loading: false });
      return;
    }
    const data = venueListResponseSchema.parse(await res.json());
    set({ venues: data.items, total: data.total, loading: false });
  },

  toggleFavorite: async (id) => {
    const res = await fetch(`/api/venues/${id}/favorite`, { method: "POST" });
    if (!res.ok) return;
    const data = favoriteResponseSchema.parse(await res.json());
    set((state) => ({
      venues: state.venues.map((v) => (v.id === data.id ? { ...v, favorite: data.favorite } : v)),
    }));
  },
}));
