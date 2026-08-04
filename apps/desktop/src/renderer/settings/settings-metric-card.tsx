import { StatTile } from '@maka/ui';

/** Thin alias over the shared StatTile (convergence R4) — usage/bot call
 *  sites keep their name; the recipe lives in the primitive. */
export function MetricCard(props: { title: string; value: string; detail?: string }) {
  return (
    /* Detail audit: was emphasis="filled" — gray-plate tiles while the
       Permission/Health summaries use the outlined StatTile. One tile
       language across every settings summary strip. */
    <StatTile
      className="settingsMetricCard"
      label={props.title}
      value={props.value}
      detail={props.detail}
    />
  );
}

// Segmented controls are owned directly by Astryx.
// (the retired local segmented-control implementation). PR yuejing/settings-segmented-primitive
// (WAWQAQ msg `f1461d30` 用库的应该用库).

/**
 * PR-USE-SHADCN-BASE-UI-BADGE — map the project's status-tone vocabulary
 * (success / warning / destructive / info / neutral) onto the canonical
 * shadcn `PrimitiveBadge` variants. `neutral` falls back to `secondary`
 * which is the closest "muted chip" appearance the Badge primitive ships.
 */
