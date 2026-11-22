// The page's host of the tests: answers `echo` with its argument, throws
// for `fail`, returns what is not JSON for `big`, never answers `slow`,
// answers `later` after 500 ms of its timers, and sends two events before
// the app starts.
export function createHost(player) {
  player.hostEvent("tick", 1);
  player.hostEvent("tick", 2);
  return {
    async call(name, args) {
      if (name === "note") player.hostEvent("noted", args);
      if (name === "fail") throw new Error("boom");
      if (name === "big") return 1n;
      if (name === "slow") return new Promise(() => {});
      if (name === "later") return new Promise((resolve) => setTimeout(() => resolve("late"), 500));
      return args;
    },
  };
}
