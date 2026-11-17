# Example: a repository that pins a TapeOut circuit

This directory is the layout a downstream repository uses. Copy these files to the root of your repository and follow [docs/install.md](../../docs/install.md).

```
pincheck.json                     the circuits your app calls
.github/workflows/pincheck.yml    runs the "Circuit compatibility" check on every pull request
.github/CODEOWNERS                requires a circuit owner to approve changes to both
ruleset.json                      optional: create the branch ruleset with the GitHub CLI (not copied into your repo)
```

The PinCheck repository exercises this exact layout in `.github/workflows/consumer-example.yml`, which installs the action from GitHub the same way your repository will.
