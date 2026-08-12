# Connect to a remote Runtime Host

[简体中文](./runtime-host-remote-access.zh-CN.md)

Maka Desktop, TUI, and CLI can connect to a Runtime Host through direct TLS, an SSH tunnel, or an explicitly acknowledged plaintext WebSocket. The Host remains authoritative for its Projects, model connections, Sessions, and execution state.

## Prepare the Host

Build Maka on the remote machine and choose a persistent State Root. Register each directory that remote Clients may use:

```sh
npm run build
npm --workspace maka-agent exec -- maka runtime-host project add /srv/projects/example --root /srv/maka
npm --workspace maka-agent exec -- maka runtime-host project list --root /srv/maka
```

Project paths stay on the Host. Remote Clients select the returned Project identity and never reinterpret a Client-local directory as a Host path.

Issue one credential for each Client principal:

```sh
npm --workspace maka-agent exec -- maka runtime-host access issue \
  --root /srv/maka \
  --principal my-desktop \
  --preset desktop-client
```

Use `terminal-client` for a TUI or CLI-only principal. The command prints the credential once. Credentials do not grant access administration or arbitrary Host-path access.

## Choose a connection method

### Direct TLS

Use TLS for a Host with a stable network endpoint:

```sh
npm --workspace maka-agent exec -- maka runtime-host serve \
  --root /srv/maka \
  --websocket-host 0.0.0.0 \
  --websocket-port 7443 \
  --tls-certificate /etc/maka/tls.crt \
  --tls-private-key /etc/maka/tls.key \
  --json
```

Clients use the reachable `wss://` URL and normal platform certificate validation.

### SSH tunnel

Use SSH when the machine is already reachable through OpenSSH. Keep the Runtime Host listener on loopback:

```sh
npm --workspace maka-agent exec -- maka runtime-host serve \
  --root /srv/maka \
  --websocket-port 7443 \
  --json
```

The Profile stores the SSH destination, optional SSH port, remote WebSocket port, and path. Maka runs the system `ssh` executable without a shell and forwards a temporary Client-loopback port to `127.0.0.1:7443` on the Host.

Maka reads normal OpenSSH configuration but never edits SSH config, keys, agents, or `known_hosts`. OpenSSH may add a host key after the user confirms it. Removing a Maka Profile removes only that Profile and its Runtime Host credential; shared OpenSSH state remains under the user's control.

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

The Client Profile must separately persist the plaintext acknowledgement. Maka never downgrades TLS or SSH to plaintext.

Each service command prints one JSON ready event. Copy its `rootId`; Clients pin it to verify the expected State Root.

## Connect Desktop

Open `Settings → Workspace → Runtime Host`, choose **Add remote Host**, select the connection method, and enter the method-specific endpoint, the ready event's `rootId`, and the issued credential. Choose **Save and connect**.

The credential is stored separately from the Profile. If the connection fails, the current Host remains active and the incomplete Profile is removed. A successful connection saves the Profile for later use. After connecting, choose one of the Projects already registered on that Host; local directory picking and other Client-path actions remain unavailable.

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

Each TUI or CLI process connects to one Profile. The TUI may interact with SSH during its initial connection; non-interactive commands report the SSH failure and require preconfigured authentication.

## Security boundaries

- Do not put credentials on the command line or in Profile JSON.
- Prefer TLS or SSH. Plaintext requires durable Client acknowledgement and an independent Host startup flag.
- SSH forwards only between loopback addresses; the system OpenSSH client remains responsible for host verification and authentication.
- Session responses may include a resolved `hostCwd`. Treat it as Host metadata, never as a Client filesystem path.
- A remote Client neither upgrades nor terminates the service process.
- Revoke a credential on the Host with `maka runtime-host access revoke --root /srv/maka --credential <credentialId>`.
