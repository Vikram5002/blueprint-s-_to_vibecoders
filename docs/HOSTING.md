# Hosting VibeCoder for invited users

VibeCoder is local-first: `npx vibe-blueprint` on a person's own computer is still the normal way
to use it. **Hosted mode** (`--hosted`, approved 2026-10-04, see CLAUDE.md) is the one exception: one
server that a group of invited people (a class, a team, reviewers) open in their browser.

## What hosted mode does

| Protection | How |
|---|---|
| Invite only | Every API request needs the access code (`VIBE_ACCESS_CODE`). The UI asks for it once and keeps it in the browser. |
| Same site only | A request sent by another website is refused. |
| Private projects | Each browser has a random id; it sees only the projects and runs it made. |
| No access to the server itself | Switching the analysed folder, importing a folder, reworking a file, changing the server's model, and editing corrections/blueprints are refused. |
| Cost limits | Runs on the server's own model: `VIBE_DAILY_RUNS` per visitor per day (default 5) and `VIBE_MONTHLY_RUNS` in total (default 300). |
| Own keys | A visitor can paste their own free key (Groq, Gemini, OpenRouter, GitHub Models, Anthropic) in the model menu. It stays in their browser, is sent with their own requests only, is never stored, and is not limited. |

### The risk to understand first

Generating an application **installs, builds and briefly runs the generated code on the server**
(that is how VibeCoder verifies it). The code is written by a model from a visitor's prompt, so a
visitor who tries hard could make it do something unwanted on the server. Therefore:

- invite only people you trust, and do not publish the access code;
- use a **dedicated** machine (the free VM below) with nothing else on it;
- put only **limited, free-tier** model keys on it, never a key with billing attached;
- point it at an **empty folder** (its Analysis view shows the files of the folder it serves).

This is fine for a class or a team. It is not a public service for strangers.

### Patent note

Anything served publicly is a public disclosure. Check with the NMIMS IP cell before sharing the
address beyond the team (see `presentations/reports/VibeCoder-Patent-Filing-Guide-*.pdf`).

## Settings

| Variable | Required | Meaning |
|---|---|---|
| `VIBE_ACCESS_CODE` | yes | At least 8 characters. Share it only with invited people. |
| `VIBE_DAILY_RUNS` | no (5) | Runs per visitor per day on the server's own model. `0` = visitors must bring their own key. |
| `VIBE_MONTHLY_RUNS` | no (300) | Runs per calendar month on the server's own model, for everyone together. |
| `VIBE_TRUST_PROXY` | behind Caddy/nginx | `1` = read the visitor's address from `X-Forwarded-For` (needed for per-visitor limits). |
| `VIBE_LLM_PROVIDER` + a key | no | The server's own model, e.g. `groq` and `GROQ_API_KEY`. Leave out to run on visitors' keys only. |

Counters live in memory: a restart resets them.

## Option A - Oracle Cloud Always Free VM (recommended)

Free for good: an Ampere A1 VM with up to 4 cores and 24 GB RAM. Signing up needs a card for
verification; it is not charged on the Always Free tier.

### 1. Create the VM

1. cloud.oracle.com -> **Compute -> Instances -> Create instance**.
2. Image: **Ubuntu 24.04**. Shape: **Ampere - VM.Standard.A1.Flex**, 2 OCPU, 12 GB (or 4 / 24).
   If it says "out of capacity", try again later or another availability domain.
3. Add your SSH public key, create, and note the **public IP address**.
4. **Networking -> the VM's subnet -> Security list -> Add ingress rules**: TCP **80** and **443**
   from `0.0.0.0/0`.

### 2. Install

```bash
ssh ubuntu@<public-ip>

# Ubuntu images on Oracle block ports in iptables as well - open 80 and 443:
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save

# Node 20, git, build tools (better-sqlite3 may compile on ARM)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git build-essential

# The app (a private repository needs a deploy key or token)
sudo mkdir -p /srv/vibecoder && sudo chown ubuntu /srv/vibecoder
git clone https://github.com/Vikram5002/blueprint-s-_to_vibecoders.git /srv/vibecoder/app
cd /srv/vibecoder/app
npm ci && npm --prefix ui ci && npm run build

# The empty folder the hosted server serves
mkdir -p /srv/vibecoder/projects
```

### 3. Settings and service

```bash
sudo tee /etc/vibecoder.env >/dev/null <<'EOF'
VIBE_ACCESS_CODE=choose-a-long-code-here
VIBE_DAILY_RUNS=5
VIBE_MONTHLY_RUNS=300
VIBE_TRUST_PROXY=1
# Optional: the shared model. Free-tier keys only.
VIBE_LLM_PROVIDER=groq
GROQ_API_KEY=
EOF
sudo chmod 600 /etc/vibecoder.env

sudo tee /etc/systemd/system/vibecoder.service >/dev/null <<'EOF'
[Unit]
Description=VibeCoder (hosted)
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/srv/vibecoder/projects
EnvironmentFile=/etc/vibecoder.env
ExecStart=/usr/bin/node /srv/vibecoder/app/dist/cli.js /srv/vibecoder/projects --hosted --port=4317
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now vibecoder
sudo systemctl status vibecoder   # "Blueprint ready at http://127.0.0.1:4317"
```

The server listens on 127.0.0.1 only; Caddy (next) is the only thing facing the internet.

### 4. HTTPS with Caddy

An installable app and the browser's install button need HTTPS. Caddy gets a free certificate
automatically. You need a name for the VM: your own domain, a free DuckDNS name, or simply
`<ip-with-dashes>.sslip.io` (for IP 140.238.1.2: `140-238-1-2.sslip.io`).

```bash
sudo apt-get install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
140-238-1-2.sslip.io {
    reverse_proxy 127.0.0.1:4317
}
EOF
sudo systemctl reload caddy
```

Open `https://140-238-1-2.sslip.io/workspace.html`, enter the access code, done.

### 5. Updating

```bash
cd /srv/vibecoder/app && git pull && npm ci && npm --prefix ui ci && npm run build
sudo systemctl restart vibecoder
```

## Option B - Docker (Hugging Face Spaces, any container host)

The `Dockerfile` in the repository root runs hosted mode on port 7860:

```bash
docker build -t vibecoder .
docker run -p 7860:7860 -e VIBE_ACCESS_CODE=choose-a-long-code -e VIBE_TRUST_PROXY=1 vibecoder
```

On Hugging Face: create a **private** Space of type Docker, push the repository to it, and set
`VIBE_ACCESS_CODE` (and any model key) under **Settings -> Variables and secrets**. A free Space
sleeps when idle and loses its files on restart - fine for a demo, not for keeping projects.

## Checking it

- `https://<name>/api/hosted` answers `{"hosted":true,"accessOk":false,...}` without the code.
- Any other `/api/...` without the code answers 401.
- After entering the code, the model menu shows "These are this server's models" and the
  "Use your own API key" section.
