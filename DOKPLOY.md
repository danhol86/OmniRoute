# Native Dokploy deployment

Use `compose.dokploy.yml` from this repository on branch `main`.

Configure existing runtime values in Dokploy Environment and enable its generated `.env` file. Never commit credentials or operating-state snapshots.
Keep automatic deployment disabled. Build and deploy through RepoDok/Dokploy rather than the old Docker Desktop stack.

## Persistent storage

- `repodok-omniroute-omniroute-data`

Restore these external named volumes before first deployment on another host. Do not run old and new writers concurrently against independently copied state.

Public hostname: `omni.dansmatrix.org`. Route service `omniroute` on container port `20128`. Existing Windows-local host ports are retained for tunnel integrations.

`Dockerfile.dokploy` uses the previously proven operator build recipe to build current main. The `runner-base` target excludes optional browser/CLI bundles. Preserve SQLite state and encryption settings in the data volume.
