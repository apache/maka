<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Connect to a remote Runtime Host

[简体中文](./runtime-host-remote-access.zh-CN.md)

Maka Desktop, TUI, and CLI can connect to a Runtime Host through TLS, SSH, or explicitly enabled plaintext WebSocket.

## Set up a Linux Host

On a Linux machine with Node.js 22.19 or newer and a working systemd user manager, the released CLI
can install and verify a persistent Runtime Host in one command:

```sh
npx --yes --package maka-agent@next maka runtime-host setup \
  --principal my-desktop \
  --preset desktop-client \
  --root /srv/maka \
  --project-root projects=/srv/projects
```

Use a stable identifier for `--principal`; rerunning the command replaces that Client's credential
instead of accumulating credentials. The command installs its exact Maka package into a managed
directory, starts a loopback-only service, verifies the new credential, and then prints the connection
details once. Use `terminal-client` for TUI or CLI.

Run `npx --yes --package maka-agent@next maka runtime-host service uninstall` on the Host to remove the service and
managed package. The State Root and Project data are retained.

## Manual Host setup

Build Maka on the remote machine, choose a persistent State Root, and register each Project remote Clients may use:

```sh
npm run build
npm --workspace maka-agent exec -- maka runtime-host project add /srv/projects/example --root /srv/maka
npm --workspace maka-agent exec -- maka runtime-host project list --root /srv/maka
```

The Desktop directory picker publishes the service user's home directory by default. To publish a different allowlist, pass one or more named roots when starting the service:

```sh
npm --workspace maka-agent exec -- maka runtime-host serve \
  --root /srv/maka \
  --project-root projects=/srv/projects \
  --project-root data=/mnt/data \
  --websocket-port 7443
```

When any `--project-root <label>=<absolute-path>` option is present, only those roots are available to remote directory browsing. The option is repeatable up to eight times. Maka resolves every root at startup and keeps browsing and registration contained within the selected root.

Project paths stay on the Host. Issue a credential for each Client:

```sh
npm --workspace maka-agent exec -- maka runtime-host access issue \
  --root /srv/maka \
  --principal my-desktop \
  --preset desktop-client
```

Use `terminal-client` for TUI or CLI. The command prints the credential once.

On Linux with a systemd user manager, a persistent CLI installation can keep the loopback Host running after the
SSH session ends:

```sh
maka runtime-host service install \
  --root /srv/maka \
  --project-root projects=/srv/projects
maka runtime-host service status --json
```

The install command persists the current exact Node and Maka CLI paths. Re-running it updates the
same systemd-supervised service; repeated startup failures stop automatic restarts and remain visible
in `maka runtime-host service status`. An omitted WebSocket port preserves the existing port. Before uninstalling the npm
package, remove the service with `maka runtime-host service uninstall`. Service uninstall keeps the
State Root and Project data. Installation reports an actionable error instead of claiming persistence
when systemd user lingering is disabled. Run service installation from a persistent global Maka
installation, not `npx`. A replacement is committed only after the new Runtime Host is ready; failure
restores the previous service.

## Choose a connection method

### Direct TLS

Use TLS for a stable network endpoint:

```sh
npm --workspace maka-agent exec -- maka runtime-host serve \
  --root /srv/maka \
  --websocket-host 0.0.0.0 \
  --websocket-port 7443 \
  --tls-certificate /etc/maka/tls.crt \
  --tls-private-key /etc/maka/tls.key \
  --json
```

### SSH tunnel

Use SSH when the machine is already reachable through OpenSSH. Keep the Runtime Host listener on loopback:

```sh
npm --workspace maka-agent exec -- maka runtime-host serve \
  --root /srv/maka \
  --websocket-port 7443 \
  --json
```

Maka runs the system `ssh` executable without a shell and forwards a temporary Client-loopback port to the Host loopback listener. Normal OpenSSH aliases, keys, agents, and host verification apply. Host entries that configure additional port forwarding are rejected. Maka never edits SSH config or cleans up shared OpenSSH state when a Profile is removed.

Desktop opens an embedded terminal during a user-initiated first connection, so OpenSSH can ask for host-key confirmation, a password, or a key passphrase. TUI exposes the same prompt in its terminal. Background reconnects and non-interactive CLI commands use OpenSSH batch mode; configure a key or SSH agent for those paths.

### Explicit plaintext

Plaintext sends the access credential and Session traffic without transport encryption. Use it only on a trusted, isolated network and only when both sides explicitly opt in:

```sh
npm --workspace maka-agent exec -- maka runtime-host serve \
  --root /srv/maka \
  --websocket-host 0.0.0.0 \
  --websocket-port 7443 \
  --allow-insecure-remote \
  --json
```

The Client Profile must separately persist the plaintext acknowledgement. Maka never downgrades TLS or SSH to plaintext. Copy the service command's JSON `rootId`; Clients pin it to the expected State Root.

## Connect Desktop

Open `Settings → Workspace → Runtime Host` and choose **Add computer**. Enter an OpenSSH destination; Desktop runs the released setup command in an interactive SSH session, stores the resulting credential, verifies the tunnel, and then opens the remote Project picker.

Use **Configure manually** for an existing TLS, SSH, or explicitly acknowledged plaintext endpoint.

The credential is stored separately from the Profile. Desktop keeps Local and every enabled remote Host connected independently. Choose one as the default for new Sessions; existing Sessions continue to use their owning Host. A failed remote connection remains visible without interrupting the other Hosts. After connecting, choose a Project registered on that Host; Client-local directory actions remain unavailable.

During guided pairing, the delivered credential has the selected Client grants and expires after 15 minutes unless Desktop explicitly finalizes it after saving the local binding.

For an SSH-managed computer, open its **Manage** action to inspect the installed release, service state, published directory roots, and recent logs, or to start, restart, repair, or uninstall the service. Uninstalling preserves the remote State Root and does not remove the Desktop Profile; removing a Profile does not uninstall the remote service. Manually configured direct connections remain usable but must be managed on the Host machine.

## Connect TUI or CLI

Store the target as a shared Profile. Supply the credential through an environment variable only while creating or updating it:

```sh
export MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL='<credential>'

# Direct TLS
maka runtime-host profile set \
  --id office --name Office \
  --tls-url wss://runtime.example.com:7443/runtime-host \
  --expected-root '<rootId>'

# Or SSH
maka runtime-host profile set \
  --id office-ssh --name 'Office SSH' \
  --ssh-destination user@runtime.example.com \
  --ssh-remote-port 7443 \
  --expected-root '<rootId>'

# Or explicit plaintext
maka runtime-host profile set \
  --id lab --name Lab \
  --plaintext-url ws://192.0.2.10:7443/runtime-host \
  --acknowledge-plaintext \
  --expected-root '<rootId>'

unset MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL
```

Then select a Host Project explicitly:

```sh
maka --host office --project '<projectId>'
maka run --host office --project '<projectId>' "Summarize this project"
```

Each TUI or CLI process connects to one Profile. TUI may interact with SSH during its initial connection; non-interactive commands require preconfigured authentication.

## Compatibility troubleshooting

`RUNTIME_HOST_REMOTE_INCOMPATIBLE` means the Client and remote Runtime Host cannot safely communicate. Compare the Client and Host compatibility epochs first. When the diagnostic reports them, also inspect the Client and Host protocol ranges and composition IDs (including the Host composition revision).

Use compatible Client and Host builds. After updating the Host, the operator must restart its remote Runtime Host service, then retry the connection.

Remote Clients never auto-upgrade or restart the Host, downgrade the transport, mutate the Profile, change the default Host or Session, or expose credentials, endpoints, paths, or State Roots in this diagnostic.

## Security boundaries

- Do not put credentials on the command line or in Profile JSON.
- Plaintext requires durable Client acknowledgement and an independent Host startup flag.
- Session responses may include a resolved `hostCwd`. Treat it as Host metadata, never as a Client filesystem path.
- Runtime Host protocol operations cannot upgrade, restart, or terminate the service process.
  Desktop management uses the separately authenticated SSH operator channel. The Host may still
  drain itself after an indeterminate durable commit; a managed service supervisor restarts it.
- Revoke a credential on the Host with `maka runtime-host access revoke --root /srv/maka --credential <credentialId>`.
