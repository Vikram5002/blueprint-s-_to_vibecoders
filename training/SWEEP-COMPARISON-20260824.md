# Hyperparameter sweep comparison — 2026-08-24

Baseline config: r=16, alpha=16, lr=2e-4, 3 epochs (run_20260822_130636).
Three configs run, each varying one dimension from baseline, same 91-row
`training/formatted/dataset.jsonl`.

| Config | r | alpha | lr | epochs | Final loss | Run dir |
|---|---|---|---|---|---|---|
| Baseline (existing) | 16 | 16 | 2e-4 | 3 | **0.903** | `run_20260822_130636` |
| A — rank doubled | 32 | 16 | 2e-4 | 3 | 0.907 | `run_20260824_145554` |
| B — lr halved | 16 | 16 | 1e-4 | 3 | 1.036 | `run_20260824_150319` |
| C — 5 epochs | 16 | 16 | 2e-4 | 5 | **0.741** | `run_20260824_150823` |

## Reading it

- **Config C (more epochs) is the clear standout** — lowest loss by a wide
  margin, last individual logged step hit 0.41. Most likely candidate worth
  a held-out eval next week.
- **Config A (rank doubled) moved nothing** — 0.907 vs baseline's 0.903 is
  not a meaningful difference, despite doubling trainable params (80.7M vs
  40.4M). Rank doesn't look like the bottleneck at this dataset size.
- **Config B (lr halved) is worse, as expected** — less convergence in the
  same 3 epochs.

## VRAM and wall-clock time: not reported as comparable numbers

Every sweep run (A, B, C) trained while an unrelated GPU job (PID 30268,
`spoof_generation`/XTTS, not part of this project) was concurrently active
for most of the session, holding a steady ~5.2-5.5GB and 45-55% utilization
throughout. This makes wall-clock time for A/B/C not comparable to the
baseline's clean-GPU 104.3s figure, and not meaningfully comparable to each
other's absolute duration either (contention varied second to second).
Peak VRAM readings (7.8-8.7GB per config, via `torch.cuda.max_memory_allocated()`,
which tracks only this process's own allocation) were likely more reliable
since that call doesn't see the other process's memory — but given the
session's GPU sharing throughout, none of the timing/VRAM numbers from today
are being treated as clean measurements. Loss is the only number from this
sweep being used to compare configs.

## Not run today

No fourth config, and no held-out generation on any of A/B/C — both
deliberately deferred given GPU contention for most of the session. Next
step: held-out eval of Config C against the existing baseline
(run_20260822_130636), once contention-free.
