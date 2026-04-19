# TLSwitcher

TLSwitcher is a local Raycast extension for switching between saved Typeless
account snapshots and inspecting each account's subscription and usage quota.

## What It Does

- Shows the current Typeless account in Raycast.
- Shows saved Typeless account snapshots.
- Switches Typeless between saved local account snapshots.
- Displays quota usage for daily requests and weekly words.
- Helps start a blank Typeless login flow for adding another account.

## Privacy

TLSwitcher stores account snapshots only on your Mac under:

```text
~/.typeless-switcher/
```

The repository does not include any saved account snapshots, cookies, local
Typeless databases, Google accounts, API tokens, or Raycast development logs.
Those files are intentionally ignored by `.gitignore`.

## Development

Install dependencies:

```zsh
npm install
```

Load the extension into Raycast development mode:

```zsh
npm run install:raycast
```

The install script validates, builds, and starts Raycast development mode. It
also fails if Raycast rejects loading the local extension.

## Notes

The `author` field in `package.json` must be a valid Raycast username for
Raycast's local extension validator. If you publish this to the Raycast Store,
replace it with your own Raycast username.

