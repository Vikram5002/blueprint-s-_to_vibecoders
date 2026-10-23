#!/usr/bin/env bash
# Round 7 on a second g5 (blueprint_train_r7), in parallel with round 6's evaluation:
#  - the teacher writes feature suggestions for the round-4 planner's training plans
#    (scripts/capture-suggestions.mjs) -> planner round 5 = round 4's rows + suggestion rows
#  - placeholder-page corrections (scripts/make-thinpage-corrections.mjs) + round 6's data
#    -> repair coder round 7
# then the instance stops. Measurement runs elsewhere (round 6's instance and the laptop).
#   inputs  ~/ev (repo at HEAD), ~/vibe/capture/code/{rich,rich2}-w*.jsonl, synthetic-import-corrections.jsonl,
#           ~/ev/capture/code/{teacher-form-fixes,synthetic-form-corrections}.jsonl, training/formatted-r4
#   outputs ~/ev/training/runs/code_rich_r7, ~/ev/planner-r5-root/training/runs/run_*
set -u
cd ~/ev
NVME=/opt/dlami/nvme
CU=$NVME/teach/lib/python3.12/site-packages/nvidia/cu13
export HF_HOME=$NVME/hf
log() { echo "== $* $(date -u +%H:%M:%S)"; }
wait_http() { until curl -s -m 3 "$1" | grep -q "$2"; do sleep 15; done; }
sudo chown ubuntu $NVME
for f in rich-w1 rich-w2 rich-w3 rich-w4 rich2-w1 rich2-w2 rich2-w3 rich2-w4 synthetic-import-corrections; do
  ln -sf ~/vibe/capture/code/$f.jsonl capture/code/$f.jsonl
done
CAPTURES="capture/code/rich-w1.jsonl capture/code/rich-w2.jsonl capture/code/rich-w3.jsonl capture/code/rich-w4.jsonl capture/code/rich2-w1.jsonl capture/code/rich2-w2.jsonl capture/code/rich2-w3.jsonl capture/code/rich2-w4.jsonl"

# 1. Teacher: feature suggestions for the planner's training plans.
(cd $NVME && ~/.local/bin/uv venv -q -p 3.12 teach && VIRTUAL_ENV=$NVME/teach ~/.local/bin/uv pip install -q vllm)
log teacher-start
CUDA_HOME=$CU PATH=$CU/bin:$PATH VLLM_USE_FLASHINFER_SAMPLER=0 setsid -f $NVME/teach/bin/vllm serve \
  cyankiwi/Qwen3-Coder-30B-A3B-Instruct-AWQ-4bit --served-model-name teacher --max-model-len 16384 \
  --gpu-memory-utilization 0.93 --max-num-seqs 8 --host 127.0.0.1 --port 8000 > ~/vllm-teacher.log 2>&1 < /dev/null
setsid -f /usr/bin/python3 training/code/teacher_shim.py --vllm http://127.0.0.1:8000 --model teacher --port 8712 > ~/shim.log 2>&1 < /dev/null
wait_http http://127.0.0.1:8000/v1/models teacher
log teacher-ready
node scripts/capture-suggestions.mjs training/formatted-r4/dataset.jsonl --local=http://127.0.0.1:8712 --model=teacher \
  --out=training/formatted-suggestions/dataset.jsonl --concurrency=8 > ~/r7-suggestions.log 2>&1
log "suggestions-exit $? $(tail -1 ~/r7-suggestions.log)"
kill $(pgrep -f "[v]llm serve cyankiwi") $(pgrep -f "[t]eacher_shim") 2>/dev/null
sleep 20

# 2. Data: placeholder-page corrections; round 7 = round 6's inputs + those; planner round 5 = round 4 + suggestions.
node scripts/make-thinpage-corrections.mjs $CAPTURES capture/code/teacher-form-fixes.jsonl \
  --out=capture/code/synthetic-thinpage-corrections.jsonl > ~/r7-thin.log 2>&1
log "thinpage $(tail -1 ~/r7-thin.log)"
rm -rf $NVME/train
(cd $NVME && ~/.local/bin/uv venv -q -p 3.12 train && VIRTUAL_ENV=$NVME/train ~/.local/bin/uv pip install -q unsloth)
PY=$NVME/train/bin/python
log train-env-ready
$PY training/code/format-code-dataset.py $CAPTURES capture/code/synthetic-import-corrections.jsonl \
  capture/code/teacher-form-fixes.jsonl capture/code/synthetic-form-corrections.jsonl capture/code/synthetic-thinpage-corrections.jsonl \
  --correction-share 0.35 --out-dir training/code/formatted-r7 > ~/r7-format.log 2>&1
log "coder-dataset $(grep -o '"rows": [0-9]*' training/code/formatted-r7/manifest.json | head -1)"
mkdir -p planner-r5-root/training/formatted
cat training/formatted-r4/dataset.jsonl training/formatted-suggestions/dataset.jsonl > planner-r5-root/training/formatted/dataset.jsonl
log "planner-dataset $(wc -l < planner-r5-root/training/formatted/dataset.jsonl) rows"

# 3. Planner first (about 25 min), then the coder (about 4 h).
log planner-start
VIBE_TRAIN_ROOT=$HOME/ev/planner-r5-root $PY -u training/train_full.py > ~/r7-planner.log 2>&1
log "planner-exit $?"
log coder-start
$PY -u training/code/train_code.py --data training/code/formatted-r7/dataset.jsonl --out training/runs/code_rich_r7 --epochs 3 > ~/r7-train.log 2>&1
log "coder-exit $?"

log done
sync
sleep 2700
log shutting-down
sudo shutdown -h now
