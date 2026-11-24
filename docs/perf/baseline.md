# Performance baseline

What an idle install costs and how fast the first screens answer, measured once on one machine. The numbers are a
starting point for the budgets of later releases. They are not a promise, and a number from a hosted runner is never
compared with them.

## How it was measured

- **Machine:** Intel Core i7-9850H (6 cores, 12 threads), 16 GiB RAM, Windows 11 (10.0.26300). Docker Desktop engine
  29.9.3 with its Linux VM at 12 CPUs and 7.75 GiB. Node v26.13.0.
- **Source:** commit `3233360`, the image built from it by the stack's own build step.
- **Alone:** no container was running before either run (`docker ps -q` empty, which the script checks), nothing else
  ran on the host, and the two runs were not started together.
- **Date:** 2026-11-20. The latency run started 17:15:54Z, the queue run at 17:45:15Z.
- **Sizes:** only the app container (role `all`) is limited, with `docker update --cpus … --memory … --memory-swap …`;
  PostgreSQL is never limited. "Unconstrained" means the whole VM.

```
node perf/baseline/api-latency.mjs           # 300 s idle, 500 workspaces, three sizes (about 40 minutes)
SHOUTORY_PERF_DATABASE_URL=postgres://… node perf/baseline/pgboss-idle.mjs    # against a scratch database, nothing else on it
```

The queue run used a throwaway `postgres:18.6-alpine` container with a scratch database.

## Memory (idle, role `all`)

Read with `docker stats --no-stream` after 300 s with one organization and one workspace (the first journey's state).

| What | MiB |
|---|---|
| App container, idle | 70.7 |
| PostgreSQL container, idle | 64.4 |
| App container after 500 workspaces were created | 101.3 |
| App container after the unconstrained timings | 129.6 |

The goal of 512 MB and the 1 GB ceiling for the app (internal targets, not a public promise) are both met; the
database is outside that target.

## Latency, with 500 workspaces (5 organizations of 100)

Milliseconds from the client, on the same machine, over `localhost`. The percentile is the value at rank
`ceil(share × n)` of the sorted samples.

| App container | Sign-in password step, n=50 (p50 / p95 / max) | `GET /api/v1/workspaces?limit=50`, n=200 (p50 / p95 / max) |
|---|---|---|
| Unconstrained | 93.0 / 105.6 / 150.4 | 7.4 / 9.2 / 13.6 |
| 2 vCPU / 2 GB | 92.1 / 102.1 / 141.1 | 7.4 / 9.4 / 19.1 |
| 1 vCPU / 1 GB | 90.8 / 101.0 / 161.2 | 7.2 / 8.6 / 15.0 |

Creating a workspace through `POST /api/v1/workspaces` (n=499): p50 32.0, p95 35.9, max 51.3 ms.

The internal read target is a p95 under 300 ms; every size is far below it. There is no target for the sign-in step
yet, so its numbers are the first measurement the budget is set from.

## Job queue, idle

40 queues polled every 30 s on a scratch database with nothing else connected, for 120 s: 305 transactions
committed, 2.54 per second (about 1.9 per poll).

## Limits of these numbers

- **Sign-in samples.** One address holds 60 sign-in tokens and gets one back every 15 s, so one machine takes at most
  60 sign-ins in a burst. The script takes 50 on one account and waits 11 minutes before each further size.
- **Organizations.** An organization holds at most 100 workspaces, so 500 workspaces are 5 organizations.
- **Not measured.** Page-load and server-sent-event latency (there is no event stream yet) and the database under a
  size limit.
- **One run.** There is no repetition and no confidence interval; a difference of a few milliseconds between sizes
  is noise.

## Size and price

- **Size:** at 1 vCPU and 1 GB for the app container, with 500 workspaces, every measured latency stayed within the
  targets above, and its memory never passed 130 MiB. The database, unlimited, used about 64 MiB idle.
- **Price:** VERIFY. The prices of the smallest VPS plans that offer 1 GB and 2 GB of memory are to be read from the
  providers' own pages and entered here with the date they were read. None was read on 2026-11-20.
