# Synthetic configuration and service examples

Everything in this directory is fabricated for documentation and offline testing. No value identifies a person, bot, chat, deployment, provider account, or production endpoint.

## Files

- [`config.minimal.json`](config.minimal.json): small one-agent/one-owner configuration.
- [`.env.example`](.env.example): environment-variable names with empty values.
- [`config.private.example.json`](config.private.example.json): ignored machine-local overlay shape; contains no secret.
- [`persona-policy.example.md`](persona-policy.example.md): deliberately generic continuity policy.
- [`com.example.tether.plist`](com.example.tether.plist): macOS LaunchAgent skeleton.
- [`tether.service`](tether.service): Linux systemd unit skeleton.

The root [`config.example.json`](../config.example.json) is the canonical full schema example.

## Prepare local files

From the repository root:

```bash
cp config.example.json config.json
cp persona-policy.example.md persona-policy.private.md
cp examples/config.private.example.json config.private.json
```

Point `persona.policyFile` at the private copy. Put `storage.root` and every tool workspace in separate private directories outside the checkout. Inject credentials through the shell or a service-manager secret/environment file; Tether intentionally has no dotenv dependency.

```bash
export PRIMARY_API_KEY='replace-in-your-shell'
export TELEGRAM_BOT_TOKEN='replace-in-your-shell'
```

Never paste a real value into a committed config, issue, test fixture, service file, or command transcript intended for publication.

## macOS launchd

Copy the plist outside the repository, replace every placeholder with an absolute local path, and validate it before loading:

```bash
plutil -lint /path/to/com.example.tether.plist
```

The plist launches `tether-supervisor.cjs`, not the child runtime. `KeepAlive` is deliberately false: the Tether supervisor already restarts its child with a bounded crash-loop budget, and exhausting that budget must remain a visible stopped state rather than being reset forever by launchd. `RunAtLoad` still starts it at login; restart the LaunchAgent manually after diagnosing a terminal supervisor failure.

The plist contains no credential values. Use an operator-controlled wrapper or another local secret mechanism to prepare the environment.

## Linux systemd

Copy `tether.service` to a local untracked path, replace the user/group and every absolute path, then inspect it:

```bash
systemd-analyze verify /path/to/tether.service
```

The unit starts the Tether supervisor and applies a separate host-level restart limit. Ensure `EnvironmentFile` is readable only by the service account and contains shell-style assignments, never committed content. After installation, use the host's normal `daemon-reload`, enable, start, and status workflow.

Do not configure either service manager to start a second `bin/tether.cjs` against the same storage root.
