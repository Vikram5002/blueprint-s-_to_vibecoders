#!/usr/bin/env bash
# Round 3 on one GPU instance: the round-2 plans with the backend -> database link
# (src/workflow/complete-dependencies.ts) rebuilt by the teacher, so routes read
# real tables; then both models trained; then the instance stops.
#   inputs  capture/code/rich3-plans/w*/plans.jsonl   (fixed plans, made on the laptop)
#           training/formatted-r3/dataset.jsonl       (planner rows, links fixed)
#   outputs capture/code/rich3-w*.jsonl, training/code/formatted-r5, planner and coder runs
# Results live on the root disk (~/vibe); /opt/dlami/nvme is wiped on every stop.
set -u
cd ~/vibe
NVME=/opt/dlami/nvme
CU=$NVME/teach/lib/python3.12/site-packages/nvidia/cu13
export HF_HOME=$NVME/hf
log() { echo "== $* $(date -u +%H:%M:%S)"; }
wait_http() { until curl -s -m 3 "$1" | grep -q "$2"; do sleep 15; done; }

if [ ! -x $NVME/teach/bin/vllm ]; then
  (cd $NVME && ~/.local/bin/uv venv -q -p 3.12 teach && VIRTUAL_ENV=$NVME/teach ~/.local/bin/uv pip install -q vllm)
fi
log teacher-start
CUDA_HOME=$CU PATH=$CU/bin:$PATH VLLM_USE_FLASHINFER_SAMPLER=0 setsid -f $NVME/teach/bin/vllm serve \
  cyankiwi/Qwen3-Coder-30B-A3B-Instruct-AWQ-4bit --served-model-name teacher --max-model-len 16384 \
  --gpu-memory-utilization 0.93 --max-num-seqs 8 --host 127.0.0.1 --port 8000 > ~/vllm-teacher.log 2>&1 < /dev/null
setsid -f /usr/bin/python3 training/code/teacher_shim.py --vllm http://127.0.0.1:8000 --model teacher --port 8712 > ~/shim.log 2>&1 < /dev/null
wait_http http://127.0.0.1:8000/v1/models teacher
log teacher-ready

for i in 1 2 3 4; do
  node scripts/capture-code-batch.mjs --local=http://127.0.0.1:8712 --model=teacher --rich \
    --sources=capture/code/rich3-plans/w$i --out=capture/code/rich3-w$i.jsonl \
    --work=$NVME/rich3-work-w$i --teacher-host=aws-g5-A10G >> capture/code/rich3-w$i.log 2>&1 &
done
wait
log code-done

kill $(pgrep -f "[v]llm serve cyankiwi") $(pgrep -f "[t]eacher_shim") 2>/dev/null
sleep 20
log teacher-stopped

rm -rf $NVME/train
(cd $NVME && ~/.local/bin/uv venv -q -p 3.12 train && VIRTUAL_ENV=$NVME/train ~/.local/bin/uv pip install -q unsloth)
PY=$NVME/train/bin/python
log train-env-ready

# Coder rows: round 3 (real tables) + round-3 rebuild of the round-2 plans; round 2's mock-database files are left out.
$PY training/code/format-code-dataset.py capture/code/rich-w1.jsonl capture/code/rich-w2.jsonl capture/code/rich-w3.jsonl capture/code/rich-w4.jsonl \
  capture/code/rich3-w1.jsonl capture/code/rich3-w2.jsonl capture/code/rich3-w3.jsonl capture/code/rich3-w4.jsonl \
  capture/code/synthetic-import-corrections.jsonl --correction-share 0.3 --out-dir training/code/formatted-r5
mkdir -p planner-r3-root/training/formatted && cp training/formatted-r3/dataset.jsonl planner-r3-root/training/formatted/
log datasets-ready

log planner-start
VIBE_TRAIN_ROOT=$HOME/vibe/planner-r3-root $PY -u training/train_full.py
log "planner-exit $?"

log coder-start
$PY -u training/code/train_code.py --data training/code/formatted-r5/dataset.jsonl --out training/runs/code_rich_r5 --epochs 3
log "coder-exit $?"

log shutting-down
sync
sudo shutdown -h +10
