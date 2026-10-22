#!/usr/bin/env bash
# Round 4 on one GPU instance: measure the coders on apps the round-3 planner
# writes, measure "round 1 writes, round 4 repairs" (the app's local-fix), then
# train the round-4 planner on complete plans only; then the instance stops.
#   inputs  ~/ev                                       (repo at HEAD, npm installed, dist built)
#           ~/ev/training/data/eval-new/plans-563.jsonl (54 held-out plans by the round-3 planner)
#           ~/ev/training/formatted-r4/dataset.jsonl    (331 planner rows: complete plans only)
#           ~/vibe/training/runs/{code_round1,code_rich_r4,code_rich_r5}/adapter
#   outputs ~/ev/capture/code/new-reference, ~/ev/training/eval/code/*-new*.json and *-fix*.json,
#           ~/ev/planner-r4-root/training/runs/run_*
# Results live on the root disk; /opt/dlami/nvme is wiped on every stop.
set -u
cd ~/ev
NVME=/opt/dlami/nvme
CU=$NVME/teach/lib/python3.12/site-packages/nvidia/cu13
RUNS=$HOME/vibe/training/runs
BASE=unsloth/qwen2.5-coder-7b-instruct-bnb-4bit
export HF_HOME=$NVME/hf
log() { echo "== $* $(date -u +%H:%M:%S)"; }
wait_http() { until curl -s -m 3 "$1" | grep -q "$2"; do sleep 15; done; }
sudo chown ubuntu $NVME

# 1. Reference apps for the new plans, built by the teacher.
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
node scripts/eval-code-model.mjs --build-reference --reference-provider=http://127.0.0.1:8712,model=teacher \
  --gold=training/data/eval-new/plans-563.jsonl --reference=capture/code/new-reference > ~/r4-reference.log 2>&1
log "reference-exit $? passed=$(grep -l '"passed": *true' capture/code/new-reference/*/manifest.json 2>/dev/null | wc -l)"
kill $(pgrep -f "[v]llm serve cyankiwi") $(pgrep -f "[t]eacher_shim") 2>/dev/null
sleep 20
for d in capture/code/new-reference/session-*/; do
  [ -f "$d/package.json" ] && [ ! -d "$d/node_modules" ] && (cd "$d" && npm install --no-audit --no-fund > /dev/null 2>&1)
done
log teacher-stopped

# 2. One Python env for both serving and training (unsloth brings torch, transformers, peft, bitsandbytes).
rm -rf $NVME/train
(cd $NVME && ~/.local/bin/uv venv -q -p 3.12 train && VIRTUAL_ENV=$NVME/train ~/.local/bin/uv pip install -q unsloth)
PY=$NVME/train/bin/python
log train-env-ready

setsid -f $PY ~/local_inference_server.py --port 8712 \
  --model code1=$BASE:$RUNS/code_round1/adapter \
  --model code4=$BASE:$RUNS/code_rich_r4/adapter \
  --model code5=$BASE:$RUNS/code_rich_r5/adapter > ~/r4-server.log 2>&1 < /dev/null
wait_http http://127.0.0.1:8712/models code5
log coders-ready
S=http://127.0.0.1:8712
run_eval() { # name, reference dir, candidate model, [repair model]
  log "eval-$1-start"
  node scripts/eval-code-model.mjs --candidate=$S,model=$3 ${4:+--repair=$S,model=$4} \
    --reference=$2 --out=training/eval/code/qwen-coder-7b-$1.json > ~/r4-eval-$1.log 2>&1
  log "eval-$1-exit $?"
}
run_eval fix-r1r4 capture/code/gold-reference code1 code4
run_eval new-r1 capture/code/new-reference code1
run_eval new-r5 capture/code/new-reference code5
run_eval new-r1r4 capture/code/new-reference code1 code4
kill $(pgrep -f "[l]ocal_inference_server") 2>/dev/null
sleep 20

# 3. Round-4 planner: complete plans only.
mkdir -p planner-r4-root/training/formatted && cp training/formatted-r4/dataset.jsonl planner-r4-root/training/formatted/
log planner-start
VIBE_TRAIN_ROOT=$HOME/ev/planner-r4-root $PY -u training/train_full.py > ~/r4-planner.log 2>&1
log "planner-exit $?"

log done
sync
sleep 2700
log shutting-down
sudo shutdown -h now
