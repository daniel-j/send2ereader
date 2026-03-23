# CLAUDE.md — send2ereader Dockerfile & Fly.io Setup

This file instructs Claude Code on all changes needed to make send2ereader
self-contained and deployable to Fly.io with all binary dependencies baked in.

-----

## Goal

Modify the repo so the Docker image bundles all three required binaries
(kepubify, kindlegen, pdfcropmargins) without relying on external runtime
installs or unstable URLs. Then add Fly.io config so the app deploys cleanly.

-----

## Step 1 — Download the kindlegen binary and commit it

kindlegen is abandoned by Amazon and has no stable official download source.
The safest approach is to commit the Linux binary directly to the repo.

1. Create a `bin/` directory in the repo root.
1. Download the kindlegen Linux binary from archive.org:
   https://archive.org/download/kindlegen_linux_2_6/kindlegen_linux_2.6_i386_v2_9.tar.gz
1. Extract the `kindlegen` binary from the tarball.
1. Place it at `bin/kindlegen` in the repo.
1. Make it executable: `chmod +x bin/kindlegen`
1. Ensure `bin/kindlegen` is NOT in .gitignore — it must be committed.
1. Commit the binary to the repo with message: `chore: add kindlegen binary to bin/`

> Note: kindlegen is a 32-bit (i386) ELF binary. This is intentional and
> correct — it runs fine on 64-bit Linux with the right compatibility libs
> installed (handled in the Dockerfile below).

-----

## Step 2 — Replace the Dockerfile

Replace the entire contents of `Dockerfile` with the following:

```dockerfile
FROM node:20-slim

# Install system dependencies:
# - curl: for downloading kepubify
# - python3, python3-pip: for pdfCropMargins
# - lib32z1, lib32gcc-s1, lib32stdc++6: for running 32-bit kindlegen binary
# - ghostscript, pdftoppm (poppler-utils): required by pdfCropMargins
RUN apt-get update && apt-get install -y \
    curl \
    python3 \
    python3-pip \
    lib32z1 \
    lib32gcc-s1 \
    lib32stdc++6 \
    ghostscript \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Install kepubify — pinned to v4.0.4 (latest stable as of 2022-03-09)
# To upgrade: change the version tag and update this comment
RUN curl -fsSL \
    https://github.com/pgaskin/kepubify/releases/download/v4.0.4/kepubify-linux-64bit \
    -o /usr/local/bin/kepubify \
    && chmod +x /usr/local/bin/kepubify

# Install pdfCropMargins via pip
RUN pip3 install pdfCropMargins --break-system-packages

# Copy the pre-committed kindlegen binary (32-bit, abandonware — no stable
# upstream URL, so it lives in bin/ in this repo)
COPY bin/kindlegen /usr/local/bin/kindlegen
RUN chmod +x /usr/local/bin/kindlegen

# Install Node dependencies
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install

# Copy application source
COPY . .

EXPOSE 3001
CMD ["node", "index"]
```

-----

## Step 3 — Update docker-compose.yaml

Replace the contents of `docker-compose.yaml` with the following to ensure
the port mapping and restart policy are production-appropriate:

```yaml
version: "3"
services:
  send2ereader:
    build:
      context: .
      dockerfile: ./Dockerfile
    container_name: send2ereader
    ports:
      - "3001:3001"
    restart: unless-stopped
```

-----

## Step 4 — Add fly.toml for Fly.io deployment

Create a new file `fly.toml` in the repo root with the following contents.
Replace `your-app-name` with the actual Fly app name (use something like
`send2ereader` or your preferred subdomain):

```toml
app = "your-app-name"
primary_region = "ord"

[build]

[http_service]
  internal_port = 3001
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
```

> Notes on fly.toml:
> 
> - `primary_region = "ord"` is Chicago. Change to your preferred region
>   (e.g. `yyz` for Toronto, `lax` for LA, `iad` for Virginia).
>   Full list: https://fly.io/docs/reference/regions/
> - `auto_stop_machines = true` means the VM sleeps when idle (free tier
>   behaviour). Set to `false` if you want always-on (uses more free allowance).
> - `memory = "512mb"` is recommended — pdfcropmargins and kindlegen can be
>   memory-hungry. 256mb may cause OOM kills on large files.

-----

## Step 5 — Update .gitignore

Open `.gitignore` and ensure the following line is NOT present (or is negated):

```
bin/
```

If `bin/` or `bin/*` appears in `.gitignore`, add this line below it to
un-ignore the kindlegen binary specifically:

```
!bin/kindlegen
```

-----

## Step 6 — Verify the build locally

Run the following to confirm the image builds and all binaries are accessible:

```bash
docker build -t send2ereader-test .

# Verify each binary is present and executable
docker run --rm send2ereader-test kepubify --version
docker run --rm send2ereader-test kindlegen
docker run --rm send2ereader-test pdfcropmargins --version

# Run the full service locally
docker run --rm -p 3001:3001 send2ereader-test
# Then open http://localhost:3001 to confirm it loads
```

If kindlegen exits with “not found” or an ELF error, it means the 32-bit
compatibility libraries didn’t install correctly. Double-check that `lib32z1`,
`lib32gcc-s1`, and `lib32stdc++6` are all in the apt-get install list.

-----

## Step 7 — Commit all changes

Once the local build passes, commit everything:

```bash
git add Dockerfile docker-compose.yaml fly.toml .gitignore bin/kindlegen
git commit -m "chore: bake all binary dependencies into Docker image, add Fly.io config"
git push
```

-----

## Step 8 — Deploy to Fly.io

If you haven’t already, install the Fly CLI and log in:

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

Then from the repo root:

```bash
fly launch --no-deploy   # reads fly.toml, creates the app on Fly
fly deploy               # builds and deploys
```

Once deployed, the app will be live at `https://your-app-name.fly.dev`.

-----

## Dependency version reference

|Binary        |Version|Source                              |Strategy                   |
|--------------|-------|------------------------------------|---------------------------|
|kepubify      |v4.0.4 |github.com/pgaskin/kepubify releases|curl in Dockerfile (pinned)|
|kindlegen     |2.9    |archive.org (abandoned by Amazon)   |committed to bin/          |
|pdfCropMargins|latest |PyPI                                |pip in Dockerfile          |

To upgrade kepubify in future: update the version tag in the Dockerfile RUN
command and update the version in this table.

pdfCropMargins is unpinned (installs latest from PyPI). If you want to pin it,
change the pip install line to e.g. `pdfCropMargins==2.1.3`.