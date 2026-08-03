# Synthetic configuration examples

Everything in this directory is fabricated for documentation and offline testing. The values do not identify a person, bot, chat, deployment, provider account, or production endpoint.

## Files

- [`config.minimal.json`](config.minimal.json) demonstrates one agent, one owner entity, a local data root, a private persona-policy path, and one OpenAI-compatible provider.
- [`.env.example`](.env.example) lists environment-variable names with empty values.
- [`config.private.example.json`](config.private.example.json) demonstrates the ignored local overlay used for secrets-adjacent and machine-specific settings. It contains no secret.
- [`persona-policy.example.md`](persona-policy.example.md) is a deliberately generic continuity policy.

The root [`config.example.json`](../config.example.json) is the canonical runtime schema example. These files favor explanation and safe copying.

## Prepare a local configuration

From the repository root:

```bash
cp config.example.json config.json
cp persona-policy.example.md persona-policy.private.md
cp examples/config.private.example.json config.private.json
```

Edit `config.json` and the ignored `config.private.json`. Put the real memory root outside the repository. Inject credentials through your shell or process manager; the runtime intentionally has no dotenv dependency and does not automatically load `.env`.

For a temporary shell session:

```bash
export PRIMARY_API_KEY='replace-in-your-shell'
export TELEGRAM_BOT_TOKEN='replace-in-your-shell'
```

Never paste a real value into an issue, test fixture, committed config, or command transcript intended for publication.
