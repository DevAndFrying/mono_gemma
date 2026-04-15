#!/bin/bash

# MCP Gemma Monolith - Docker Startup

set -e

echo "🐳 MCP Gemma Monolith - Docker Mode"
echo "==================================="
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found. Please install from https://docs.docker.com/get-docker/"
    exit 1
fi
echo "✓ Docker found: $(docker --version)"

# Check Docker Compose
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose not found. Please install from https://docs.docker.com/compose/install/"
    exit 1
fi
echo "✓ Docker Compose found: $(docker-compose --version)"

# Check for GPU support (optional)
if command -v docker run &> /dev/null; then
    if docker run --rm --gpus all nvidia/cuda:12.0-runtime nvidia-smi > /dev/null 2>&1; then
        echo "✓ NVIDIA GPU detected"
    else
        echo "⚠️  NVIDIA GPU not detected. Must run on CPU (slower)"
    fi
fi

echo ""
echo "🚀 Starting Docker containers..."
echo ""

# Build and run
docker-compose up --build

echo ""
echo "✅ Application started!"
echo ""
echo "📍 Access the application:"
echo "   Frontend: http://localhost:3000"
echo "   Backend API: http://localhost:3000/api"
echo ""
echo "Press Ctrl+C to stop"
