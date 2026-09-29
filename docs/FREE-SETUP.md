# Running Vibe-Code Blueprint for free

Every way below costs nothing. Pick one to start; you can switch at any time from the **Model** picker (who writes the plan) and the
**Code** picker (who writes the code) at the top of the workspace. When an option is not set up yet, the picker says exactly what to do.

Keys go in a file called `.env` in the project folder, one per line (`NAME=value`). Restart `node dist/cli.js .` after editing it. Never
share this file or paste a key into a chat or a repository.

| Option | Needs | Good for | Limits |
|---|---|---|---|
| 1. Gemini free tier | Google account | Planning and code, best measured quality | A small daily quota; resets at midnight Pacific time (12:30 pm IST in summer, 1:30 pm in winter) |
| 2. Groq | Email sign-up, no card | Very fast code | Free-tier requests per minute and per day |
| 3. OpenRouter free models | Email sign-up | Trying many open models | Models ending in `:free`; a daily request cap |
| 4. GitHub Models | GitHub account | Students: higher limits with the Student Developer Pack | Per-day request limits |
| 5. Ollama | A laptop with 8 GB+ RAM | Fully offline and private | Slower on CPU |
| 6. Our fine-tuned models on Lightning AI | Lightning account | The trained plan + code models | Free monthly GPU credits |
| 7. Google Colab | Google account | The trained models, when Lightning credit is used up | Sessions end; a new link each time |

## 1. Gemini free tier

1. Open [aistudio.google.com](https://aistudio.google.com), sign in, and choose **Get API key**. Do not attach a billing account.
2. In `.env`: `GEMINI_API_KEY=...` (more keys as `GEMINI_API_KEY_2`, `_3`, ... are used in turn when one runs out for the day).
3. Picker: **Gemini (free tier, cloud)**.

## 2. Groq

1. Sign up at [console.groq.com](https://console.groq.com) and create an API key.
2. In `.env`: `GROQ_API_KEY=...`
3. Picker: **Groq (free tier, cloud)**. The default model is `openai/gpt-oss-120b`; set `GROQ_MODEL` to use another from Groq's list.

## 3. OpenRouter free models

1. Sign up at [openrouter.ai](https://openrouter.ai) and create a key under **Keys**.
2. In `.env`: `OPENROUTER_API_KEY=...`
3. Picker: **OpenRouter (free models, cloud)**. The default is `qwen/qwen3.8-27b:free`. The free list changes often; any model whose name
   ends in `:free` can go in `OPENROUTER_MODEL`.

## 4. GitHub Models

1. On GitHub: **Settings -> Developer settings -> Fine-grained tokens -> Generate new token**, and give it the **Models: read** permission.
2. In `.env`: `GITHUB_MODELS_TOKEN=...`
3. Picker: **GitHub Models (free, students get more)**. Students: claim the [GitHub Student Developer Pack](https://education.github.com/pack)
   for higher limits and many other free tools.

## 5. Ollama (offline, on your laptop)

1. Install from [ollama.com](https://ollama.com).
2. Download a model once: `ollama pull qwen2.5-coder:7b` (about 5 GB).
3. Picker: **Ollama (free, offline, this computer)**. Nothing leaves your machine. Another model: set `OLLAMA_MODEL`.

## 6. Our fine-tuned models on Lightning AI

The project's own planning model and its code model (trained on verified code - see `docs/RESULTS-CODE-M1.md`) need a GPU. Lightning AI's
free tier includes a T4 GPU and monthly credits, and no card is needed for the T4.

1. Create a Studio at [lightning.ai](https://lightning.ai) and upload `pdsf/local_inference_server.py`, the plan adapter (as `plan.zip`) and
   the code adapter (as `adapter.zip`). Unzip them into `plan/` and `adapter/`.
2. Install: `pip install peft bitsandbytes accelerate "transformers<5"`
3. Switch the Studio to a **T4** GPU and start both models:

   ```bash
   python local_inference_server.py --host 0.0.0.0 --port 8712 \
     --model "local=unsloth/qwen2.5-7b-instruct-unsloth-bnb-4bit:plan" \
     --model "local-code=unsloth/qwen2.5-coder-7b-instruct-bnb-4bit:adapter"
   ```

4. Expose port 8712 (the Studio's **Port viewer**) and paste the address into the **Model** field (and **Code**, if it is separate).
5. Pickers: **Local model** and **Local code model**. The Studio sleeps after 10 idle minutes; start the command again after that.

The address works without a password, so do not share it.

## 7. Google Colab

The same models, on Colab's free GPU - see `docs/HELPER-README.md`. Each session gives a new address; paste it into the Model field.

## Which to choose?

- **Just starting:** Gemini for the plan, Groq for the code.
- **No internet, or private work:** Ollama.
- **Your own models (and the research numbers):** Lightning AI.
- **A free limit ran out:** switch the picker to another option and carry on - a run that stopped halfway continues where it left off.
