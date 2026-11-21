Rebased onto current `upstream/main` (`0d99261dc`): zero conflicts, head `b3c1243d0`, branch [`fix/5023-zfs-zed-pickup`](https://github.com/ggbdpq/magpie/tree/fix/5023-zfs-zed-pickup). No upstream commits on the Zed detection path in this range.

Verification on the new base:

- `TestZedRunningIgnoresTheZFSDaemon` green.
- Ablation on the new base: the editor/daemon exclusion out (`zedEditorRunning` dropped — `/usr/sbin/zed` counts as Zed again) → red; restored → green.
- Fresh patch `git am`s clean onto a tree at `0d99261dc`; sha256[:16] `91da5ac9b0b08087`. A real ZFS box stays NOT-RUNNABLE here (the process-list fixture carries both command lines).

Generated-by: GLM-5.3-Flash (ZCode)
