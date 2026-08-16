# PiP Studio Releases

This repository publishes verified Windows release assets for PiP Studio.

The installer binaries are stored as GitHub Release assets, not in Git history.
Each release is copied from the existing production object storage and checked
against a committed manifest before it is made public.

## Download

- Latest Windows installer: [Pip-Studio-Setup.exe](https://github.com/RonnyLin/pip-studio-releases/releases/latest/download/Pip-Studio-Setup.exe)
- All releases: [GitHub Releases](https://github.com/RonnyLin/pip-studio-releases/releases)

## Publishing a release

1. Upload the versioned Electron Builder output to production object storage.
2. Add `releases/vX.Y.Z.json` and `releases/vX.Y.Z.md` with the expected file
   names, byte sizes, SHA-256 values, and installer SHA-512 value.
3. Push those files to `main`.
4. Create and push the matching annotated tag, for example `v0.2.2`.

The workflow downloads the three Electron Builder assets, validates the
manifest and source `latest.yml`, converts asset names to GitHub-safe names,
creates a matching GitHub `latest.yml` and stable installer alias, uploads
everything to a draft GitHub Release, verifies the uploaded names, sizes, and
checksums, and only then publishes the release.

The desktop app's automatic updater currently remains on the production COS
endpoint. This repository provides an additional global download channel; it
does not silently change existing clients' update source.

## Integrity

Every release includes `SHA256SUMS.txt`. The Electron updater also validates the
installer with the SHA-512 value in `latest.yml`.

> Windows code-signing status is independent of these checks. PiP Studio 0.2.2
> is currently unsigned and may show a Windows SmartScreen warning.
