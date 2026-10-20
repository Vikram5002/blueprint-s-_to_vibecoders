#!/usr/bin/env bash
# Round 2 on one GPU instance, start to finish, then stop the instance.
#   1. teacher (Qwen3-Coder-30B, vLLM) writes complete plans for 286 new prompts   -> capture/planner-r2-w*.jsonl
#   2. teacher writes rich code for the complete plans (forms required)            -> capture/code/rich2-w*.jsonl
#   3. planner trained on 288 + new plans; coder trained on round 3 + round 4 data
#   4. shutdown (instance stops; the root disk keeps every result)
# Results live on the root disk (~/vibe); /opt/dlami/nvme is wiped on every stop.
set -u
cd ~/vibe
NVME=/opt/dlami/nvme
CU=$NVME/teach/lib/python3.12/site-packages/nvidia/cu13
export HF_HOME=$NVME/hf
log() { echo "== $* $(date -u +%H:%M:%S)"; }
wait_http() { until curl -s -m 3 "$1" | grep -q "$2"; do sleep 15; done; }

log teacher-start
CUDA_HOME=$CU PATH=$CU/bin:$PATH VLLM_USE_FLASHINFER_SAMPLER=0 setsid -f $NVME/teach/bin/vllm serve \
  cyankiwi/Qwen3-Coder-30B-A3B-Instruct-AWQ-4bit --served-model-name teacher --max-model-len 16384 \
  --gpu-memory-utilization 0.93 --max-num-seqs 8 --host 127.0.0.1 --port 8000 > ~/vllm-teacher.log 2>&1 < /dev/null
setsid -f /usr/bin/python3 training/code/teacher_shim.py --vllm http://127.0.0.1:8000 --model teacher --port 8712 > ~/shim.log 2>&1 < /dev/null
wait_http http://127.0.0.1:8000/v1/models teacher
log teacher-ready

# 1. Plans (skipped when a previous run already wrote them).
if [ ! -s capture/code/rich2-plans/w1/plans.jsonl ]; then
mkdir -p capture/planner-r2-prompts
awk '{ print > ("capture/planner-r2-prompts/w" ((NR-1)%4+1) ".txt") }' training/data/prompts/planner-r2-prompts.txt
for i in 1 2 3 4; do
  node scripts/capture-schema-batch.mjs --local=http://127.0.0.1:8712 --model=teacher --rich \
    --prompts=capture/planner-r2-prompts/w$i.txt --out=capture/planner-r2-w$i.jsonl > capture/planner-r2-w$i.log 2>&1 &
done
wait
log plans-done

# Complete plans only, as {prompt, schema} pairs, split 4 ways for the code workers.
mkdir -p capture/code/rich2-plans
node --input-type=module -e "
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const thin = (s) => s.domains.frontend.components.length < 3 || !s.domains.backend.components.length || !s.domains.database.components.length
  || s.domains.frontend.components.some((p) => p.purpose.split(/\s+/).length < 6);
const pairs = [1, 2, 3, 4].flatMap((i) => readFileSync('capture/planner-r2-w' + i + '.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  .filter((r) => r.schema !== null && !thin(r.schema)).map((r) => ({ prompt: r.prompt, schema: r.schema }));
for (let w = 1; w <= 4; w += 1) {
  mkdirSync('capture/code/rich2-plans/w' + w, { recursive: true });
  writeFileSync('capture/code/rich2-plans/w' + w + '/plans.jsonl', pairs.filter((_, k) => k % 4 === w - 1).map((p) => JSON.stringify(p)).join('\n') + '\n');
}
console.log('complete plans:', pairs.length);"

fi

# 2. Code: 4 workers over the complete plans.
for i in 1 2 3 4; do
  node scripts/capture-code-batch.mjs --local=http://127.0.0.1:8712 --model=teacher --rich \
    --sources=capture/code/rich2-plans/w$i --out=capture/code/rich2-w$i.jsonl \
    --work=$NVME/rich2-work-w$i --teacher-host=aws-g5-A10G > capture/code/rich2-w$i.log 2>&1 &
done
wait
log code-done

kill $(pgrep -f "[v]llm serve cyankiwi") $(pgrep -f "[t]eacher_shim") 2>/dev/null
sleep 20
log teacher-stopped

# 3. Training environment (the fast disk was wiped), datasets, then planner and coder.
(cd $NVME && ~/.local/bin/uv venv -q -p 3.12 train && VIRTUAL_ENV=$NVME/train ~/.local/bin/uv pip install -q unsloth)
PY=$NVME/train/bin/python
log train-env-ready

node training/format-planner-dataset.mjs --base=training/formatted/dataset.jsonl \
  --out=planner-r2-root/training/formatted/dataset.jsonl capture/planner-r2-w1.jsonl capture/planner-r2-w2.jsonl capture/planner-r2-w3.jsonl capture/planner-r2-w4.jsonl
$PY training/code/format-code-dataset.py capture/code/rich-w1.jsonl capture/code/rich-w2.jsonl capture/code/rich-w3.jsonl capture/code/rich-w4.jsonl \
  capture/code/rich2-w1.jsonl capture/code/rich2-w2.jsonl capture/code/rich2-w3.jsonl capture/code/rich2-w4.jsonl \
  capture/code/synthetic-import-corrections.jsonl --correction-share 0.3 --out-dir training/code/formatted-r4
log datasets-ready

log planner-start
VIBE_TRAIN_ROOT=$HOME/vibe/planner-r2-root $PY -u training/train_full.py
log "planner-exit $?"

log coder-start
$PY -u training/code/train_code.py --data training/code/formatted-r4/dataset.jsonl --out training/runs/code_rich_r4 --epochs 3
log "coder-exit $?"

log shutting-down
sync
sudo shutdown -h +10
