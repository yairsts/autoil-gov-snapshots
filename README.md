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
- GitHub Actions alone bypasses the PR/check rule for direct daily report
  commits. This bypass is app-wide, not path-scoped: trusted workflow code must
  be reviewed carefully. The report step stages only `status.json` and rejects
  other modified tracked files. The bot cannot bypass deletion/force-push rules.

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

`status.json` is a public metadata-only report captured once per UTC day. Check
its `checkedAt` and linked run; later runs are visible in Actions summaries.
Daily real report commits also keep the repository active, avoiding GitHub's
60-day inactivity rule for public scheduled workflows. Failed status publication
is visible as a failed workflow and must be investigated.

Only one repository may write snapshots. Cross-repository concurrency groups
do not prevent overlapping writers. Keep both legacy backend updater workflows
disabled after the cutover. To roll back, disable this writer, wait for any active
run to finish, then re-enable the old government refresh workflow.

## Source

Updater code and its existing regression checks were extracted from Autoil
backend Stage revision `315fb602ec571362267b9b20a9a053bf3ca37d1c`.
Only the private-vehicle shard layout was separated from the backend reader.
R2 keys, shard formats, source selection, and publication behavior are unchanged.
