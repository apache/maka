# Connect to a remote Runtime Host

[简体中文](./runtime-host-remote-access.zh-CN.md)

Maka Desktop, TUI, and CLI can connect directly to a Runtime Host over authenticated TLS. The Host remains authoritative for its Projects, model connections, Sessions, and execution state.

Direct TLS is the only remote transport currently supported. SSH tunnels and explicitly insecure plaintext connections are not yet product features.

## Prepare the Host

Build Maka on the remote machine, choose a persistent State Root, and start the service with your TLS certificate and private key:

```sh
npm run build
npm --workspace maka-agent exec -- maka runtime-host serve \
  --root /srv/maka \
  --websocket-host 0.0.0.0 \
  --websocket-port 7443 \
  --tls-certificate /etc/maka/tls.crt \
  --tls-private-key /etc/maka/tls.key \
  --json
```

The service prints one JSON ready event. Copy its `rootId`. A wildcard listener address is only a bind fact; use the DNS name or address that your Client can actually reach.

Keep the service running. In another terminal on the Host, register each directory that remote Clients may use:

```sh
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

Use `terminal-client` for a TUI or CLI-only principal. The command prints the credential once. Presets expand to exact operation grants when the credential is issued; they do not grant access administration or Host-path authority, and an existing credential does not gain operations when Maka later changes a preset.

## Connect Desktop

Open `Settings → Workspace → Runtime Host`, choose **Add remote Host**, and enter:

- a local display name;
- the reachable `wss://` endpoint;
- the `rootId` from the ready event;
- the issued access credential.

Choose **Save and connect**. The credential is stored separately from the Profile. Maka verifies the TLS certificate and exact State Root; it never falls back to Local discovery. If the connection fails, the current Host remains active, the incomplete Profile is removed, and the setup form keeps its values for correction. A successful connection saves the Profile for later use.

After connecting, choose one of the Projects already registered on that Host. Local directory picking and other Client-path actions stay unavailable for a remote Host.

## Connect TUI or CLI

Store the same target as a shared Profile. Supply the credential through an environment variable only while creating or updating the Profile:

```sh
export MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL='<credential>'
npm --workspace maka-agent exec -- maka runtime-host profile set \
  --id office \
  --name Office \
  --tls-url wss://runtime.example.com:7443/runtime-host \
  --expected-root '<rootId>'
unset MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL
```

Then select a Host Project explicitly:

```sh
npm --workspace maka-agent exec -- maka --host office --project '<projectId>'
npm --workspace maka-agent exec -- maka run --host office --project '<projectId>' "Summarize this project"
```

Each TUI or CLI process connects to one Profile. It reports unreachable endpoints, certificate failures, authentication failures, incompatible Hosts, unexpected State Roots, and unavailable Projects as terminal errors.

## Security boundaries

- Do not put credentials on the command line or in Profile JSON.
- Direct remote connections require `wss:` and normal platform certificate validation; there is no verification bypass or plaintext fallback.
- The service process is owned by its deployment operator. A remote Client neither upgrades nor terminates it.
- Revoke a credential on the Host with `maka runtime-host access revoke --root /srv/maka --credential <credentialId>`.
