#!/usr/bin/env bash

set -euo pipefail

echo "Installing Docker and NVIDIA Container Toolkit for AWS G6e Ubuntu hosts..."

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  sudo systemctl --now enable docker
  sudo usermod -aG docker "$USER" || true
fi

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

echo "Validating host GPU..."
nvidia-smi

echo "Validating Docker GPU access..."
sudo docker run --rm --gpus all nvidia/cuda:12.0.0-runtime-ubuntu22.04 nvidia-smi

echo "Done. Start the app with:"
echo "  newgrp docker  # only needed if Docker was just installed and docker requires sudo"
echo "  MCP_ACCELERATOR=gpu MCP_OLLAMA_MODE=container ./docker-start.sh"
