// The web host of examples/host-echo (nsh.json `web.host`): answers
// `host.call("echo", args)` with its argument, answers `host.post("note",
// args)` with the event `noted`, and sends `tick` at once (it reaches the
// app when it starts) and then every second.
export async function createHost(player) {
  player.hostEvent("tick", {});
  setInterval(() => player.hostEvent("tick", {}), 1000);
  return {
    call(name, args) {
      if (name === "echo") return args;
      throw new Error(`no host function ${name}`);
    },
    post(name, args) {
      if (name === "note") player.hostEvent("noted", args);
    },
  };
}
