# Vibe-Code Blueprint

**Describe an app. Review the plan. Get a full-stack project that is checked, explained and ready to hand in - using AI that costs nothing.**

Most AI app builders write code and hope. This one plans first, lets you change the plan in plain words, generates a React + Express + SQLite
project, and then *verifies* it: the project must build, and every import must obey the architecture its own plan set out (the frontend never
reaches into the database, security middleware is never bypassed). What cannot be verified is reported, never hidden.

It runs on your own machine, and works with free AI: Google's Gemini free tier, Groq, OpenRouter's free models, GitHub Models, Ollama on
your laptop (offline), or our own fine-tuned 7B models on a free cloud GPU.

## What makes it different

| | |
|---|---|
| **Plan first, in your words** | See the pages, APIs, data and security it intends to build. Say "add a sponsors page" and the plan is redone - before any code exists. |
| **Verified, not just generated** | Every run is built and checked against its own architecture rules, with the file and line of anything that breaks one. |
| **A project you can present** | Every download includes a project report in the usual college format, diagrams, an API guide with commands, viva questions and free-hosting steps - all written from your project's real code. |
| **Free all the way down** | Seven ways to run it without paying - see [docs/FREE-SETUP.md](docs/FREE-SETUP.md). |
| **Your own trained models** | A 7B code model trained only on verified code: first-attempt success rose from 41% to 87% on backend and security components ([results](docs/RESULTS-CODE-M1.md)). |
| **Visual page builder** | 116 elements, themes, backgrounds, motion and templates. A page's form becomes its real API and database table with one click. |
| **Keep going from anywhere** | Continue a run that stopped halfway, or import a project you started by hand - from a folder or Git - and keep building. |
| **Local-first** | Your code stays on your machine. Nothing is sent anywhere except the one AI service you choose. |

## Quick start

You need [Node.js](https://nodejs.org) 22.5 or newer and Git.

```bash
git clone https://github.com/Vikram5002/blueprint-s-_to_vibecoders.git
cd blueprint-s-_to_vibecoders
npm install
npm --prefix ui install      # the UI has its own packages - both installs are needed
npm run build
```

Add one free AI key to a file called `.env` in this folder, for example a [Groq key](https://console.groq.com) (no card needed):

```bash
GROQ_API_KEY=your-key-here
VIBE_LLM_PROVIDER=groq
```

Then start it:

```bash
node dist/cli.js .
```

Open the link it prints and add `/workspace.html`. In **Agent mode**, pick a starter idea or describe your own app, review the plan, and
click **Build this plan**. Switch AI at any time from the **Model** and **Code** pickers at the top.

## What it can do

- **Agent mode** - one request runs plan -> (your review) -> generate -> build -> fix -> pages, with a live timeline and Stop.
- **Workflow graph** - the plan as a diagram; change it with a prompt, then Generate application; fix build errors, continue, add or
  remove components.
- **Page builder** - drag-and-drop pages with layout, form, content, media and motion elements; sync a page to its backend and database.
- **Architecture measurement** - point it at any TypeScript, JavaScript, Python or PHP repository to see its real dependency graph, and
  check it against the rules its authors stated (`AGENTS.md`, `CLAUDE.md`) or rules you write.
- **For coding agents** - `node dist/cli.js . --mcp` serves `check_import` ("am I allowed to import this?") to an AI agent before it
  writes the line.

## Documentation

- [docs/FREE-SETUP.md](docs/FREE-SETUP.md) - every free way to run it, step by step
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - how the tool itself is built
- [docs/GENERATION.md](docs/GENERATION.md) - how a project is generated and verified
- [docs/PROVIDERS.md](docs/PROVIDERS.md) - the AI providers and how they were measured
- [docs/HELPER-README.md](docs/HELPER-README.md) - setting up the local models
- [docs/FINDINGS.md](docs/FINDINGS.md) - the research findings behind it

## Development

```bash
npm test          # unit tests (vitest)
npm run lint      # eslint + type-check
npm run dev       # watch mode
```

UI tests run from `ui/`: `npm test` and `npm run test:e2e`.
