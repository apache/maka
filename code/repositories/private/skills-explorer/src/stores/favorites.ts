import { ref } from "vue";
import { defineStore } from "pinia";

const KEY = "skills-explorer:favorites";

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export const useFavoritesStore = defineStore("favorites", () => {
  const ids = ref(load());

  function persist() {
    localStorage.setItem(KEY, JSON.stringify([...ids.value]));
  }

  function toggle(id: string) {
    const next = new Set(ids.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    ids.value = next;
    persist();
  }

  function has(id: string) {
    return ids.value.has(id);
  }

  return { ids, toggle, has };
});
