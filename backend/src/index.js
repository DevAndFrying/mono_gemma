import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ 
  server,
  perMessageDeflate: false,
  verifyClient: (info, cb) => {
    console.log('🔗 WebSocket connection request from:', info.origin || 'unknown origin');
    cb(true); // Accept all connections
  }
});

// Configuration
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const MODEL_NAME = process.env.MODEL_NAME || 'gemma4:e4b';
const API_PORT = process.env.API_PORT || 3000;
const MCP_PORT = process.env.MCP_PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Store active WebSocket connections
const clients = new Set();

// WebSocket server
wss.on('connection', (ws, req) => {
  console.log('✅ WebSocket client connected');
  console.log('   Client address:', req.socket.remoteAddress);
  console.log('   Total clients:', wss.clients.size);
  clients.add(ws);

  ws.on('message', async (message) => {
    try {
      console.log('📨 WebSocket message received, length:', message.length);
      const data = JSON.parse(message);
      const { type, payload } = data;
      console.log('   Type:', type);

      if (type === 'message') {
        const { text } = payload;
        console.log('👤 User message:', text);

        try {
          // Stream response from Ollama with timeout
          console.log('🔵 Sending request to Ollama...');
          console.log('   Model:', MODEL_NAME);
          console.log('   Prompt:', text.substring(0, 50));
          
          const response = await axios.post(
            `${OLLAMA_BASE_URL}/api/generate`,
            {
              model: MODEL_NAME,
              prompt: text,
              stream: true,
              temperature: 0.7,
              top_p: 0.9,
            },
            { 
              responseType: 'stream',
              timeout: 300000 // 5 minute timeout
            }
          );

          console.log('🟢 Response received from Ollama, status:', response.status);
          let thinkingContext = '';
          let chunkCount = 0;
          let isStreamComplete = false;
          
          response.data.on('data', (chunk) => {
            if (isStreamComplete) return;
            
            chunkCount++;
            console.log(`📦 Chunk ${chunkCount} received: ${chunk.length} bytes`);
            const lines = chunk.toString().split('\n').filter(l => l.trim());
            console.log(`   Contains ${lines.length} lines`);
            
            lines.forEach((line, idx) => {
              try {
                const json = JSON.parse(line);
                console.log(`   Line ${idx}: done=${json.done}, hasResponse=${!!json.response}, hasThinking=${!!json.thinking}`);
                
                // Capture thinking context if present
                if (json.thinking) {
                  thinkingContext += json.thinking;
                  const thinkingMsg = JSON.stringify({
                    type: 'thinking',
                    payload: { text: json.thinking },
                  });
                  console.log('   → Sending thinking:', json.thinking.substring(0, 30));
                  ws.send(thinkingMsg);
                }
                
                // Capture response text - Ollama sends fresh text each chunk
                if (json.response) {
                  const streamMsg = JSON.stringify({
                    type: 'stream',
                    payload: { text: json.response },
                  });
                  console.log('   → Sending stream:', json.response.substring(0, 30));
                  ws.send(streamMsg);
                }
                
                // Check if stream is done
                if (json.done) {
                  isStreamComplete = true;
                  console.log('🟡 Stream marked as done');
                }
              } catch (e) {
                console.error('   ❌ Error parsing JSON line:', e.message, 'Line:', line.substring(0, 50));
              }
            });
          });

          response.data.on('end', () => {
            console.log('🔴 Stream ended after', chunkCount, 'chunks');
            const completeMsg = JSON.stringify({
              type: 'complete',
              payload: { text: '', thinking: thinkingContext },
            });
            console.log('   → Sending complete message');
            ws.send(completeMsg);
          });

          response.data.on('error', (error) => {
            console.error('❌ Stream error:', error.message);
            ws.send(JSON.stringify({
              type: 'error',
              payload: { error: `Stream error: ${error.message}` },
            }));
          });
        } catch (streamError) {
          console.error('❌ Ollama request error:', streamError.message);
          console.error('   Stack:', streamError.stack);
          ws.send(JSON.stringify({
            type: 'error',
            payload: { error: `Connection error: ${streamError.message}` },
          }));
        }
      }
    } catch (error) {
      console.error('Error:', error.message);
      ws.send(JSON.stringify({
        type: 'error',
        payload: { error: error.message },
      }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// REST API endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', model: MODEL_NAME });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    
    const response = await axios.post(`${OLLAMA_BASE_URL}/api/generate`, {
      model: MODEL_NAME,
      prompt: message,
      stream: false,
      temperature: 0.7,
      top_p: 0.9,
    });

    res.json({ response: response.data.response });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/models', async (req, res) => {
  try {
    const response = await axios.get(`${OLLAMA_BASE_URL}/api/tags`);
    res.json(response.data);
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pull-model', async (req, res) => {
  try {
    const { model } = req.body;
    
    const response = await axios.post(
      `${OLLAMA_BASE_URL}/api/pull`,
      { name: model },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Type', 'application/json');
    response.data.pipe(res);
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Serve static files from frontend
app.use(express.static('../frontend/dist'));

// MCP Protocol implementation (basic)
app.post('/mcp/request', async (req, res) => {
  try {
    const { method, params } = req.body;

    if (method === 'resources/list') {
      res.json({
        resources: [
          {
            uri: 'gemma://model',
            name: 'Gemma Model',
            description: 'Ollama Gemma model interface',
            mimeType: 'application/json',
          },
        ],
      });
    } else if (method === 'tools/list') {
      res.json({
        tools: [
          {
            name: 'query_model',
            description: 'Query the Gemma model with a prompt',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'The prompt to send to the model' },
                temperature: { type: 'number', description: 'Model temperature (0-1)' },
              },
              required: ['prompt'],
            },
          },
        ],
      });
    } else if (method === 'tools/call') {
      const { name, arguments: args } = params;
      if (name === 'query_model') {
        const response = await axios.post(`${OLLAMA_BASE_URL}/api/generate`, {
          model: MODEL_NAME,
          prompt: args.prompt,
          stream: false,
          temperature: args.temperature || 0.7,
        });

        res.json({ result: response.data.response });
      }
    } else {
      res.status(400).json({ error: 'Unknown method' });
    }
  } catch (error) {
    console.error('MCP Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
server.listen(API_PORT, () => {
  console.log(`🚀 Backend server running on http://localhost:${API_PORT}`);
  console.log(`📡 WebSocket server on ws://localhost:${API_PORT}`);
  console.log(`🤖 Connected to Ollama at ${OLLAMA_BASE_URL}`);
  console.log(`📦 Using model: ${MODEL_NAME}`);
});
