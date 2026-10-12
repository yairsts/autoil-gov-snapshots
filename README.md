# Autoil government snapshots

This standalone tool builds, tests, and publishes validated snapshots of 17
public Israeli government vehicle datasets. It does not host the Autoil API.
The application and backend repositories stay private.

## Run

Use Node.js 24:

```sh
npm ci --ignore-scripts
npm test
npm run gov:resources:sync
```

The updater checks all 17 source hashes. Only changed datasets are downloaded.
It validates the download size, row count, and storage budget before publication.
Shards are uploaded before the current manifest. Failed updates keep the last
valid snapshot; the previous published version is retained.

## GitHub configuration

Repository Actions secrets:

- `PRIVATE_SNAPSHOT_R2_ACCOUNT_ID`
- `PRIVATE_SNAPSHOT_R2_WRITE_ACCESS_KEY_ID`
- `PRIVATE_SNAPSHOT_R2_WRITE_SECRET_ACCESS_KEY`

Repository Actions variables:

- `PRIVATE_SNAPSHOT_R2_BUCKET`: existing private snapshot bucket.
- `REFRESH_ENABLED`: set to `true` only after the old repository writer is disabled.

Use an R2 Object Read & Write key restricted to the snapshot bucket. Never add
credentials, `.env` files, Firebase files, user records, or backend Git history.
Untrusted pull requests run tests only and receive no R2 secrets. Production
refresh runs only through a schedule or a manual run from the trusted branch.

## Security controls

- Refresh jobs run only from `main` and explicitly check out `main`.
- R2 credentials are passed only to the refresh and status-reading steps, not
  dependency installation or tests.
- GitHub Actions are pinned to full commit IDs. Test checkout does not retain
  Git credentials. External PRs never run the refresh workflow.
- `main` rejects deletion and force pushes. Human changes require a PR and the
  `test` check from GitHub Actions; no second reviewer is required for this
  single-maintainer repository.
- No actor bypasses the `main` rules. The bot publishes only `status.json` to
  the separate `snapshot-status` branch using the GitHub Contents API. It cannot
  push code directly to `main`. Report publishing requires repository write
  permission, so trusted workflow code still needs careful review.

These controls limit mistakes and untrusted PR access. They do not protect
against a compromised owner account, malicious trusted code, or a compromised
runtime dependency. Keep account 2FA enabled and the R2 key bucket-scoped.

The schedule checks sources every six hours, at 00:17, 06:17, 12:17 and 18:17 UTC.
GitHub may delay schedules. Standard public Linux runners do not consume private
repository minutes. R2 has separate storage and operation limits.

## Status and failures

Open **Actions → Government Resource Refresh** for the latest run. Its summary
lists each snapshot's row count, source update, download, and verification dates.
A failed dataset makes the refresh job fail, even when other datasets succeed.
The detailed refresh log identifies which sources were published, unchanged,
or failed. An available copy does not mean the latest refresh succeeded.

[`status.json`](https://github.com/yairsts/autoil-gov-snapshots/blob/snapshot-status/status.json)
on the `snapshot-status` branch is a public metadata-only report captured once per UTC day. Check
its `checkedAt` and linked run; later runs are visible in Actions summaries.
Daily real report commits also keep the repository active, avoiding GitHub's
60-day inactivity rule for public scheduled workflows. Failed status publication
is visible as a failed workflow and must be investigated.

Only one repository may write snapshots. Cross-repository concurrency groups
do not prevent overlapping writers. Keep both legacy backend updater workflows
disabled after the cutover. To roll back, disable this writer, wait for any active
run to finish, then re-enable the old government refresh workflow.

## Dev and Stage snapshots

Dev and Stage share the private `autoil-nonprod-vehicle-snapshots` bucket, not the
Production bucket. Their backend keys must be read-only and restricted to that
non-production bucket. No app response or snapshot layout changes are needed.

**Actions → Government Resource Refresh (Dev and Stage) → Run workflow** checks
all 17 government datasets using the same updater as Production. Only changed
files are downloaded and rebuilt. It runs weekly on Sunday at 04:43 UTC when
`NONPROD_REFRESH_ENABLED` is `true`. Enable the schedule only after a successful
first refresh and backend checks. Production's refresh frequency is unchanged.

Additional Actions secrets:

- `NONPROD_R2_WRITE_ACCESS_KEY_ID` / `NONPROD_R2_WRITE_SECRET_ACCESS_KEY`:
  Object Read & Write access only to `autoil-nonprod-vehicle-snapshots`.

The destination bucket is fixed in the workflow. It receives no Production R2
key and uses a separate writer lock. The existing updater validates source size
and row counts, uploads shards before publishing each manifest, and retains the
previous valid version. Failure leaves the previous manifest usable; interrupted
jobs can leave unreferenced objects, included in the next storage check.
Publication is per dataset, not one transaction across all 17 datasets. Each run
has its own Actions summary with source, download, and verification dates; it
does not overwrite Production's daily status report.

The updater's existing 8 GB guard is per bucket, not an account-wide cap. R2's
free allowance is shared across all buckets and operations, so account-level
usage monitoring is still required. Weekly snapshots intentionally lag the
government. Dev experiments also affect Stage.
Configure both backends with `GOV_DATA_SOURCE=snapshot-first`, the non-production
bucket, and its read-only key only after all 17 datasets are available. A valid
empty snapshot result does not call the government. An unavailable, missing, or
invalid snapshot uses the government as emergency fallback.
To roll back the backend configuration, restore Stage's original Production
read-only bucket and key; do not change the Production backend.

## Source

Updater code and its existing regression checks were extracted from Autoil
backend Stage revision `315fb602ec571362267b9b20a9a053bf3ca37d1c`.
Only the private-vehicle shard layout was separated from the backend reader.
R2 keys, shard formats, source selection, and publication behavior are unchanged.
