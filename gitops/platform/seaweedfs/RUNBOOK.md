# SeaweedFS runtime config (not expressible as kustomize manifests)

These settings live in the filer/master runtime state, not in a CR/HelmRelease.
Recorded here per the repo sync invariant so they're reproducible on a rebuild.

## Hot-tier write placement (`fs.configure -disk=ssd`)

The two volume servers advertise disk types `ssd` (hot, `seaweedfs-volume-0`,
`longhorn` 2-replica) and `hdd` (cold, `seaweedfs-volume-cold-0`, `longhorn-bulk`
1-replica on amd64-1). New volume allocation defaults to disk type `""` → `hdd`,
so **without the setting below all writes land on the cold tier** (breaking the
"last 7d survives an amd64-1 outage" guarantee).

Make all S3 bucket writes target the hot (`ssd`) tier:

```sh
kubectl -n seaweedfs exec seaweedfs-master-0 -- sh -c \
  "echo 'fs.configure -locationPrefix=/buckets/ -disk=ssd -apply' | weed shell"
```

Verify (`/buckets/` shows `diskType: ssd`):

```sh
kubectl -n seaweedfs exec seaweedfs-master-0 -- sh -c "echo 'fs.configure' | weed shell"
```

Aged data is moved back to `hdd` by the `seaweedfs-tier-move` CronJob
(`tier-move.cronjob.yaml`) once a volume has had no writes for 7d.

## Notes

- Admin shell commands (`volume.tier.move`, `volume.move`, `volume.grow`,
  `volume.balance`) require running `lock` first; the tier-move CronJob does
  `lock` → move → `unlock`.
- The master runs as a **StatefulSet** (`seaweedfs-master-0`), not a Deployment —
  use `exec seaweedfs-master-0` / `-master=seaweedfs-master.seaweedfs:9333`.
- One-time: volumes written before `fs.configure -disk=ssd` was applied remain on
  `hdd`. To migrate recent (<7d) data back to the hot tier:
  `lock` → `volume.tier.move -fromDiskType=hdd -toDiskType=ssd -fullPercent=0 -quietFor=0 -apply` → `unlock`
  (optional; new writes already land on `ssd`).
