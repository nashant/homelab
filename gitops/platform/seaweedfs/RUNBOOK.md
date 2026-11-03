# SeaweedFS runtime config (not expressible as kustomize manifests)

These settings live in the filer/master runtime state, not in a CR/HelmRelease.
Recorded here per the repo sync invariant so they're reproducible on a rebuild.

## Hot-tier write placement (`fs.configure -disk=ssd`)

The two volume servers advertise disk types `ssd` (hot, `seaweedfs-volume-0`,
`longhorn` 2-replica) and `hdd` (cold, `seaweedfs-volume-cold-0`, `longhorn-bulk`
1-replica on amd64-1). New volume allocation defaults to disk type `""` → `hdd`,
so **without the setting below all writes land on the cold tier** (breaking the
"last 48h survives an amd64-1 outage" guarantee).

Make all S3 bucket writes target the hot (`ssd`) tier:

```sh
kubectl -n seaweedfs exec seaweedfs-master-0 -- sh -c \
  "echo 'fs.configure -locationPrefix=/buckets/ -disk=ssd -apply' | weed shell"
```

Verify (`/buckets/` shows `diskType: ssd`):

```sh
kubectl -n seaweedfs exec seaweedfs-master-0 -- sh -c "echo 'fs.configure' | weed shell"
```

The `seaweedfs-tier-move` CronJob (`tier-move.cronjob.yaml`) runs hourly. It
moves a volume to `hdd` when the volume has had no writes for 48h. Every write
updates the volume's modification time, so no data younger than 48h leaves the
hot tier. A volume can stay hot for longer than 48h. This happens when the
volume fills slowly, or when deletes keep updating its modification time.

## Thanos writes straight to the cold tier (`fs.configure -disk=hdd`)

The Thanos bucket does not use the hot tier. The last 48h of metrics are on the
Prometheus volume (`retention: 2d`, `longhorn` 2-replica), so the bucket copy of
that data is a duplicate. The Thanos compactor deletes blocks continuously. Each
delete updates the volume's modification time, so Thanos volumes do not age off
the hot tier. On 2026-11-03 they filled all 61 hot slots, and every bucket write
failed.

Apply the longer prefix after the `/buckets/` rule. The longer prefix wins:

```sh
kubectl -n seaweedfs exec seaweedfs-master-0 -- sh -c \
  "echo 'fs.configure -locationPrefix=/buckets/thanos/ -disk=hdd -apply' | weed shell"
```

Verify that `fs.configure` lists `/buckets/thanos/` with `diskType: hdd`. After a
filer rebuild, apply both rules again. Flux does not restore them.

Thanos volumes that are already on `ssd` can be moved at once:
`lock` → `volume.tier.move -fromDiskType=ssd -toDiskType=hdd -collectionPattern=thanos -fullPercent=0 -quietFor=0 -apply` → `unlock`

## Notes

- Admin shell commands (`volume.tier.move`, `volume.move`, `volume.grow`,
  `volume.balance`) require running `lock` first; the tier-move CronJob does
  `lock` → move → `unlock`.
- The master runs as a **StatefulSet** (`seaweedfs-master-0`), not a Deployment —
  use `exec seaweedfs-master-0` / `-master=seaweedfs-master.seaweedfs:9333`.
- One-time: volumes written before `fs.configure -disk=ssd` was applied remain on
  `hdd`. To migrate recent (<48h) data back to the hot tier:
  `lock` → `volume.tier.move -fromDiskType=hdd -toDiskType=ssd -fullPercent=0 -quietFor=0 -apply` → `unlock`
  (optional; new writes already land on `ssd`).
