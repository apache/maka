# Maka CLI

Maka is a local-first agent workspace for terminal and desktop workflows. This package installs
the interactive terminal UI and non-interactive CLI.

> **Beta:** the CLI is under active development. Commands and local data formats may change before
> the stable release.

## Install

```bash
npm install --global maka-agent@next
maka
```

`maka-agent` is an alias for `maka`. Node.js 22.19.0 or newer is required.

Use `maka --help` for the supported command surface. `maka eval` additionally requires the
executor environment declared by the selected experiment, such as Docker and Harbor or Pier; the
npm package includes Maka's Eval runtime but does not install those external systems.

## Links

- [Repository](https://github.com/maka-agent/maka-agent)
- [Issues](https://github.com/maka-agent/maka-agent/issues)
- [License](https://github.com/maka-agent/maka-agent/blob/main/LICENSE)
