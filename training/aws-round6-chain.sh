#!/usr/bin/env bash
# Round 6 (repair coder) on one g5: the teacher fixes accepted pages that do not
# match their own API (scripts/capture-form-fixes.mjs, kept only when the form
# check finds nothing wrong), round 4's data plus those fixes trains code_rich_r6,
# and r6 is measured as the repair model against round 4; then the instance stops.
#   inputs  ~/ev (repo at HEAD), ~/vibe/capture/code/{rich,rich2}-w*.jsonl,
#           ~/vibe/capture/code/synthetic-import-corrections.jsonl,
#           ~/ev/capture/code/synthetic-form-corrections.jsonl,
#           ~/ev/capture/code/{gold,new}-reference, ~/vibe/training/runs/{code_round1,code_rich_r4}/adapter
#   outputs ~/ev/capture/code/teacher-form-fixes.jsonl, ~/ev/training/code/formatted-r6,
#           ~/ev/training/runs/code_rich_r6, ~/ev/training/eval/forms/new-reference-r6.json,
#           ~/ev/training/eval/code/qwen-coder-7b-fix-r1r6.json
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
for f in rich-w1 rich-w2 rich-w3 rich-w4 rich2-w1 rich2-w2 rich2-w3 rich2-w4 synthetic-import-corrections; do
  ln -sf ~/vibe/capture/code/$f.jsonl capture/code/$f.jsonl
done
CAPTURES="capture/code/rich-w1.jsonl capture/code/rich-w2.jsonl capture/code/rich-w3.jsonl capture/code/rich-w4.jsonl capture/code/rich2-w1.jsonl capture/code/rich2-w2.jsonl capture/code/rich2-w3.jsonl capture/code/rich2-w4.jsonl"

# 1. The teacher fixes pages that do not match their API.
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
node scripts/capture-form-fixes.mjs $CAPTURES --local=http://127.0.0.1:8712 --model=teacher \
  --out=capture/code/teacher-form-fixes.jsonl --concurrency=8 > ~/r6-fixes.log 2>&1
log "fixes-exit $? $(tail -1 ~/r6-fixes.log)"
kill $(pgrep -f "[v]llm serve cyankiwi") $(pgrep -f "[t]eacher_shim") 2>/dev/null
sleep 20

# 2. Round 6 = round 4's inputs and settings + the form fixes.
rm -rf $NVME/train
(cd $NVME && ~/.local/bin/uv venv -q -p 3.12 train && VIRTUAL_ENV=$NVME/train ~/.local/bin/uv pip install -q unsloth)
PY=$NVME/train/bin/python
log train-env-ready
$PY training/code/format-code-dataset.py $CAPTURES capture/code/synthetic-import-corrections.jsonl \
  capture/code/teacher-form-fixes.jsonl capture/code/synthetic-form-corrections.jsonl \
  --correction-share 0.3 --out-dir training/code/formatted-r6 > ~/r6-format.log 2>&1
log "dataset-ready $(grep -o '"rows": [0-9]*' training/code/formatted-r6/manifest.json | head -1)"
log coder-start
$PY -u training/code/train_code.py --data training/code/formatted-r6/dataset.jsonl --out training/runs/code_rich_r6 --epochs 3 > ~/r6-train.log 2>&1
log "coder-exit $?"

# 3. Round 6 as the repair model, against round 4's recorded results.
setsid -f $PY ~/local_inference_server.py --port 8712 \
  --model code1=$BASE:$RUNS/code_round1/adapter \
  --model code6=$BASE:$HOME/ev/training/runs/code_rich_r6/adapter > ~/r6-server.log 2>&1 < /dev/null
wait_http http://127.0.0.1:8712/models code6
log coders-ready
rm -rf capture/code/work/eval-form-check
node scripts/eval-form-check.mjs --reference=capture/code/new-reference --gold=training/data/eval-new/plans-563.jsonl \
  --repair=http://127.0.0.1:8712,model=code6 --out=training/eval/forms/new-reference-r6.json > ~/r6-forms.log 2>&1
log "forms-exit $? $(tail -1 ~/r6-forms.log)"
node scripts/eval-code-model.mjs --candidate=http://127.0.0.1:8712,model=code1 --repair=http://127.0.0.1:8712,model=code6 \
  --reference=capture/code/gold-reference --gold=training/data/gold/gold.jsonl \
  --out=training/eval/code/qwen-coder-7b-fix-r1r6.json > ~/r6-eval-fix.log 2>&1
log "eval-fix-exit $?"

log done
sync
sleep 2700
log shutting-down
sudo shutdown -h now
