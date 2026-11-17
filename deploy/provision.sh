#!/bin/bash
# One-time setup of the authoring-ops-mcp LXC. Runs as root (tools/deploy.mjs --provision).
# Idempotent: rerunning it changes nothing that is already in place.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
# No native modules here, so no build tools.
apt-get install -y -q curl

id ops >/dev/null 2>&1 || useradd --system --home-dir /var/lib/authoring-ops-mcp --shell /usr/sbin/nologin ops
install -d -o ops -g ops -m 0750 /var/lib/authoring-ops-mcp
install -d -m 0755 /opt/authoring-ops-mcp /opt/authoring-ops-mcp/releases /etc/authoring-ops-mcp
if [ ! -f /etc/authoring-ops-mcp/env ]; then
  install -m 0640 -g ops /dev/null /etc/authoring-ops-mcp/env
  cat > /etc/authoring-ops-mcp/env <<'ENV'
OPS_SUITE=/opt/authoring-ops-mcp/current/suites/authoring.json
OPS_SKILLS=/opt/authoring-ops-mcp/current/skills
OPS_STATE=/var/lib/authoring-ops-mcp/state.json
OPS_HOST=0.0.0.0
OPS_PORT=8000
OPS_POLL_SECONDS=60
ENV
fi

echo "node=$(node --version)"
echo "provisioned=$(hostname)"
