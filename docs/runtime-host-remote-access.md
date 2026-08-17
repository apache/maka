# Connect to a remote Runtime Host

[简体中文](./runtime-host-remote-access.zh-CN.md)

Maka Desktop, TUI, and CLI can connect to a Runtime Host through TLS, SSH, or explicitly enabled plaintext WebSocket.

## Prepare the Host

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

Open `Settings → Workspace → Runtime Host`, choose **Add remote Host**, select the connection method, and enter the method-specific endpoint, the ready event's `rootId`, and the issued credential. Choose **Save and enable**.

The credential is stored separately from the Profile. Desktop keeps Local and every enabled remote Host connected independently. Choose one as the default for new Sessions; existing Sessions continue to use their owning Host. A failed remote connection remains visible without interrupting the other Hosts. After connecting, choose a Project registered on that Host; Client-local directory actions remain unavailable.

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

## Security boundaries

- Do not put credentials on the command line or in Profile JSON.
- Plaintext requires durable Client acknowledgement and an independent Host startup flag.
- Session responses may include a resolved `hostCwd`. Treat it as Host metadata, never as a Client filesystem path.
- A remote Client neither upgrades nor terminates the service process.
- Revoke a credential on the Host with `maka runtime-host access revoke --root /srv/maka --credential <credentialId>`.
