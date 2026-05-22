#!/usr/bin/env bash

set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-20}"

echo "Setting up Docker, Docker Compose, Node.js/npm, and NVIDIA driver for EC2 G6e..."

sudo apt-get update
sudo apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  git \
  linux-headers-"$(uname -r)" \
  nvidia-driver-550-server

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if [ -f package-lock.json ]; then
  npm ci
fi

if [ -f frontend/package-lock.json ] && [ ! -x frontend/node_modules/.bin/vite ]; then
  npm --prefix frontend ci
fi

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

sudo apt-get install -y docker-compose-plugin
sudo systemctl --now enable docker
sudo usermod -aG docker "$USER" || true

sudo rm -f /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null

sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

echo
echo "Install complete."
echo "If this is a fresh driver install, reboot before starting the app:"
echo "  sudo reboot"
echo
echo "After reboot, validate and start:"
echo "  nvidia-smi"
echo "  docker run --rm --gpus all nvidia/cuda:12.0.0-runtime-ubuntu22.04 nvidia-smi"
echo "  newgrp docker"
echo "  MCP_ACCELERATOR=gpu MCP_OLLAMA_MODE=container ./docker-start.sh"
